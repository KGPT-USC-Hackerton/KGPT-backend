const crypto = require('crypto');

const defaultAgentRepository = require('../repositories/agentRepository');
const defaultCartRepository = require('../repositories/shopifyCartRepository');
const { computeContextHash } = require('./contextSnapshotService');
const { recommendProducts, RULESET_VERSION } = require('./productRecommendationService');
const { CATALOG_VERSION, PRODUCTS } = require('../catalog/hygieneProductCatalog');
const { isVariantConfigured, getVariantGid, computeShopifyConfigFingerprint } = require('../catalog/shopifyVariantMapping');
const { computeRequestHash } = require('../shared/shopifyRequestHash');
const { buildSafeErrorDetails } = require('../shared/shopifySafeErrorDetails');
const { assertCartReady, ShopifyConfigError } = require('../config/shopifyConfig');
const { OUTCOME } = require('../adapters/shopifyStorefrontAdapter');

const MAX_CART_LINES = 10;
const PRICING_DISCLAIMER = 'Estimated cart pricing may change at Shopify checkout.';

class ShopifyCartError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'ShopifyCartError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Session 검증 (Dental Pass/Message 서비스와 동일한 항목 — 공통화 후보)
// ---------------------------------------------------------------------------
async function loadReadySessionForOwner(sessionRepository, sessionId, userId, now) {
  const session = await sessionRepository.findByIdAndUser(sessionId, userId);
  if (!session) throw new ShopifyCartError('AGENT_SESSION_NOT_FOUND', '해당 세션을 찾을 수 없습니다.', 404);
  if (session.status !== 'ready') throw new ShopifyCartError('AGENT_SESSION_NOT_READY', '세션이 ready 상태가 아닙니다.', 409);
  if (session.expires_at && new Date(session.expires_at).getTime() <= now().getTime()) {
    throw new ShopifyCartError('AGENT_SESSION_EXPIRED', '세션이 만료되었습니다.', 410);
  }
  if (!session.context_snapshot || !session.context_hash) {
    throw new ShopifyCartError('AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot이 존재하지 않습니다.', 500);
  }
  if (computeContextHash(session.context_snapshot) !== session.context_hash) {
    throw new ShopifyCartError('AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot 무결성 검증에 실패했습니다.', 500);
  }
  return session;
}

// ---------------------------------------------------------------------------
// 저장된 행 → 안전한 HTTP 결과 재현 (Shopify 재호출 0회)
// ---------------------------------------------------------------------------
function buildResultFromRow(row) {
  if (row.status === 'succeeded') {
    return {
      httpStatus: 200,
      body: {
        cart_request_id: row.id,
        status: 'succeeded',
        checkout_url: row.checkout_url,
        estimated_cart_total: {
          amount: row.estimated_total_amount,
          currency_code: row.estimated_total_currency_code,
          is_estimated: !!row.estimated_total_is_estimated,
        },
        pricing_disclaimer: PRICING_DISCLAIMER,
        warnings: parseJsonColumn(row.warning_codes_json) || [],
      },
    };
  }
  // failed / outcome_unknown 은 저장된 정규화 오류만으로 동일하게 재현한다.
  return {
    httpStatus: row.normalized_http_status || 502,
    error: {
      code: row.normalized_error_code || 'SHOPIFY_CART_OUTCOME_UNKNOWN',
      cart_request_id: row.id,
    },
  };
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 선택 items 검증 (전부 결정론적 — Idempotency claim 이전에 완료)
// ---------------------------------------------------------------------------
function validateSelectedItems({ items, recommendation, variantMapping }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ShopifyCartError('VALIDATION_ERROR', '최소 1개 상품을 선택해야 합니다.', 400);
  }
  if (items.length > MAX_CART_LINES) {
    throw new ShopifyCartError('VALIDATION_ERROR', `상품은 최대 ${MAX_CART_LINES}개까지 선택할 수 있습니다.`, 400);
  }

  const seenProductKeys = new Set();
  const recommendedByKey = new Map(recommendation.items.map((item) => [item.product_key, item]));

  for (const item of items) {
    if (seenProductKeys.has(item.product_key)) {
      throw new ShopifyCartError('VALIDATION_ERROR', '동일한 product_key가 중복되었습니다.', 400);
    }
    seenProductKeys.add(item.product_key);

    if (!recommendedByKey.has(item.product_key)) {
      throw new ShopifyCartError('PRODUCT_NOT_RECOMMENDED', '현재 추천 목록에 없는 상품입니다.', 400);
    }
    const product = PRODUCTS[item.product_key];
    if (!product) {
      throw new ShopifyCartError('PRODUCT_NOT_ALLOWLISTED', '허용되지 않은 상품입니다.', 400);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > product.max_quantity) {
      throw new ShopifyCartError('INVALID_PRODUCT_QUANTITY', '상품 수량이 허용 범위를 벗어났습니다.', 400);
    }
    if (!isVariantConfigured(item.product_key, variantMapping)) {
      throw new ShopifyCartError('PRODUCT_VARIANT_NOT_CONFIGURED', '선택한 상품의 Shopify 설정이 완료되지 않았습니다.', 503);
    }
  }

  // 서로 다른 product_key 가 같은 GID 를 가리키는 상황은 loadVariantMapping 이
  // 이미 fail-closed 로 걸러내지만, Cart line 구성 직전에 한 번 더 확인한다.
  const gids = items.map((item) => getVariantGid(item.product_key, variantMapping));
  if (new Set(gids).size !== gids.length) {
    throw new ShopifyCartError('PRODUCT_VARIANT_NOT_CONFIGURED', 'Shopify Variant 매핑이 올바르지 않습니다.', 503);
  }

  return items.map((item) => ({
    product_key: item.product_key,
    quantity: item.quantity,
    variant_gid: getVariantGid(item.product_key, variantMapping),
  }));
}

/**
 * 응답 line 이 요청과 정확히 일치하는지 순서 무관하게 비교한다.
 * (Shopify 가 요청 순서를 보존한다고 가정하지 않는다.)
 */
function cartLinesMatchRequest(responseLines, requestedLines) {
  if (!Array.isArray(responseLines) || responseLines.length !== requestedLines.length) return false;

  const toMultiset = (lines) => {
    const map = new Map();
    for (const line of lines) {
      const key = `${line.merchandiseId}#${line.quantity}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };

  const expected = toMultiset(requestedLines.map((l) => ({ merchandiseId: l.variant_gid, quantity: l.quantity })));
  const actual = toMultiset(responseLines);

  if (expected.size !== actual.size) return false;
  for (const [key, count] of expected) {
    if (actual.get(key) !== count) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------
async function createShopifyCart(
  { sessionId, userId, proposalHash, items, idempotencyKeyHash },
  deps = {}
) {
  const sessionRepository = deps.sessionRepository || defaultAgentRepository;
  const cartRepository = deps.cartRepository || defaultCartRepository;
  const now = deps.now || (() => new Date());
  const generateId = deps.generateId || (() => crypto.randomUUID());
  const config = deps.config;
  const adapter = deps.adapter;

  if (!config) throw new ShopifyCartError('SHOPIFY_NOT_CONFIGURED', 'Shopify 설정이 없습니다.', 503);

  // ---- ① Shopify 전역 활성 여부 (claim 이전, DB 행 생성 없음) ----
  try {
    assertCartReady(config);
  } catch (error) {
    if (error instanceof ShopifyConfigError) {
      throw new ShopifyCartError('SHOPIFY_NOT_CONFIGURED', 'Shopify Cart 기능이 활성화되지 않았습니다.', 503);
    }
    throw error;
  }

  // ---- ② Session 소유권/상태/무결성 ----
  const session = await loadReadySessionForOwner(sessionRepository, sessionId, userId, now);

  // ---- ③ 추천 재계산 + proposal_hash 일치 ----
  const recommendation = recommendProducts({
    sessionId,
    contextHash: session.context_hash,
    contextSnapshot: session.context_snapshot,
  });
  if (recommendation.proposal_hash !== proposalHash) {
    throw new ShopifyCartError('PRODUCT_PROPOSAL_STALE', '추천 내용이 변경되었습니다. 다시 확인해 주세요.', 409);
  }

  // ---- ④ 선택 items 검증 + Variant 매핑 ----
  const selectedLines = validateSelectedItems({ items, recommendation, variantMapping: config.variantMapping });

  // ---- ⑤ request_hash (Shopify 환경 설정까지 바인딩) ----
  const shopifyConfigFingerprint = computeShopifyConfigFingerprint({
    storeDomain: config.storeDomain,
    apiVersion: config.apiVersion,
    selectedVariants: selectedLines,
  });
  const requestHash = computeRequestHash({
    userId,
    sessionId,
    proposalHash,
    catalogVersion: CATALOG_VERSION,
    rulesetVersion: RULESET_VERSION,
    shopifyConfigFingerprint,
    items: selectedLines,
  });

  // ---- ⑥ Idempotency claim (짧은 단발 쿼리, Transaction/lock 유지 없음) ----
  const cartRequestId = generateId();
  try {
    await cartRepository.insertPendingClaim({
      id: cartRequestId,
      userId,
      sessionId,
      idempotencyKeyHash,
      requestHash,
      proposalHash,
      shopifyConfigFingerprint,
      selectedItems: selectedLines.map((l) => ({ product_key: l.product_key, quantity: l.quantity })),
      now: now(),
    });
  } catch (error) {
    if (error && error.code === 'SHOPIFY_CART_CLAIM_CONFLICT') {
      return handleExistingClaim({ existing: error.existingRow, requestHash, cartRepository, config, now });
    }
    throw error;
  }

  // ---- ⑦ dispatch claim → Shopify 호출 → 결과 반영 ----
  return dispatchAndFinalize({ cartRequestId, selectedLines, cartRepository, adapter, config, now });
}

/**
 * 이미 같은 Idempotency-Key 로 만들어진 행이 있을 때의 처리.
 * 어떤 경로에서도 Shopify 를 재호출하지 않는다.
 */
async function handleExistingClaim({ existing, requestHash, cartRepository, config, now }) {
  if (!existing) {
    throw new ShopifyCartError('SHOPIFY_CART_INTERNAL_ERROR', '요청 상태를 확인할 수 없습니다.', 500);
  }

  if (existing.request_hash !== requestHash) {
    throw new ShopifyCartError(
      'IDEMPOTENCY_KEY_CONFLICT',
      '동일한 Idempotency-Key가 다른 요청 내용으로 이미 사용되었습니다.',
      409
    );
  }

  if (existing.status !== 'pending') {
    return buildResultFromRow(existing);
  }

  // pending: lease 만료 여부에 따라 터미널 상태로 전이하거나 진행 중 응답.
  const currentTime = now();
  const cutoff = new Date(currentTime.getTime() - config.pendingLeaseMs);

  if (existing.external_call_started_at === null) {
    const affected = await cartRepository.expireStaleBeforeDispatch({
      id: existing.id,
      beforeDispatchCutoff: cutoff,
      now: currentTime,
    });
    if (affected === 1) {
      return buildResultFromRow(await cartRepository.findById(existing.id));
    }
  } else {
    const affected = await cartRepository.expireStaleAfterDispatch({
      id: existing.id,
      afterDispatchCutoff: cutoff,
      now: currentTime,
    });
    if (affected === 1) {
      return buildResultFromRow(await cartRepository.findById(existing.id));
    }
  }

  // lease 가 아직 살아있거나(진행 중) 다른 주체가 먼저 전이시킨 경우.
  const refreshed = await cartRepository.findById(existing.id);
  if (refreshed && refreshed.status !== 'pending') {
    return buildResultFromRow(refreshed);
  }
  throw new ShopifyCartError('SHOPIFY_CART_IN_PROGRESS', '동일한 요청이 처리 중입니다.', 409);
}

/**
 * dispatch claim 이 성공한 실행 경로에서만 Shopify 를 호출하고 결과를 반영한다.
 * 외부 호출 구간에는 Transaction/row lock 이 없다.
 */
async function dispatchAndFinalize({ cartRequestId, selectedLines, cartRepository, adapter, config, now }) {
  // 외부 호출 직전 조건부 UPDATE. 1이 아니면 다른 주체가 이미 상태를 바꾼 것이므로
  // Shopify 를 호출하지 않고 저장된 상태를 재현한다.
  const claimed = await cartRepository.markExternalCallStarted({ id: cartRequestId, now: now() });
  if (claimed !== 1) {
    const row = await cartRepository.findById(cartRequestId);
    if (row && row.status !== 'pending') return buildResultFromRow(row);
    throw new ShopifyCartError('SHOPIFY_CART_IN_PROGRESS', '동일한 요청이 처리 중입니다.', 409);
  }

  const lines = selectedLines.map((line) => ({ merchandiseId: line.variant_gid, quantity: line.quantity }));

  // cartCreate 는 정확히 1회. 어떤 오류에도 자동 재시도하지 않는다.
  const result = await adapter.createCart({ lines, timeoutMs: config.timeoutMs });

  if (result.outcome === OUTCOME.SUCCEEDED) {
    // 응답 line 이 요청과 일치하지 않으면 Cart 가 우리가 의도한 내용이 아니므로
    // 성공으로 처리하지 않는다(Cart 는 생성됐을 수 있어 outcome_unknown).
    if (!cartLinesMatchRequest(result.cart.lines, selectedLines)) {
      return finalizeTerminal({
        cartRequestId,
        cartRepository,
        now,
        status: 'outcome_unknown',
        errorCode: 'SHOPIFY_CART_OUTCOME_UNKNOWN',
        httpStatus: 502,
        safeErrorDetails: buildSafeErrorDetails({ category: 'RESPONSE_SHAPE' }),
      });
    }

    // Shopify 성공을 확인했지만 로컬 영속화가 실패할 수 있다. 이 경우 절대
    // succeeded 를 반환하지 않고 outcome_unknown 으로 처리한다(known failed 아님).
    let persisted = 0;
    try {
      persisted = await cartRepository.markSucceeded({
        id: cartRequestId,
        shopifyCartId: result.cart.id,
        checkoutUrl: result.cart.checkoutUrl,
        estimatedTotalAmount: result.cart.totalAmount,
        estimatedTotalCurrencyCode: result.cart.totalCurrencyCode,
        estimatedTotalIsEstimated: result.cart.totalAmountEstimated,
        warningCodes: result.warningCodes,
        now: now(),
      });
    } catch (error) {
      persisted = 0;
    }

    if (persisted === 1) {
      const row = await safeFindById(cartRepository, cartRequestId);
      if (row && row.status === 'succeeded') return buildResultFromRow(row);
      // 저장은 됐지만 재조회가 안 되는 경우에도 저장된 값 기준으로 응답을 만든다.
      return {
        httpStatus: 200,
        body: {
          cart_request_id: cartRequestId,
          status: 'succeeded',
          checkout_url: result.cart.checkoutUrl,
          estimated_cart_total: {
            amount: result.cart.totalAmount,
            currency_code: result.cart.totalCurrencyCode,
            is_estimated: result.cart.totalAmountEstimated,
          },
          pricing_disclaimer: PRICING_DISCLAIMER,
          warnings: result.warningCodes,
        },
      };
    }

    // 영속화 실패: checkoutUrl 을 반환하지 않고 outcome_unknown 으로 전이 시도.
    return finalizeTerminal({
      cartRequestId,
      cartRepository,
      now,
      status: 'outcome_unknown',
      errorCode: 'SHOPIFY_CART_OUTCOME_UNKNOWN',
      httpStatus: 502,
      safeErrorDetails: buildSafeErrorDetails({ category: 'UNKNOWN' }),
    });
  }

  const status = result.outcome === OUTCOME.FAILED ? 'failed' : 'outcome_unknown';
  const httpStatus = status === 'failed' ? mapFailedHttpStatus(result) : 502;

  return finalizeTerminal({
    cartRequestId,
    cartRepository,
    now,
    status,
    errorCode: result.errorCode || (status === 'failed' ? 'SHOPIFY_CART_CREATE_FAILED' : 'SHOPIFY_CART_OUTCOME_UNKNOWN'),
    httpStatus,
    safeErrorDetails: result.safeErrorDetails,
  });
}

function mapFailedHttpStatus(result) {
  if (result.errorCode === 'SHOPIFY_AUTH_FAILED') return 502; // 우리 쪽 설정 문제를 사용자에게 401로 전가하지 않는다
  if (result.errorCode === 'SHOPIFY_USER_ERROR') return 422;
  return 502;
}

async function finalizeTerminal({ cartRequestId, cartRepository, now, status, errorCode, httpStatus, safeErrorDetails }) {
  try {
    await cartRepository.markTerminalError({
      id: cartRequestId,
      status,
      normalizedErrorCode: errorCode,
      normalizedHttpStatus: httpStatus,
      safeErrorDetails,
      now: now(),
    });
  } catch (error) {
    // 전이마저 실패하면 행은 pending + external_call_started_at 상태로 남고
    // lease 만료 후 outcome_unknown 으로 정리된다. 사용자에게는 동일하게
    // outcome_unknown 을 알린다.
  }
  return { httpStatus, error: { code: errorCode, cart_request_id: cartRequestId } };
}

async function safeFindById(cartRepository, id) {
  try {
    return await cartRepository.findById(id);
  } catch (error) {
    return null;
  }
}

module.exports = {
  MAX_CART_LINES,
  PRICING_DISCLAIMER,
  ShopifyCartError,
  createShopifyCart,
  // 테스트 노출(순수 헬퍼)
  validateSelectedItems,
  cartLinesMatchRequest,
  buildResultFromRow,
  loadReadySessionForOwner,
};
