/**
 * middleware/agentDemoAuth.test.js
 * ----------------------------------------------------------------------------
 * Agent Demo Token 인증 미들웨어에 대한 오프라인 테스트.
 * 백엔드에 test runner(jest)가 없으므로 표준 node:assert 로 작성.
 *
 * 실행: node middleware/agentDemoAuth.test.js
 *   (Express 서버 구동 없이 req/res/next mock 으로 순수 함수만 검증)
 */

const assert = require('node:assert');

process.env.AGENT_AUTH_MODE = 'demo-token';
process.env.AGENT_DEMO_TOKEN = 'test-secret-token';
process.env.AGENT_DEMO_USER_ID = '1';

const agentDemoAuth = require('./agentDemoAuth');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
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

console.log('agentDemoAuth 미들웨어 테스트\n');

test('토큰 없이 요청하면 401 AGENT_AUTH_MISSING_TOKEN', () => {
  const req = { headers: {} };
  const res = mockRes();
  let nextCalled = false;
  agentDemoAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.error_code, 'AGENT_AUTH_MISSING_TOKEN');
  assert.strictEqual(nextCalled, false);
});

test('Bearer 형식이 아니면 401 AGENT_AUTH_MISSING_TOKEN', () => {
  const req = { headers: { authorization: 'test-secret-token' } };
  const res = mockRes();
  agentDemoAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error_code, 'AGENT_AUTH_MISSING_TOKEN');
});

test('잘못된 토큰이면 401 AGENT_AUTH_INVALID_TOKEN', () => {
  const req = { headers: { authorization: 'Bearer wrong-token' } };
  const res = mockRes();
  let nextCalled = false;
  agentDemoAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error_code, 'AGENT_AUTH_INVALID_TOKEN');
  assert.strictEqual(nextCalled, false);
});

test('올바른 토큰이면 통과하고 req.agentUser 를 설정한다', () => {
  const req = { headers: { authorization: 'Bearer test-secret-token' } };
  const res = mockRes();
  let nextCalled = false;
  agentDemoAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(req.agentUser, { id: 1 });
  assert.strictEqual(res.statusCode, null);
});

test('body/query/params 의 user_id 는 권한 판단에 쓰이지 않는다', () => {
  const req = {
    headers: { authorization: 'Bearer test-secret-token' },
    body: { user_id: 999 },
    query: { user_id: 999 },
    params: { user_id: 999 },
  };
  const res = mockRes();
  let nextCalled = false;
  agentDemoAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.agentUser.id, 1);
});

test('AGENT_DEMO_TOKEN 미설정 시 500 AGENT_AUTH_MISCONFIGURED (fail-closed)', () => {
  const original = process.env.AGENT_DEMO_TOKEN;
  delete process.env.AGENT_DEMO_TOKEN;
  const req = { headers: { authorization: 'Bearer anything' } };
  const res = mockRes();
  let nextCalled = false;
  agentDemoAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error_code, 'AGENT_AUTH_MISCONFIGURED');
  assert.strictEqual(nextCalled, false);
  process.env.AGENT_DEMO_TOKEN = original;
});

test('AGENT_AUTH_MODE 가 demo-token 이 아니면 500 AGENT_AUTH_MISCONFIGURED', () => {
  const original = process.env.AGENT_AUTH_MODE;
  process.env.AGENT_AUTH_MODE = 'jwt';
  const req = { headers: { authorization: 'Bearer test-secret-token' } };
  const res = mockRes();
  agentDemoAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error_code, 'AGENT_AUTH_MISCONFIGURED');
  process.env.AGENT_AUTH_MODE = original;
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
