/**
 * agent/catalog/shopifyVariantMapping.test.js
 * 실행: node agent/catalog/shopifyVariantMapping.test.js
 */

const assert = require('node:assert');
const {
  KNOWN_PRODUCT_KEYS,
  isValidVariantGid,
  loadVariantMapping,
  isVariantConfigured,
  getVariantGid,
  computeShopifyConfigFingerprint,
} = require('./shopifyVariantMapping');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('shopifyVariantMapping 테스트\n');

const GID = (n) => `gid://shopify/ProductVariant/${n}`;

// -------------------- GID 형식 --------------------

test('gid://shopify/ProductVariant/<숫자> 형식만 유효하다', () => {
  assert.strictEqual(isValidVariantGid(GID(1234567890)), true);
  assert.strictEqual(isValidVariantGid('gid://shopify/Product/1234567890'), false);
  assert.strictEqual(isValidVariantGid('gid://shopify/ProductVariant/abc'), false);
  assert.strictEqual(isValidVariantGid('1234567890'), false);
  assert.strictEqual(isValidVariantGid(''), false);
  assert.strictEqual(isValidVariantGid(null), false);
  assert.strictEqual(isValidVariantGid(undefined), false);
});

// -------------------- 진단 구조 --------------------

test('환경 변수가 없으면 7개 전부 missing_keys로 보고한다(조용히 무시하지 않음)', () => {
  const result = loadVariantMapping({});
  assert.strictEqual(result.configured_keys.length, 0);
  assert.deepStrictEqual(result.missing_keys.sort(), [...KNOWN_PRODUCT_KEYS].sort());
  assert.deepStrictEqual(result.invalid_keys, []);
  assert.deepStrictEqual(result.duplicate_gid_keys, []);
});

test('형식이 잘못된 GID는 invalid_keys로 분류된다', () => {
  const result = loadVariantMapping({ SHOPIFY_VARIANT_GID_FLOSS_TAPE: 'not-a-gid' });
  assert.ok(result.invalid_keys.includes('FLOSS_TAPE'));
  assert.ok(!result.configured_keys.includes('FLOSS_TAPE'));
});

test('정상 GID는 configured_keys와 mapping에 들어간다', () => {
  const result = loadVariantMapping({ SHOPIFY_VARIANT_GID_FLOSS_TAPE: GID(111) });
  assert.ok(result.configured_keys.includes('FLOSS_TAPE'));
  assert.strictEqual(result.mapping.get('FLOSS_TAPE'), GID(111));
  assert.strictEqual(isVariantConfigured('FLOSS_TAPE', result), true);
  assert.strictEqual(getVariantGid('FLOSS_TAPE', result), GID(111));
});

test('빈 문자열/공백만 있는 값은 missing으로 본다', () => {
  const result = loadVariantMapping({ SHOPIFY_VARIANT_GID_FLOSS_TAPE: '   ' });
  assert.ok(result.missing_keys.includes('FLOSS_TAPE'));
});

// -------------------- Duplicate GID fail-closed --------------------

test('서로 다른 product_key가 같은 GID를 공유하면 둘 다 fail-closed된다', () => {
  const result = loadVariantMapping({
    SHOPIFY_VARIANT_GID_FLOSS_TAPE: GID(999),
    SHOPIFY_VARIANT_GID_TONGUE_CLEANER: GID(999),
    SHOPIFY_VARIANT_GID_TOOTHBRUSH_SOFT: GID(111),
  });
  assert.deepStrictEqual(result.duplicate_gid_keys, ['FLOSS_TAPE', 'TONGUE_CLEANER']);
  // 중복된 두 키는 매핑에서 제외되어 Cart 에 담을 수 없다
  assert.strictEqual(isVariantConfigured('FLOSS_TAPE', result), false);
  assert.strictEqual(isVariantConfigured('TONGUE_CLEANER', result), false);
  // 중복이 아닌 키는 정상 유지
  assert.strictEqual(isVariantConfigured('TOOTHBRUSH_SOFT', result), true);
});

// -------------------- 알 수 없는 환경 변수 --------------------

test('카탈로그에 없는 SHOPIFY_VARIANT_GID_* 는 무시하지 않고 unknown_env_keys로 보고한다', () => {
  const result = loadVariantMapping({ SHOPIFY_VARIANT_GID_MOUTHWASH: GID(555) });
  assert.deepStrictEqual(result.unknown_env_keys, ['SHOPIFY_VARIANT_GID_MOUTHWASH']);
});

// -------------------- fingerprint --------------------

test('shopify_config_fingerprint는 64자 hex이고 결정론적이다', () => {
  const args = {
    storeDomain: 'demo.myshopify.com',
    apiVersion: '2026-07',
    selectedVariants: [{ product_key: 'FLOSS_TAPE', variant_gid: GID(111) }],
  };
  const a = computeShopifyConfigFingerprint(args);
  const b = computeShopifyConfigFingerprint(args);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(a, b);
});

test('selectedVariants 배열 순서가 달라도 fingerprint는 같다', () => {
  const base = { storeDomain: 'demo.myshopify.com', apiVersion: '2026-07' };
  const a = computeShopifyConfigFingerprint({
    ...base,
    selectedVariants: [
      { product_key: 'TOOTHBRUSH_SOFT', variant_gid: GID(222) },
      { product_key: 'FLOSS_TAPE', variant_gid: GID(111) },
    ],
  });
  const b = computeShopifyConfigFingerprint({
    ...base,
    selectedVariants: [
      { product_key: 'FLOSS_TAPE', variant_gid: GID(111) },
      { product_key: 'TOOTHBRUSH_SOFT', variant_gid: GID(222) },
    ],
  });
  assert.strictEqual(a, b);
});

test('store domain이 바뀌면 fingerprint가 달라진다', () => {
  const selectedVariants = [{ product_key: 'FLOSS_TAPE', variant_gid: GID(111) }];
  const a = computeShopifyConfigFingerprint({ storeDomain: 'a.myshopify.com', apiVersion: '2026-07', selectedVariants });
  const b = computeShopifyConfigFingerprint({ storeDomain: 'b.myshopify.com', apiVersion: '2026-07', selectedVariants });
  assert.notStrictEqual(a, b);
});

test('API version이 바뀌면 fingerprint가 달라진다', () => {
  const selectedVariants = [{ product_key: 'FLOSS_TAPE', variant_gid: GID(111) }];
  const a = computeShopifyConfigFingerprint({ storeDomain: 'a.myshopify.com', apiVersion: '2026-07', selectedVariants });
  const b = computeShopifyConfigFingerprint({ storeDomain: 'a.myshopify.com', apiVersion: '2026-04', selectedVariants });
  assert.notStrictEqual(a, b);
});

test('Variant GID가 바뀌면 fingerprint가 달라진다(Idempotency 충돌 유도)', () => {
  const base = { storeDomain: 'a.myshopify.com', apiVersion: '2026-07' };
  const a = computeShopifyConfigFingerprint({ ...base, selectedVariants: [{ product_key: 'FLOSS_TAPE', variant_gid: GID(111) }] });
  const b = computeShopifyConfigFingerprint({ ...base, selectedVariants: [{ product_key: 'FLOSS_TAPE', variant_gid: GID(222) }] });
  assert.notStrictEqual(a, b);
});

test('fingerprint 결과 문자열에 실제 GID나 domain이 남지 않는다', () => {
  const fingerprint = computeShopifyConfigFingerprint({
    storeDomain: 'secret-store.myshopify.com',
    apiVersion: '2026-07',
    selectedVariants: [{ product_key: 'FLOSS_TAPE', variant_gid: GID(1234567890) }],
  });
  assert.ok(!fingerprint.includes('secret-store'));
  assert.ok(!fingerprint.includes('1234567890'));
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
