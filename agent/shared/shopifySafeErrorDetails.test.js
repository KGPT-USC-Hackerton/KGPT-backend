/**
 * agent/shared/shopifySafeErrorDetails.test.js
 * 실행: node agent/shared/shopifySafeErrorDetails.test.js
 */

const assert = require('node:assert');
const {
  ALLOWED_KEYS,
  MAX_FIELD_CODES,
  MAX_SERIALIZED_BYTES,
  MAX_WARNING_CODES,
  buildSafeErrorDetails,
  normalizeWarningCodes,
} = require('./shopifySafeErrorDetails');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('shopifySafeErrorDetails 테스트\n');

test('허용 키는 정확히 category/provider_code/field_codes 3개다', () => {
  assert.deepStrictEqual(ALLOWED_KEYS, ['category', 'provider_code', 'field_codes']);
});

test('허용된 키만 결과에 남는다', () => {
  const result = buildSafeErrorDetails({ category: 'AUTHENTICATION', providerCode: 'UNAUTHORIZED' });
  assert.deepStrictEqual(Object.keys(result).sort(), ['category', 'provider_code']);
});

test('알 수 없는 category는 UNKNOWN으로 정규화된다', () => {
  assert.strictEqual(buildSafeErrorDetails({ category: 'SOMETHING_ELSE' }).category, 'UNKNOWN');
  assert.strictEqual(buildSafeErrorDetails({}).category, 'UNKNOWN');
});

test('field_codes는 대문자/숫자/언더스코어로 정규화되고 최대 10개까지만 저장된다', () => {
  const many = Array.from({ length: 20 }, (_, i) => `LINES_${i}_MERCHANDISE_ID`);
  const result = buildSafeErrorDetails({ category: 'CART_INPUT', fieldCodes: many });
  assert.strictEqual(result.field_codes.length, MAX_FIELD_CODES);
});

test('형식에 맞지 않는 code는 제거된다(소문자/특수문자/80자 초과)', () => {
  const result = buildSafeErrorDetails({
    category: 'CART_INPUT',
    fieldCodes: ['VALID_CODE', 'has space', 'sym-bol!', 'A'.repeat(81)],
  });
  assert.deepStrictEqual(result.field_codes, ['VALID_CODE']);
});

test('Shopify 원문 message/query/variables/token/url/stack 은 어떤 입력으로도 저장되지 않는다', () => {
  const result = buildSafeErrorDetails({
    category: 'CART_INPUT',
    providerCode: 'THROTTLED',
    fieldCodes: ['LINES_0_MERCHANDISE_ID'],
    // 아래 값들은 allowlist 밖이라 빌더가 전부 무시해야 한다
    message: 'Shopify 원문 메시지',
    query: 'mutation cartCreate { ... }',
    variables: { input: { lines: [] } },
    token: 'super-secret-token',
    checkoutUrl: 'https://demo.myshopify.com/checkout/abc',
    stack: 'Error: at ...',
    responseBody: '{"errors":[]}',
  });
  const serialized = JSON.stringify(result);
  for (const leak of ['원문 메시지', 'cartCreate {', 'super-secret-token', 'checkout/abc', 'Error: at', 'responseBody']) {
    assert.ok(!serialized.includes(leak), leak);
  }
  assert.deepStrictEqual(Object.keys(result).sort(), ['category', 'field_codes', 'provider_code']);
});

test('직렬화 크기가 2048 bytes를 넘지 않는다', () => {
  const many = Array.from({ length: 10 }, (_, i) => 'A'.repeat(80 - String(i).length) + i);
  const result = buildSafeErrorDetails({ category: 'CART_INPUT', providerCode: 'B'.repeat(80), fieldCodes: many });
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_SERIALIZED_BYTES);
});

test('provider_code가 형식에 맞지 않으면 생략된다', () => {
  const result = buildSafeErrorDetails({ category: 'UPSTREAM', providerCode: 'has space!' });
  assert.strictEqual('provider_code' in result, false);
});

// -------------------- warning codes --------------------

test('warning은 code만 남기고 원문 message/target은 버린다', () => {
  const codes = normalizeWarningCodes([
    { code: 'MERCHANDISE_NOT_ENOUGH_STOCK', target: 'gid://shopify/CartLine/1', message: '재고 부족 원문' },
  ]);
  assert.deepStrictEqual(codes, ['MERCHANDISE_NOT_ENOUGH_STOCK']);
  assert.ok(!JSON.stringify(codes).includes('재고 부족 원문'));
  assert.ok(!JSON.stringify(codes).includes('CartLine'));
});

test('warning code는 최대 10개까지, 중복은 제거된다', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ code: `WARNING_${i}` }));
  assert.strictEqual(normalizeWarningCodes(many).length, MAX_WARNING_CODES);
  assert.deepStrictEqual(normalizeWarningCodes([{ code: 'DUP' }, { code: 'DUP' }]), ['DUP']);
});

test('warnings가 배열이 아니거나 비어 있으면 빈 배열을 반환한다', () => {
  assert.deepStrictEqual(normalizeWarningCodes(undefined), []);
  assert.deepStrictEqual(normalizeWarningCodes(null), []);
  assert.deepStrictEqual(normalizeWarningCodes([]), []);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
