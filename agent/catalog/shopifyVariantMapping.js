// Product Key ↔ Shopify Variant GID 매핑 로더.
//
// 실제 GID는 환경 변수(SHOPIFY_VARIANT_GID_<PRODUCT_KEY>)에서만 읽고 소스에
// 하드코딩하지 않는다. GID 문자열은 mapping(내부용)에만 담기고, 진단 결과
// (configured_keys/missing_keys/...)에는 product_key 이름만 들어간다 —
// 로그·HTTP 응답에 GID가 새지 않도록 하기 위함이다.

const crypto = require('crypto');
const { canonicalStringify } = require('../shared/canonicalJson');
const { PRODUCTS } = require('./hygieneProductCatalog');

const ENV_PREFIX = 'SHOPIFY_VARIANT_GID_';
const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

const KNOWN_PRODUCT_KEYS = Object.freeze(Object.keys(PRODUCTS));

function isValidVariantGid(value) {
  return typeof value === 'string' && VARIANT_GID_PATTERN.test(value);
}

/**
 * 환경 변수에서 Product Key → Variant GID 매핑을 읽고 진단 결과와 함께 반환한다.
 * invalid/missing 값을 조용히 버리지 않고 전부 분류해 보고한다.
 *
 * @returns {{
 *   mapping: Map<string,string>,   // 내부 전용(실제 GID 포함)
 *   configured_keys: string[],
 *   missing_keys: string[],
 *   invalid_keys: string[],
 *   duplicate_gid_keys: string[],
 *   unknown_env_keys: string[],
 * }}
 */
function loadVariantMapping(env = process.env) {
  const rawByKey = new Map();
  const invalidKeys = [];
  const missingKeys = [];
  const unknownEnvKeys = [];

  // 카탈로그에 없는 SHOPIFY_VARIANT_GID_* 환경 변수는 무시하지 않고 설정 오류로 보고한다.
  for (const envName of Object.keys(env)) {
    if (!envName.startsWith(ENV_PREFIX)) continue;
    const productKey = envName.slice(ENV_PREFIX.length);
    if (!KNOWN_PRODUCT_KEYS.includes(productKey)) {
      unknownEnvKeys.push(envName);
    }
  }

  for (const productKey of KNOWN_PRODUCT_KEYS) {
    const raw = env[`${ENV_PREFIX}${productKey}`];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      missingKeys.push(productKey);
      continue;
    }
    const value = String(raw).trim();
    if (!isValidVariantGid(value)) {
      invalidKeys.push(productKey);
      continue;
    }
    rawByKey.set(productKey, value);
  }

  // 서로 다른 Product Key가 같은 GID를 가리키면 Cart line 검증과 상품 의미가
  // 모호해지므로 해당 키들을 전부 fail-closed 처리한다(매핑에서 제외).
  const keysByGid = new Map();
  for (const [productKey, gid] of rawByKey) {
    if (!keysByGid.has(gid)) keysByGid.set(gid, []);
    keysByGid.get(gid).push(productKey);
  }
  const duplicateGidKeys = [];
  for (const [, keys] of keysByGid) {
    if (keys.length > 1) duplicateGidKeys.push(...keys);
  }
  duplicateGidKeys.sort();

  const mapping = new Map();
  for (const [productKey, gid] of rawByKey) {
    if (duplicateGidKeys.includes(productKey)) continue;
    mapping.set(productKey, gid);
  }

  return {
    mapping,
    configured_keys: [...mapping.keys()].sort(),
    missing_keys: missingKeys.sort(),
    invalid_keys: invalidKeys.sort(),
    duplicate_gid_keys: duplicateGidKeys,
    unknown_env_keys: unknownEnvKeys.sort(),
  };
}

/**
 * 해당 product_key에 형식이 유효하고 중복되지 않은 GID가 로컬에 설정돼 있는지.
 * 원격 판매 가능 여부(availableForSale/재고/게시)는 보장하지 않는다.
 */
function isVariantConfigured(productKey, variantMapping) {
  return variantMapping.mapping.has(productKey);
}

function getVariantGid(productKey, variantMapping) {
  return variantMapping.mapping.get(productKey) || null;
}

/**
 * 선택된 상품에 대한 Shopify 설정 지문. store domain/API version/GID가 바뀌면
 * 값이 달라지므로, 같은 Idempotency-Key라도 request_hash가 달라져 충돌로 잡힌다.
 * 실제 domain/GID는 해시 입력에만 쓰이고 반환값(해시)에는 남지 않는다.
 */
function computeShopifyConfigFingerprint({ storeDomain, apiVersion, selectedVariants }) {
  const variants = [...selectedVariants]
    .map((v) => ({ product_key: v.product_key, variant_gid: v.variant_gid }))
    .sort((a, b) => (a.product_key < b.product_key ? -1 : a.product_key > b.product_key ? 1 : 0));

  return crypto
    .createHash('sha256')
    .update(canonicalStringify({ store_domain: storeDomain, api_version: apiVersion, variants }))
    .digest('hex');
}

module.exports = {
  ENV_PREFIX,
  VARIANT_GID_PATTERN,
  KNOWN_PRODUCT_KEYS,
  isValidVariantGid,
  loadVariantMapping,
  isVariantConfigured,
  getVariantGid,
  computeShopifyConfigFingerprint,
};
