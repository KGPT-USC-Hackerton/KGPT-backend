const { validate: isUuid } = require('uuid');
const { agentError } = require('../shared/agentResponse');
const { isValidIdempotencyKey, hashIdempotencyKey } = require('../shared/shopifyRequestHash');
const { loadShopifyConfig } = require('../config/shopifyConfig');
const { createShopifyStorefrontAdapter } = require('../adapters/shopifyStorefrontAdapter');
const shopifyCartService = require('../services/shopifyCartService');

// POST /api/agent/sessions/:sessionId/shopify-cart
//
// Idempotency-Key 원문은 해시한 뒤 즉시 버린다(DB/로그에 남기지 않는다).
// Private Token은 Adapter 안에서만 쓰이며 이 파일을 거쳐 나가지 않는다.

const ALLOWED_BODY_KEYS = ['confirmed', 'proposal_hash', 'items'];
const ALLOWED_ITEM_KEYS = ['product_key', 'quantity'];
const PROPOSAL_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBody(body) {
  if (!isPlainObject(body)) {
    return { error: { code: 'VALIDATION_ERROR', message: '요청 본문은 object여야 합니다.', status: 400 } };
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.includes(key)) {
      return { error: { code: 'UNKNOWN_FIELD', message: `허용되지 않은 필드입니다: ${key}`, status: 400 } };
    }
  }

  if (body.confirmed !== true) {
    return {
      error: {
        code: 'SHOPIFY_CART_CONFIRMATION_REQUIRED',
        message: '장바구니 생성에는 명시적 승인(confirmed: true)이 필요합니다.',
        status: 400,
      },
    };
  }

  if (typeof body.proposal_hash !== 'string' || !PROPOSAL_HASH_PATTERN.test(body.proposal_hash)) {
    return { error: { code: 'VALIDATION_ERROR', message: 'proposal_hash 형식이 올바르지 않습니다.', status: 400 } };
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: { code: 'VALIDATION_ERROR', message: 'items는 최소 1개 이상이어야 합니다.', status: 400 } };
  }

  for (const item of body.items) {
    if (!isPlainObject(item)) {
      return { error: { code: 'VALIDATION_ERROR', message: 'items의 각 항목은 object여야 합니다.', status: 400 } };
    }
    for (const key of Object.keys(item)) {
      if (!ALLOWED_ITEM_KEYS.includes(key)) {
        return { error: { code: 'UNKNOWN_FIELD', message: `items에 허용되지 않은 필드입니다: ${key}`, status: 400 } };
      }
    }
    if (typeof item.product_key !== 'string' || item.product_key.length === 0) {
      return { error: { code: 'VALIDATION_ERROR', message: 'product_key는 필수 문자열입니다.', status: 400 } };
    }
    if (!Number.isInteger(item.quantity)) {
      return { error: { code: 'VALIDATION_ERROR', message: 'quantity는 정수여야 합니다.', status: 400 } };
    }
  }

  return { value: { proposalHash: body.proposal_hash, items: body.items } };
}

async function createShopifyCart(req, res, deps = {}) {
  const configLoader = deps.loadShopifyConfig || loadShopifyConfig;
  const adapterFactory = deps.createAdapter || createShopifyStorefrontAdapter;
  const service = deps.service || shopifyCartService;

  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId)) {
      return agentError(res, 400, 'VALIDATION_ERROR', 'sessionId는 유효한 UUID 형식이어야 합니다.');
    }

    const validated = validateBody(req.body);
    if (validated.error) {
      return agentError(res, validated.error.status, validated.error.code, validated.error.message);
    }

    const rawIdempotencyKey = req.headers['idempotency-key'];
    if (rawIdempotencyKey === undefined || rawIdempotencyKey === null || rawIdempotencyKey === '') {
      return agentError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 헤더는 필수입니다.');
    }
    if (!isValidIdempotencyKey(rawIdempotencyKey)) {
      return agentError(res, 400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 형식이 올바르지 않습니다.');
    }
    // 원문은 여기서 해시로 바꾼 뒤 더 이상 전달하지 않는다.
    const idempotencyKeyHash = hashIdempotencyKey(rawIdempotencyKey);

    let config;
    try {
      config = configLoader(process.env);
    } catch (error) {
      return agentError(res, 503, 'SHOPIFY_NOT_CONFIGURED', 'Shopify 설정이 올바르지 않습니다.');
    }

    // SHOPIFY_ENABLED=false면 Adapter를 만들지도, Shopify를 호출하지도 않는다.
    if (!config.enabled) {
      return agentError(res, 503, 'SHOPIFY_NOT_CONFIGURED', 'Shopify Cart 기능이 활성화되지 않았습니다.');
    }

    const adapter = adapterFactory({ config });

    const result = await service.createShopifyCart(
      {
        sessionId,
        userId: req.agentUser.id,
        proposalHash: validated.value.proposalHash,
        items: validated.value.items,
        idempotencyKeyHash,
      },
      { config, adapter, ...(deps.serviceDeps || {}) }
    );

    if (result.error) {
      return agentError(res, result.httpStatus, result.error.code, '장바구니 처리 결과를 확인해 주세요.', {
        cart_request_id: result.error.cart_request_id,
      });
    }

    return res.status(result.httpStatus).json({ success: true, data: result.body });
  } catch (error) {
    if (error && error.name === 'ShopifyCartError') {
      return agentError(res, error.httpStatus || 500, error.code, error.message);
    }
    console.error('Agent createShopifyCart Error:', error.message);
    return agentError(res, 500, 'SHOPIFY_CART_INTERNAL_ERROR', '장바구니 생성 중 오류가 발생했습니다.');
  }
}

module.exports = { createShopifyCart, validateBody };
