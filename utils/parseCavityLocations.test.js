const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCavityLocations } = require('./parseCavityLocations');

test('null / undefined 는 빈 배열', () => {
  assert.deepStrictEqual(parseCavityLocations(null), []);
  assert.deepStrictEqual(parseCavityLocations(undefined), []);
});

test('빈 문자열과 공백 문자열은 빈 배열', () => {
  assert.deepStrictEqual(parseCavityLocations(''), []);
  assert.deepStrictEqual(parseCavityLocations('   '), []);
});

test('JSON 문자열 "[]" 는 빈 배열', () => {
  assert.deepStrictEqual(parseCavityLocations('[]'), []);
});

test('JSON 문자열 배열은 그대로 파싱된다', () => {
  assert.deepStrictEqual(parseCavityLocations('["upper-left-molar"]'), ['upper-left-molar']);
});

test('드라이버가 이미 배열로 돌려준 경우 그대로 반환한다(경고 없이)', () => {
  // MariaDB LONGTEXT + JSON 제약이면 mysql2 가 파싱된 Array 를 돌려준다.
  // 예전 구현은 JSON.parse([]) === JSON.parse("") 로 매번 예외를 던졌다.
  assert.deepStrictEqual(parseCavityLocations([]), []);
  assert.deepStrictEqual(parseCavityLocations(['a', 'b']), ['a', 'b']);
});

test('Buffer 로 전달된 JSON 도 파싱한다', () => {
  assert.deepStrictEqual(parseCavityLocations(Buffer.from('["x"]', 'utf8')), ['x']);
  assert.deepStrictEqual(parseCavityLocations(Buffer.from('[]', 'utf8')), []);
});

test('유효하지 않은 JSON 문자열은 흐름을 중단하지 않고 빈 배열', () => {
  const original = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(' '));
  try {
    assert.deepStrictEqual(parseCavityLocations('{not json'), []);
  } finally {
    console.warn = original;
  }
  assert.strictEqual(logged.length, 1);
  // 원본 값 전체를 로그로 흘리지 않는다.
  assert.ok(!logged[0].includes('{not json'));
});

test('배열이 아닌 JSON(객체/숫자)은 빈 배열', () => {
  assert.deepStrictEqual(parseCavityLocations('{"a":1}'), []);
  assert.deepStrictEqual(parseCavityLocations('3'), []);
});

test('배열이 아닌 객체 타입은 빈 배열', () => {
  assert.deepStrictEqual(parseCavityLocations({ a: 1 }), []);
});
