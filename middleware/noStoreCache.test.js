/**
 * middleware/noStoreCache.test.js
 * 실행: node middleware/noStoreCache.test.js
 */

const assert = require('node:assert');
const noStoreCache = require('./noStoreCache');

function mockRes() {
  return {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('noStoreCache 미들웨어 테스트\n');

test('Cache-Control: no-store 와 Pragma: no-cache 를 설정하고 next()를 호출한다', () => {
  const req = {};
  const res = mockRes();
  let nextCalled = false;
  noStoreCache(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  assert.strictEqual(res.headers['Pragma'], 'no-cache');
  assert.strictEqual(nextCalled, true);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
