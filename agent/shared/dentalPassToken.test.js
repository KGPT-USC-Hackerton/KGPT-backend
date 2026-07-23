/**
 * agent/shared/dentalPassToken.test.js
 * 실행: node agent/shared/dentalPassToken.test.js
 */

const assert = require('node:assert');
const {
  generateShareToken,
  hashShareToken,
  isValidTokenFormat,
} = require('./dentalPassToken');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('dentalPassToken 순수 함수 테스트\n');

test('생성된 Token은 URL-safe하고 43자(256-bit)이다', () => {
  const token = generateShareToken();
  assert.strictEqual(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test('Token에는 표준 base64 전용 문자(/, +, =)가 절대 포함되지 않는다', () => {
  for (let i = 0; i < 200; i += 1) {
    const token = generateShareToken();
    assert.ok(!token.includes('/'), `'/' 포함: ${token}`);
    assert.ok(!token.includes('+'), `'+' 포함: ${token}`);
    assert.ok(!token.includes('='), `'=' 포함: ${token}`);
  }
});

test('Token은 URL path segment에서 추가 인코딩 없이 그대로 사용 가능하다(encodeURIComponent 결과와 동일)', () => {
  const token = generateShareToken();
  assert.strictEqual(encodeURIComponent(token), token);
});

test('동일 Token은 항상 동일한 SHA-256 hash(64자 hex)를 만든다', () => {
  const token = generateShareToken();
  const hash1 = hashShareToken(token);
  const hash2 = hashShareToken(token);
  assert.strictEqual(hash1, hash2);
  assert.strictEqual(hash1.length, 64);
  assert.match(hash1, /^[0-9a-f]{64}$/);
});

test('다른 Token은 다른 hash를 만든다', () => {
  const tokenA = generateShareToken();
  const tokenB = generateShareToken();
  assert.notStrictEqual(hashShareToken(tokenA), hashShareToken(tokenB));
});

test('생성 결과 객체/문자열에 raw token 외 다른 표현이 섞이지 않는다(hash와 원문이 다르다)', () => {
  const token = generateShareToken();
  const hash = hashShareToken(token);
  assert.notStrictEqual(token, hash);
});

test('올바른 형식의 Token은 isValidTokenFormat이 true를 반환한다', () => {
  const token = generateShareToken();
  assert.strictEqual(isValidTokenFormat(token), true);
});

test('잘못된 형식의 Token은 isValidTokenFormat이 false를 반환한다', () => {
  assert.strictEqual(isValidTokenFormat(''), false);
  assert.strictEqual(isValidTokenFormat('too-short'), false);
  assert.strictEqual(isValidTokenFormat('a'.repeat(43) + 'x'), false); // 44자
  assert.strictEqual(isValidTokenFormat('a'.repeat(42)), false); // 42자
  assert.strictEqual(isValidTokenFormat('!'.repeat(43)), false); // 허용 안된 문자
  assert.strictEqual(isValidTokenFormat(null), false);
  assert.strictEqual(isValidTokenFormat(undefined), false);
  assert.strictEqual(isValidTokenFormat(12345), false);
  assert.strictEqual(isValidTokenFormat({}), false);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
