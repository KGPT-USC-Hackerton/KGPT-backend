/**
 * agent/shared/shopifyRequestHash.test.js
 * 실행: node agent/shared/shopifyRequestHash.test.js
 */

const assert = require('node:assert');
const { isValidIdempotencyKey, hashIdempotencyKey, computeRequestHash } = require('./shopifyRequestHash');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('shopifyRequestHash 테스트\n');

// -------------------- Idempotency-Key 문자 정책 --------------------

test('허용 문자(A-Z a-z 0-9 . _ : -)로 1~100자면 유효하다', () => {
  assert.strictEqual(isValidIdempotencyKey('a'), true);
  assert.strictEqual(isValidIdempotencyKey('cart-2026.07.23:demo_01'), true);
  assert.strictEqual(isValidIdempotencyKey('A'.repeat(100)), true);
});

test('101자 이상 또는 빈 문자열은 거부된다', () => {
  assert.strictEqual(isValidIdempotencyKey('A'.repeat(101)), false);
  assert.strictEqual(isValidIdempotencyKey(''), false);
});

test('공백/줄바꿈/탭/제어문자/Unicode는 거부된다', () => {
  for (const raw of ['has space', 'line\nbreak', 'tab\there', 'ctrlchar', '한글키', 'emoji🙂']) {
    assert.strictEqual(isValidIdempotencyKey(raw), false, JSON.stringify(raw));
  }
});

test('앞뒤 공백을 trim으로 자동 보정하지 않고 그대로 거부한다', () => {
  assert.strictEqual(isValidIdempotencyKey(' valid-key '), false);
});

test('문자열이 아닌 값은 거부된다', () => {
  for (const raw of [null, undefined, 123, {}, []]) {
    assert.strictEqual(isValidIdempotencyKey(raw), false);
  }
});

test('hashIdempotencyKey는 64자 hex이고 원문과 다르다', () => {
  const raw = 'cart-demo-key-001';
  const hash = hashIdempotencyKey(raw);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hash, raw);
  assert.ok(!hash.includes(raw));
});

test('같은 Key는 같은 hash, 다른 Key는 다른 hash', () => {
  assert.strictEqual(hashIdempotencyKey('k1'), hashIdempotencyKey('k1'));
  assert.notStrictEqual(hashIdempotencyKey('k1'), hashIdempotencyKey('k2'));
});

// -------------------- request_hash --------------------

function baseArgs(overrides = {}) {
  return {
    userId: 1,
    sessionId: 'session-1',
    proposalHash: 'a'.repeat(64),
    catalogVersion: 'bloomdent-hygiene-catalog-2026-07',
    rulesetVersion: 'oral-health-recommendation-v1',
    shopifyConfigFingerprint: 'b'.repeat(64),
    items: [{ product_key: 'FLOSS_TAPE', quantity: 1 }],
    ...overrides,
  };
}

test('request_hash는 64자 hex이고 결정론적이다', () => {
  const a = computeRequestHash(baseArgs());
  const b = computeRequestHash(baseArgs());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(a, b);
});

test('items 배열 순서가 달라도 request_hash는 같다', () => {
  const items1 = [
    { product_key: 'TOOTHBRUSH_SOFT', quantity: 2 },
    { product_key: 'FLOSS_TAPE', quantity: 1 },
  ];
  const items2 = [
    { product_key: 'FLOSS_TAPE', quantity: 1 },
    { product_key: 'TOOTHBRUSH_SOFT', quantity: 2 },
  ];
  assert.strictEqual(computeRequestHash(baseArgs({ items: items1 })), computeRequestHash(baseArgs({ items: items2 })));
});

test('shopify_config_fingerprint가 바뀌면 request_hash가 달라진다(Variant 매핑 변경 감지)', () => {
  const a = computeRequestHash(baseArgs());
  const b = computeRequestHash(baseArgs({ shopifyConfigFingerprint: 'c'.repeat(64) }));
  assert.notStrictEqual(a, b);
});

test('user_id/session_id/proposal_hash/quantity가 바뀌면 request_hash가 달라진다', () => {
  const base = computeRequestHash(baseArgs());
  assert.notStrictEqual(base, computeRequestHash(baseArgs({ userId: 2 })));
  assert.notStrictEqual(base, computeRequestHash(baseArgs({ sessionId: 'session-2' })));
  assert.notStrictEqual(base, computeRequestHash(baseArgs({ proposalHash: 'd'.repeat(64) })));
  assert.notStrictEqual(base, computeRequestHash(baseArgs({ items: [{ product_key: 'FLOSS_TAPE', quantity: 2 }] })));
});

test('items에 추가 필드(variant_gid 등)가 있어도 해시에는 product_key/quantity만 반영된다', () => {
  const withExtra = computeRequestHash(
    baseArgs({ items: [{ product_key: 'FLOSS_TAPE', quantity: 1, variant_gid: 'gid://shopify/ProductVariant/999' }] })
  );
  const withoutExtra = computeRequestHash(baseArgs());
  assert.strictEqual(withExtra, withoutExtra);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
