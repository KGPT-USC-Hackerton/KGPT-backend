// Shopify Storefront GraphQL 호출의 유일한 지점.
//
// 안전 원칙:
//   * 서버용 Private Token 은 Shopify-Storefront-Private-Token 헤더에만 쓴다.
//     X-Shopify-Storefront-Access-Token(Public Token 용)은 절대 사용하지 않는다.
//   * cartCreate 는 어떤 오류에도 자동 재시도하지 않는다(attempt 1회).
//     read-only query 만 제한적 retry 를 허용한다.
//   * Cart attributes / note / metafields / line attributes 를 전송하지 않는다.
//     Shopify 로 나가는 데이터는 merchandiseId 와 quantity 뿐이다.
//   * Token / store domain / Variant GID / checkoutUrl / 원문 응답은 반환값과
//     오류 메시지 어디에도 넣지 않는다.
//   * 금액은 Decimal 문자열 그대로 다루며 Number/parseFloat 변환을 하지 않는다.
//   * process.env 를 직접 읽지 않고 검증된 config 를 주입받는다.

const { buildSafeErrorDetails, normalizeWarningCodes } = require('../shared/shopifySafeErrorDetails');

const PRIVATE_TOKEN_HEADER = 'Shopify-Storefront-Private-Token';

const CART_CREATE_MUTATION = `
mutation cartCreate($input: CartInput) {
  cartCreate(input: $input) {
    cart {
      id
      checkoutUrl
      lines(first: 10) {
        nodes {
          quantity
          merchandise { ... on ProductVariant { id } }
        }
      }
      cost {
        totalAmount { amount currencyCode }
        totalAmountEstimated
      }
    }
    userErrors { field message }
    warnings { code target message }
  }
}`.trim();

const VARIANT_NODES_QUERY = `
query verifyVariants($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      title
      sku
      availableForSale
      product { id title }
    }
  }
}`.trim();

// 결과 판정 종류. Service 는 이 outcome 만 보고 DB 상태를 정한다.
const OUTCOME = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  OUTCOME_UNKNOWN: 'outcome_unknown',
};

function buildEndpoint(config) {
  return `https://${config.storeDomain}/api/${config.apiVersion}/graphql.json`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * checkoutUrl 검증: https 이고 파싱 가능하며 userinfo 가 없어야 한다.
 * hostname 을 myshopify.com 으로 제한하지 않는다(Custom Domain / Shopify
 * Checkout 도메인을 쓸 수 있기 때문).
 */
function isSafeCheckoutUrl(raw) {
  if (!isNonEmptyString(raw)) return false;
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return true;
}

/**
 * Money 검증: amount 는 Decimal 문자열, currencyCode 는 비어있지 않은 문자열.
 * 숫자 변환을 하지 않고 문자열 형태만 확인한다.
 */
function isValidMoney(money) {
  if (!money || typeof money !== 'object') return false;
  if (!isNonEmptyString(money.amount)) return false;
  if (!/^\d+(\.\d+)?$/.test(money.amount)) return false;
  if (!isNonEmptyString(money.currencyCode)) return false;
  return true;
}

/**
 * GraphQL top-level error 가 "요청이 실행되기 전에 확실히 거부됐다"고
 * 구조적으로 판정 가능한지 확인한다. message 문자열 검색에 의존하지 않고
 * extensions.code 만 본다.
 */
const PRE_EXECUTION_ERROR_CODES = ['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT'];

function hasStructuralPreExecutionError(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.some((error) => {
    const code = error && error.extensions && error.extensions.code;
    return typeof code === 'string' && PRE_EXECUTION_ERROR_CODES.includes(code.toUpperCase());
  });
}

function extractProviderCode(errors) {
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const code = error && error.extensions && error.extensions.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * userErrors[].field 를 안전한 구조화 코드로 변환한다(원문 message 는 버린다).
 * 예: ['lines', '0', 'merchandiseId'] → 'LINES_0_MERCHANDISE_ID'
 */
function toFieldCodes(userErrors) {
  if (!Array.isArray(userErrors)) return [];
  return userErrors
    .map((userError) => {
      const field = userError && userError.field;
      if (!Array.isArray(field) || field.length === 0) return null;
      return field
        .map((part) => String(part).replace(/([a-z0-9])([A-Z])/g, '$1_$2'))
        .join('_')
        .toUpperCase();
    })
    .filter(Boolean);
}

function createShopifyStorefrontAdapter({ config, fetchImpl = globalThis.fetch } = {}) {
  if (!config) {
    throw new Error('createShopifyStorefrontAdapter: config 주입이 필요합니다.');
  }

  function buildHeaders() {
    // Private Token 전용. Public Token 헤더는 어떤 경우에도 넣지 않는다.
    return {
      'Content-Type': 'application/json',
      [PRIVATE_TOKEN_HEADER]: config.privateToken,
    };
  }

  /**
   * 단발 HTTP 호출. 재시도 로직은 호출자가 결정한다(mutation 은 재시도 없음).
   * 반환: { transport: 'ok'|'network'|'timeout', httpStatus, json, parseFailed }
   */
  async function performRequest({ body, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(buildEndpoint(config), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let json = null;
      let parseFailed = false;
      try {
        json = await response.json();
      } catch (error) {
        parseFailed = true;
      }

      return { transport: 'ok', httpStatus: response.status, json, parseFailed };
    } catch (error) {
      const isAbort = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      return { transport: isAbort ? 'timeout' : 'network', httpStatus: null, json: null, parseFailed: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * cartCreate 1회 실행. 자동 재시도는 어떤 오류에도 하지 않는다.
   * lines 는 [{ merchandiseId, quantity }] 만 받으며 attributes/note/metafields 를
   * 절대 전송하지 않는다.
   *
   * @returns {{outcome: string, httpStatus: number|null, errorCode: string|null,
   *   safeErrorDetails: object|null, cart: object|null, warningCodes: string[]}}
   */
  async function createCart({ lines, timeoutMs }) {
    const input = {
      lines: lines.map((line) => ({ merchandiseId: line.merchandiseId, quantity: line.quantity })),
    };

    const result = await performRequest({
      body: { query: CART_CREATE_MUTATION, variables: { input } },
      timeoutMs: timeoutMs || config.timeoutMs,
    });

    // --- C. 전송 계층 실패: 요청이 도달했는지 확신할 수 없다 → outcome_unknown ---
    if (result.transport === 'timeout') {
      return unknownOutcome('SHOPIFY_TIMEOUT', null, { category: 'TIMEOUT' });
    }
    if (result.transport === 'network') {
      return unknownOutcome('SHOPIFY_UNAVAILABLE', null, { category: 'NETWORK' });
    }

    const { httpStatus, json, parseFailed } = result;

    // --- B. 인증/권한 실패는 Mutation 이 실행되지 않았음이 명확하다 → known failed ---
    if (httpStatus === 401 || httpStatus === 403) {
      return failedOutcome('SHOPIFY_AUTH_FAILED', httpStatus, { category: 'AUTHENTICATION' });
    }

    // --- D. 429: Mutation 미실행을 보장할 근거가 없다 → 보수적으로 outcome_unknown ---
    if (httpStatus === 429) {
      return unknownOutcome('SHOPIFY_RATE_LIMITED', httpStatus, { category: 'RATE_LIMIT' });
    }

    // --- C. 5xx / JSON parse 실패 → outcome_unknown ---
    if (httpStatus >= 500) {
      return unknownOutcome('SHOPIFY_UNAVAILABLE', httpStatus, { category: 'UPSTREAM' });
    }
    if (parseFailed || json === null || typeof json !== 'object') {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }

    const topLevelErrors = json.errors;
    const cartCreate = json.data && json.data.cartCreate;

    // top-level errors 판정: 구조적으로 사전 실행 오류가 확인되고 data 가 없을 때만
    // known failed. partial data 가 함께 오면 outcome_unknown.
    if (Array.isArray(topLevelErrors) && topLevelErrors.length > 0) {
      const hasData = json.data !== null && json.data !== undefined;
      if (!hasData && hasStructuralPreExecutionError(topLevelErrors)) {
        return failedOutcome('SHOPIFY_GRAPHQL_ERROR', httpStatus, {
          category: 'CART_INPUT',
          providerCode: extractProviderCode(topLevelErrors),
        });
      }
      return unknownOutcome('SHOPIFY_GRAPHQL_ERROR', httpStatus, {
        category: 'UPSTREAM',
        providerCode: extractProviderCode(topLevelErrors),
      });
    }

    if (httpStatus === 400 && !cartCreate) {
      return failedOutcome('SHOPIFY_GRAPHQL_ERROR', httpStatus, { category: 'CART_INPUT' });
    }
    if (!cartCreate) {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }

    const userErrors = cartCreate.userErrors;
    const cart = cartCreate.cart;
    const warningCodes = normalizeWarningCodes(cartCreate.warnings);

    // userErrors 와 cart 를 독립적으로 판정한다.
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      if (!cart) {
        // 명확한 실패: Shopify 가 Cart 를 만들지 않았다고 답했다.
        return failedOutcome('SHOPIFY_USER_ERROR', httpStatus, {
          category: 'CART_INPUT',
          fieldCodes: toFieldCodes(userErrors),
        });
      }
      // userErrors 와 cart 가 동시에 존재 → Cart 가 만들어졌을 수 있어 불확실.
      return unknownOutcome('SHOPIFY_USER_ERROR', httpStatus, {
        category: 'CART_INPUT',
        fieldCodes: toFieldCodes(userErrors),
      });
    }

    if (!cart) {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }

    // 필수 필드 검증. 하나라도 불완전하면 Cart 가 생성됐을 가능성이 있으므로
    // known failed 로 단정하지 않고 outcome_unknown 으로 처리한다.
    if (!isNonEmptyString(cart.id)) {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }
    if (!isSafeCheckoutUrl(cart.checkoutUrl)) {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }
    const lineNodes = cart.lines && Array.isArray(cart.lines.nodes) ? cart.lines.nodes : null;
    if (!lineNodes) {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }
    const cost = cart.cost;
    if (!cost || !isValidMoney(cost.totalAmount) || typeof cost.totalAmountEstimated !== 'boolean') {
      return unknownOutcome('SHOPIFY_INVALID_RESPONSE', httpStatus, { category: 'RESPONSE_SHAPE' });
    }

    return {
      outcome: OUTCOME.SUCCEEDED,
      httpStatus,
      errorCode: null,
      safeErrorDetails: null,
      warningCodes,
      cart: {
        id: cart.id,
        checkoutUrl: cart.checkoutUrl,
        lines: lineNodes.map((node) => ({
          quantity: node.quantity,
          merchandiseId: node.merchandise && node.merchandise.id ? node.merchandise.id : null,
        })),
        totalAmount: cost.totalAmount.amount, // Decimal 문자열 그대로
        totalCurrencyCode: cost.totalAmount.currencyCode,
        totalAmountEstimated: cost.totalAmountEstimated,
      },
    };
  }

  function failedOutcome(errorCode, httpStatus, details) {
    return {
      outcome: OUTCOME.FAILED,
      httpStatus,
      errorCode,
      safeErrorDetails: buildSafeErrorDetails(details),
      warningCodes: [],
      cart: null,
    };
  }

  function unknownOutcome(errorCode, httpStatus, details) {
    return {
      outcome: OUTCOME.OUTCOME_UNKNOWN,
      httpStatus,
      errorCode,
      safeErrorDetails: buildSafeErrorDetails(details),
      warningCodes: [],
      cart: null,
    };
  }

  /**
   * read-only Variant 조회. 이 함수만 제한적 retry 를 허용한다.
   * CLI/통합 테스트 전용이며 Cart 생성 경로에서는 호출하지 않는다.
   */
  async function verifyVariantsExist({ variantGids, timeoutMs }) {
    const maxAttempts = Math.max(1, (config.maxQueryRetries || 0) + 1);
    let lastResult = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const result = await performRequest({
        body: { query: VARIANT_NODES_QUERY, variables: { ids: variantGids } },
        timeoutMs: timeoutMs || config.timeoutMs,
      });
      lastResult = result;

      const retryable =
        result.transport !== 'ok' ||
        result.httpStatus === 429 ||
        result.httpStatus === 502 ||
        result.httpStatus === 503 ||
        result.httpStatus === 504;

      if (!retryable) break;
      if (attempt < maxAttempts - 1) {
        const backoffMs = Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    if (!lastResult || lastResult.transport !== 'ok') {
      return { ok: false, errorCode: lastResult && lastResult.transport === 'timeout' ? 'SHOPIFY_TIMEOUT' : 'SHOPIFY_UNAVAILABLE', nodes: null };
    }
    if (lastResult.httpStatus === 401 || lastResult.httpStatus === 403) {
      return { ok: false, errorCode: 'SHOPIFY_AUTH_FAILED', nodes: null };
    }
    if (lastResult.parseFailed || !lastResult.json || typeof lastResult.json !== 'object') {
      return { ok: false, errorCode: 'SHOPIFY_INVALID_RESPONSE', nodes: null };
    }
    if (Array.isArray(lastResult.json.errors) && lastResult.json.errors.length > 0) {
      return { ok: false, errorCode: 'SHOPIFY_GRAPHQL_ERROR', nodes: null };
    }
    const nodes = lastResult.json.data && lastResult.json.data.nodes;
    if (!Array.isArray(nodes)) {
      return { ok: false, errorCode: 'SHOPIFY_INVALID_RESPONSE', nodes: null };
    }

    return { ok: true, errorCode: null, nodes };
  }

  return { createCart, verifyVariantsExist };
}

module.exports = {
  PRIVATE_TOKEN_HEADER,
  CART_CREATE_MUTATION,
  VARIANT_NODES_QUERY,
  OUTCOME,
  PRE_EXECUTION_ERROR_CODES,
  isSafeCheckoutUrl,
  isValidMoney,
  hasStructuralPreExecutionError,
  toFieldCodes,
  createShopifyStorefrontAdapter,
};
