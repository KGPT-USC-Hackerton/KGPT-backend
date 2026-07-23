/**
 * database/verify-migration-scratch-db.test.js
 * ----------------------------------------------------------------------------
 * assertScratchDbNameAllowed() 에 대한 오프라인 테스트. DB 연결 없이,
 * "스크래치 DB 이름이 허용 목록과 정확히 일치하지 않으면 삭제를 거부한다"는
 * 안전 조건만 검증한다.
 *
 * 실행: node database/verify-migration-scratch-db.test.js
 */

const assert = require('node:assert');
const { ALLOWED_SCRATCH_DB_NAMES, SCRATCH_DB_NAME, assertScratchDbNameAllowed } = require('./verify-migration-scratch-db');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('verify-migration-scratch-db 안전 가드 테스트\n');

test('허용 목록에 정확히 있는 이름은 통과한다', () => {
  assert.doesNotThrow(() => assertScratchDbNameAllowed(SCRATCH_DB_NAME));
});

test('실 개발 DB 이름(bloomdent)은 거부된다', () => {
  assert.throws(() => assertScratchDbNameAllowed('bloomdent'), /허용되지 않은 스크래치 DB 이름/);
});

test('허용 목록에 없는 임의의 이름은 거부된다', () => {
  assert.throws(() => assertScratchDbNameAllowed('some_other_db'), /허용되지 않은 스크래치 DB 이름/);
});

test('대소문자/부분 일치만으로는 통과하지 않는다(정확한 일치만 허용)', () => {
  assert.throws(() => assertScratchDbNameAllowed('BLOOMDENT_MIGRATION_VERIFY'));
  assert.throws(() => assertScratchDbNameAllowed('bloomdent_migration_verify_2'));
  assert.throws(() => assertScratchDbNameAllowed('bloomdent_migration'));
});

test('빈 문자열/undefined 는 거부된다', () => {
  assert.throws(() => assertScratchDbNameAllowed(''));
  assert.throws(() => assertScratchDbNameAllowed(undefined));
});

test('ALLOWED_SCRATCH_DB_NAMES 는 정확히 1개, bloomdent_migration_verify 만 포함한다', () => {
  assert.deepStrictEqual(ALLOWED_SCRATCH_DB_NAMES, ['bloomdent_migration_verify']);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
