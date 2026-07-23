const crypto = require('crypto');
const { canonicalStringify } = require('./canonicalJson');

// Idempotency 관련 해시 계산 순수 함수. DB/Express/Shopify에 의존하지 않는다.

// 공백/줄바꿈/탭/제어문자/Unicode를 전부 배제한 좁은 문자 집합만 허용한다.
// 앞뒤 trim으로 자동 보정하지 않고 원문 그대로 검사한다.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

function isValidIdempotencyKey(raw) {
  return typeof raw === 'string' && IDEMPOTENCY_KEY_PATTERN.test(raw);
}

/**
 * Idempotency-Key 원문은 DB/로그 어디에도 저장하지 않고 이 해시만 남긴다.
 */
function hashIdempotencyKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * 이번 요청 전체의 지문. proposal_hash(추천 의미)와 달리 Shopify 환경 설정과
 * 인증 사용자까지 바인딩하므로, Store/API 버전/Variant 매핑이 바뀌면 같은
 * Idempotency-Key라도 충돌(409)로 잡힌다.
 */
function computeRequestHash({
  userId,
  sessionId,
  proposalHash,
  catalogVersion,
  rulesetVersion,
  shopifyConfigFingerprint,
  items,
}) {
  const sortedItems = [...items]
    .map((item) => ({ product_key: item.product_key, quantity: item.quantity }))
    .sort((a, b) => (a.product_key < b.product_key ? -1 : a.product_key > b.product_key ? 1 : 0));

  return crypto
    .createHash('sha256')
    .update(
      canonicalStringify({
        user_id: userId,
        session_id: sessionId,
        proposal_hash: proposalHash,
        catalog_version: catalogVersion,
        ruleset_version: rulesetVersion,
        shopify_config_fingerprint: shopifyConfigFingerprint,
        items: sortedItems,
      })
    )
    .digest('hex');
}

module.exports = {
  IDEMPOTENCY_KEY_PATTERN,
  isValidIdempotencyKey,
  hashIdempotencyKey,
  computeRequestHash,
};
