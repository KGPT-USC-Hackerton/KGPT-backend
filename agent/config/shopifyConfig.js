// Shopify 관련 환경 변수를 읽고 검증하는 유일한 지점.
// Adapter/Service/Controller/CLI 중 어느 것도 process.env를 직접 읽지 않는다.
//
// 3단계 준비도(readiness)를 명확히 분리한다:
//   1) base       — SHOPIFY_ENABLED=false 이고 Token/domain/GID가 전혀 없어도
//                   항상 로드 가능. 추천 API가 쓰는 진단 정보만 제공한다.
//   2) query-ready — read-only Variant 검증 CLI에 필요한 설정(domain/token/
//                   apiVersion/timeout)이 갖춰졌는지.
//   3) cart-ready  — 실제 cartCreate Mutation 실행에 필요한 모든 설정
//                   (query-ready + enabled + lease 관계)이 갖춰졌는지.
// 추천 API는 오직 base 정보만 사용하므로 Shopify secret이 없어도 실패하지 않는다.

const { loadVariantMapping } = require('../catalog/shopifyVariantMapping');

const DEFAULT_API_VERSION = '2026-07';

const TIMEOUT_MS_RANGE = { min: 1000, max: 30000, default: 10000 };
const PENDING_LEASE_MS_RANGE = { min: 10000, max: 300000, default: 60000 };
const LEASE_SAFETY_MARGIN_MS_RANGE = { min: 1000, max: 30000, default: 5000 };
const MAX_QUERY_RETRIES_RANGE = { min: 0, max: 5, default: 2 };

class ShopifyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShopifyConfigError';
    this.code = 'SHOPIFY_INVALID_CONFIGURATION';
  }
}

/**
 * 엄격한 boolean 파싱. 값이 없으면(undefined/null) 안전한 기본값 false.
 * "true"/"false" 문자열만 허용하고 "1"/"yes"/빈 문자열/임의 문자열은 설정 오류.
 * Boolean(process.env.X) 같은 truthy 변환은 절대 쓰지 않는다.
 */
function parseStrictBoolean(raw, varName) {
  if (raw === undefined || raw === null) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ShopifyConfigError(`${varName}는 "true" 또는 "false"만 허용됩니다.`);
}

/**
 * 정확한 myshopify.com hostname만 허용한다.
 * https:// 접두사, path, query, fragment, port, userinfo가 있으면 거부.
 */
function normalizeStoreDomain(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ShopifyConfigError('SHOPIFY_STORE_DOMAIN이 설정되지 않았습니다.');
  }
  const value = raw.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new ShopifyConfigError('SHOPIFY_STORE_DOMAIN에는 https:// 등 scheme을 포함하지 마세요.');
  }
  if (value.includes('/') || value.includes('?') || value.includes('#') || value.includes('@') || value.includes(':')) {
    throw new ShopifyConfigError('SHOPIFY_STORE_DOMAIN에는 path/query/fragment/userinfo/port를 포함할 수 없습니다.');
  }
  const lowered = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(lowered)) {
    throw new ShopifyConfigError('SHOPIFY_STORE_DOMAIN은 <store>.myshopify.com 형식이어야 합니다.');
  }
  return lowered;
}

/**
 * YYYY-MM 형식만 허용. latest/unstable은 명시적으로 거부한다.
 */
function validateApiVersion(raw) {
  const value = raw === undefined || raw === null || raw === '' ? DEFAULT_API_VERSION : String(raw).trim();
  if (value === 'latest' || value === 'unstable') {
    throw new ShopifyConfigError('SHOPIFY_STOREFRONT_API_VERSION에 latest/unstable은 사용할 수 없습니다.');
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new ShopifyConfigError('SHOPIFY_STOREFRONT_API_VERSION은 YYYY-MM 형식이어야 합니다.');
  }
  return value;
}

function parseIntInRange(raw, range, varName) {
  if (raw === undefined || raw === null || raw === '') return range.default;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ShopifyConfigError(`${varName}는 정수여야 합니다.`);
  }
  // 범위 밖은 clamp하되, clamp 이후에도 잘못된 조합은 아래 관계 검증에서 걸러진다.
  return Math.min(range.max, Math.max(range.min, parsed));
}

/**
 * 항상 로드 가능한 기본 설정 + 진단. Shopify secret이 없어도 예외를 던지지
 * 않는다(형식이 명백히 잘못된 값만 ShopifyConfigError).
 */
function loadShopifyConfig(env = process.env) {
  const enabled = parseStrictBoolean(env.SHOPIFY_ENABLED, 'SHOPIFY_ENABLED');
  const runIntegrationTest = parseStrictBoolean(env.RUN_SHOPIFY_INTEGRATION_TEST, 'RUN_SHOPIFY_INTEGRATION_TEST');
  const allowCartMutationTest = parseStrictBoolean(
    env.ALLOW_SHOPIFY_CART_MUTATION_TEST,
    'ALLOW_SHOPIFY_CART_MUTATION_TEST'
  );

  const timeoutMs = parseIntInRange(env.SHOPIFY_TIMEOUT_MS, TIMEOUT_MS_RANGE, 'SHOPIFY_TIMEOUT_MS');
  const pendingLeaseMs = parseIntInRange(env.SHOPIFY_PENDING_LEASE_MS, PENDING_LEASE_MS_RANGE, 'SHOPIFY_PENDING_LEASE_MS');
  const leaseSafetyMarginMs = parseIntInRange(
    env.SHOPIFY_LEASE_SAFETY_MARGIN_MS,
    LEASE_SAFETY_MARGIN_MS_RANGE,
    'SHOPIFY_LEASE_SAFETY_MARGIN_MS'
  );
  const maxQueryRetries = parseIntInRange(env.SHOPIFY_MAX_QUERY_RETRIES, MAX_QUERY_RETRIES_RANGE, 'SHOPIFY_MAX_QUERY_RETRIES');

  // Lease는 반드시 timeout + 안전 여유보다 커야 한다. clamp만으로 잘못된 조합을
  // 통과시키지 않는다(정상 fetch가 진행 중인데 stale로 뒤집히는 것을 막기 위함).
  const leaseRelationOk = pendingLeaseMs > timeoutMs + leaseSafetyMarginMs;

  // domain/token/apiVersion은 없거나 잘못돼도 여기서 던지지 않고 진단으로만 남긴다
  // (추천 API가 Shopify secret 없이도 동작해야 하므로).
  let storeDomain = null;
  let storeDomainError = null;
  try {
    storeDomain = normalizeStoreDomain(env.SHOPIFY_STORE_DOMAIN);
  } catch (error) {
    storeDomainError = error.message;
  }

  let apiVersion = null;
  let apiVersionError = null;
  try {
    apiVersion = validateApiVersion(env.SHOPIFY_STOREFRONT_API_VERSION);
  } catch (error) {
    apiVersionError = error.message;
  }

  const privateToken = env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN || null;
  const hasPrivateToken = typeof privateToken === 'string' && privateToken.length > 0;

  let testStoreDomain = null;
  try {
    if (env.SHOPIFY_TEST_STORE_DOMAIN) testStoreDomain = normalizeStoreDomain(env.SHOPIFY_TEST_STORE_DOMAIN);
  } catch (error) {
    testStoreDomain = null;
  }

  const variantMapping = loadVariantMapping(env);

  return {
    enabled,
    storeDomain,
    apiVersion,
    privateToken,
    hasPrivateToken,
    timeoutMs,
    pendingLeaseMs,
    leaseSafetyMarginMs,
    maxQueryRetries,
    runIntegrationTest,
    allowCartMutationTest,
    testStoreDomain,
    variantMapping,
    diagnostics: {
      // 값이 아니라 "상태"만 담는다. 실제 domain/token/GID는 절대 넣지 않는다.
      store_domain_configured: storeDomain !== null,
      store_domain_error: storeDomainError,
      api_version_configured: apiVersion !== null,
      api_version_error: apiVersionError,
      private_token_configured: hasPrivateToken,
      lease_relation_ok: leaseRelationOk,
      configured_product_keys: variantMapping.configured_keys,
      missing_product_keys: variantMapping.missing_keys,
      invalid_product_keys: variantMapping.invalid_keys,
      duplicate_gid_product_keys: variantMapping.duplicate_gid_keys,
      unknown_env_keys: variantMapping.unknown_env_keys,
    },
  };
}

/**
 * read-only Variant Query(CLI/통합테스트)에 필요한 설정이 갖춰졌는지 검증한다.
 * SHOPIFY_ENABLED와 무관하게 통과할 수 있다.
 */
function assertQueryReady(config) {
  if (!config.storeDomain) {
    throw new ShopifyConfigError(config.diagnostics.store_domain_error || 'SHOPIFY_STORE_DOMAIN이 필요합니다.');
  }
  if (!config.apiVersion) {
    throw new ShopifyConfigError(config.diagnostics.api_version_error || 'SHOPIFY_STOREFRONT_API_VERSION이 필요합니다.');
  }
  if (!config.hasPrivateToken) {
    throw new ShopifyConfigError('SHOPIFY_STOREFRONT_PRIVATE_TOKEN이 필요합니다.');
  }
  return true;
}

/**
 * 실제 cartCreate Mutation 실행에 필요한 모든 설정을 검증한다.
 * query-ready + enabled + lease 관계까지 전부 충족해야 한다.
 */
function assertCartReady(config) {
  if (!config.enabled) {
    throw new ShopifyConfigError('SHOPIFY_ENABLED가 true가 아닙니다.');
  }
  assertQueryReady(config);
  if (!config.diagnostics.lease_relation_ok) {
    throw new ShopifyConfigError(
      'SHOPIFY_PENDING_LEASE_MS는 SHOPIFY_TIMEOUT_MS + SHOPIFY_LEASE_SAFETY_MARGIN_MS보다 커야 합니다.'
    );
  }
  return true;
}

module.exports = {
  DEFAULT_API_VERSION,
  TIMEOUT_MS_RANGE,
  PENDING_LEASE_MS_RANGE,
  LEASE_SAFETY_MARGIN_MS_RANGE,
  MAX_QUERY_RETRIES_RANGE,
  ShopifyConfigError,
  parseStrictBoolean,
  normalizeStoreDomain,
  validateApiVersion,
  loadShopifyConfig,
  assertQueryReady,
  assertCartReady,
};
