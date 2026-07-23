/**
 * agent/catalog/shopifyExpectedSkus.test.js
 * 실행: node agent/catalog/shopifyExpectedSkus.test.js
 */

const assert = require('node:assert');
const { EXPECTED_SKUS, compareSku } = require('./shopifyExpectedSkus');
const { KNOWN_PRODUCT_KEYS } = require('./shopifyVariantMapping');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('shopifyExpectedSkus 테스트\n');

test('카탈로그의 7개 product_key 전부에 기대 SKU가 정의돼 있다', () => {
  for (const productKey of KNOWN_PRODUCT_KEYS) {
    assert.ok(EXPECTED_SKUS[productKey], `${productKey}의 기대 SKU가 없습니다`);
  }
  assert.strictEqual(Object.keys(EXPECTED_SKUS).length, KNOWN_PRODUCT_KEYS.length);
});

test('기대 SKU는 모두 유일하다', () => {
  const skus = Object.values(EXPECTED_SKUS);
  assert.strictEqual(new Set(skus).size, skus.length);
});

test('SKU가 기대값과 같으면 OK', () => {
  assert.strictEqual(compareSku('FLOSS_TAPE', 'BD-FLOSS-TAPE'), 'OK');
});

test('SKU가 다르면 SKU_MISMATCH', () => {
  assert.strictEqual(compareSku('FLOSS_TAPE', 'OTHER-SKU'), 'SKU_MISMATCH');
});

test('SKU가 null이면 SKU_MISMATCH(권한 오류를 일치로 간주하지 않음)', () => {
  assert.strictEqual(compareSku('FLOSS_TAPE', null), 'SKU_MISMATCH');
});

test('sku 필드 자체를 조회할 수 없었을 때(undefined)만 SKIPPED_UNAVAILABLE_FIELD', () => {
  assert.strictEqual(compareSku('FLOSS_TAPE', undefined), 'SKIPPED_UNAVAILABLE_FIELD');
});

test('알 수 없는 product_key는 SKU_MISMATCH', () => {
  assert.strictEqual(compareSku('UNKNOWN_PRODUCT', 'BD-FLOSS-TAPE'), 'SKU_MISMATCH');
});

test('EXPECTED_SKUS는 deepFreeze되어 런타임 변조가 불가능하다', () => {
  assert.throws(() => {
    'use strict';
    EXPECTED_SKUS.FLOSS_TAPE = 'TAMPERED';
  }, TypeError);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
