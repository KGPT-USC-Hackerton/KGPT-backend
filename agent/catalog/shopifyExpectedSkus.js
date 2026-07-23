// Product Key → 기대 Shopify SKU 매핑(정적, 비밀 아님).
//
// Variant 검증 CLI가 Storefront에서 읽어온 ProductVariant.sku를 이 값과 대조해
// "설정된 GID가 정말 우리가 의도한 상품인지"를 확인한다. Product title은
// 언제든 바뀔 수 있고 지역화될 수 있으므로 식별 기준으로 쓰지 않는다.
const { deepFreeze } = require('../shared/deepFreeze');

const EXPECTED_SKUS = {
  TOOTHBRUSH_ULTRA_SOFT: 'BD-TOOTHBRUSH-ULTRA-SOFT',
  TOOTHBRUSH_SOFT: 'BD-TOOTHBRUSH-SOFT',
  TOOTHPASTE_FLUORIDE: 'BD-TOOTHPASTE-FLUORIDE',
  TOOTHPASTE_SENSITIVE: 'BD-TOOTHPASTE-SENSITIVE',
  FLOSS_TAPE: 'BD-FLOSS-TAPE',
  INTERDENTAL_STARTER: 'BD-INTERDENTAL-STARTER',
  TONGUE_CLEANER: 'BD-TONGUE-CLEANER',
};

deepFreeze(EXPECTED_SKUS);

/**
 * Storefront에서 읽은 sku를 기대값과 대조한다.
 *
 * @param {string} productKey
 * @param {string|null|undefined} actualSku - Storefront ProductVariant.sku.
 *   Token 권한 등으로 필드 자체를 조회할 수 없었다면 undefined를 넘긴다
 *   (그 경우에만 SKIPPED_UNAVAILABLE_FIELD). 권한 오류를 "일치"로 간주하지 않는다.
 * @returns {'OK'|'SKU_MISMATCH'|'SKIPPED_UNAVAILABLE_FIELD'}
 */
function compareSku(productKey, actualSku) {
  if (actualSku === undefined) return 'SKIPPED_UNAVAILABLE_FIELD';
  const expected = EXPECTED_SKUS[productKey];
  if (!expected) return 'SKU_MISMATCH';
  if (actualSku === null || actualSku !== expected) return 'SKU_MISMATCH';
  return 'OK';
}

module.exports = { EXPECTED_SKUS, compareSku };
