// safe_error_details_json 에 저장할 수 있는 값만 남기는 allowlist 빌더.
//
// Shopify 원문 message / GraphQL query / variables / store domain / Variant GID
// / Token / checkoutUrl / stack / HTTP response body / 사용자 입력 원문은
// 어떤 경로로도 저장되지 않는다. 허용 키는 정확히 3개뿐이다.

const ALLOWED_KEYS = ['category', 'provider_code', 'field_codes'];

const ALLOWED_CATEGORIES = [
  'AUTHENTICATION',
  'AUTHORIZATION',
  'CART_INPUT',
  'RATE_LIMIT',
  'NETWORK',
  'TIMEOUT',
  'UPSTREAM',
  'RESPONSE_SHAPE',
  'CONFIGURATION',
  'UNKNOWN',
];

const CODE_PATTERN = /^[A-Z0-9_]{1,80}$/;
const MAX_FIELD_CODES = 10;
const MAX_SERIALIZED_BYTES = 2048;

function sanitizeCode(value) {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  return CODE_PATTERN.test(upper) ? upper : null;
}

function serializedByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * @param {object} input
 * @param {string} input.category - ALLOWED_CATEGORIES 중 하나(아니면 UNKNOWN)
 * @param {string} [input.providerCode] - Shopify extensions.code 등 구조화된 코드
 * @param {string[]} [input.fieldCodes] - 예: ['LINES_0_MERCHANDISE_ID']
 * @returns {object} 허용 키만 담긴 안전한 객체
 */
function buildSafeErrorDetails({ category, providerCode, fieldCodes } = {}) {
  const result = {};

  const normalizedCategory = typeof category === 'string' ? category.toUpperCase() : 'UNKNOWN';
  result.category = ALLOWED_CATEGORIES.includes(normalizedCategory) ? normalizedCategory : 'UNKNOWN';

  const normalizedProviderCode = sanitizeCode(providerCode);
  if (normalizedProviderCode) {
    result.provider_code = normalizedProviderCode;
  }

  if (Array.isArray(fieldCodes)) {
    const codes = fieldCodes.map(sanitizeCode).filter(Boolean).slice(0, MAX_FIELD_CODES);
    if (codes.length > 0) {
      result.field_codes = codes;
    }
  }

  // 크기 제한: 초과하면 field_codes부터 줄이고, 그래도 초과하면 category만 남긴다.
  while (result.field_codes && result.field_codes.length > 0 && serializedByteLength(result) > MAX_SERIALIZED_BYTES) {
    result.field_codes = result.field_codes.slice(0, -1);
    if (result.field_codes.length === 0) delete result.field_codes;
  }
  if (serializedByteLength(result) > MAX_SERIALIZED_BYTES) {
    return { category: result.category };
  }

  return result;
}

// Shopify CartWarning 원문 message는 저장하지 않고, 서버가 인식하는 코드만 남긴다.
const MAX_WARNING_CODES = 10;

function normalizeWarningCodes(warnings) {
  if (!Array.isArray(warnings)) return [];
  const codes = [];
  for (const warning of warnings) {
    const code = sanitizeCode(warning && warning.code);
    if (code && !codes.includes(code)) codes.push(code);
    if (codes.length >= MAX_WARNING_CODES) break;
  }
  return codes;
}

module.exports = {
  ALLOWED_KEYS,
  ALLOWED_CATEGORIES,
  CODE_PATTERN,
  MAX_FIELD_CODES,
  MAX_SERIALIZED_BYTES,
  MAX_WARNING_CODES,
  buildSafeErrorDetails,
  normalizeWarningCodes,
};
