/**
 * agent/controllers/messageController.test.js
 * ----------------------------------------------------------------------------
 * HTTP 요청 파싱/검증만 검증한다(§요청 검증 8종). 실제 서비스 로직은
 * agent/services/agentMessageService.processMessage 를 임시로 monkey-patch해
 * DB/Gemini 없이 격리한다. 정상 케이스에서 서비스가 호출되는지, 요청이
 * 유효하지 않을 때는 서비스가 호출되지 않는지까지 함께 확인한다.
 *
 * 실행: node agent/controllers/messageController.test.js
 */

const assert = require('node:assert');
const { randomUUID } = require('crypto');

const { createMessage } = require('./messageController');
const agentMessageService = require('../services/agentMessageService');

let passed = 0;
function test(name, fn) {
  return fn().then(() => {
    passed += 1;
    console.log(`  ✅ ${name}`);
  });
}

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

async function run() {
  console.log('messageController 요청 검증 테스트\n');

  const validSessionId = randomUUID();

  await test('정상 메시지는 서비스를 호출하고 200을 반환한다', async () => {
    const original = agentMessageService.processMessage;
    let calledWith = null;
    agentMessageService.processMessage = async (args) => {
      calledWith = args;
      return { session_id: validSessionId, user_message: {}, assistant_message: {} };
    };
    try {
      const req = { params: { sessionId: validSessionId }, body: { message: '안녕하세요' }, agentUser: { id: 1 } };
      const res = mockRes();
      await createMessage(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(calledWith.message, '안녕하세요');
      assert.strictEqual(calledWith.userId, 1);
      assert.strictEqual(calledWith.sessionId, validSessionId);
    } finally {
      agentMessageService.processMessage = original;
    }
  });

  await test('빈 메시지는 400 VALIDATION_ERROR', async () => {
    const req = { params: { sessionId: validSessionId }, body: { message: '   ' }, agentUser: { id: 1 } };
    const res = mockRes();
    await createMessage(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  await test('2000자 초과 메시지는 400 VALIDATION_ERROR', async () => {
    const req = { params: { sessionId: validSessionId }, body: { message: 'a'.repeat(2001) }, agentUser: { id: 1 } };
    const res = mockRes();
    await createMessage(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  await test('허용되지 않은 필드는 400 UNKNOWN_FIELD', async () => {
    const req = {
      params: { sessionId: validSessionId },
      body: { message: '안녕', tool_name: 'calculate_oop_cost' },
      agentUser: { id: 1 },
    };
    const res = mockRes();
    await createMessage(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD');
  });

  await test('body의 user_id는 무시되고 UNKNOWN_FIELD로 거부된다', async () => {
    const req = {
      params: { sessionId: validSessionId },
      body: { message: '안녕', user_id: 999 },
      agentUser: { id: 1 },
    };
    const res = mockRes();
    await createMessage(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD');
  });

  await test('session_id/history_id/context_snapshot/tool_input/system_prompt 등도 UNKNOWN_FIELD', async () => {
    for (const field of ['session_id', 'history_id', 'context_snapshot', 'tool_name', 'tool_input', 'system_prompt']) {
      const req = { params: { sessionId: validSessionId }, body: { message: '안녕', [field]: 'x' }, agentUser: { id: 1 } };
      const res = mockRes();
      await createMessage(req, res);
      assert.strictEqual(res.statusCode, 400, field);
      assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD', field);
    }
  });

  await test('잘못된 session UUID는 400 VALIDATION_ERROR', async () => {
    const req = { params: { sessionId: 'not-a-uuid' }, body: { message: '안녕' }, agentUser: { id: 1 } };
    const res = mockRes();
    await createMessage(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  await test('client_message_id는 1~100자 문자열만 허용된다', async () => {
    const req1 = {
      params: { sessionId: validSessionId },
      body: { message: '안녕', client_message_id: '' },
      agentUser: { id: 1 },
    };
    const res1 = mockRes();
    await createMessage(req1, res1);
    assert.strictEqual(res1.statusCode, 400);

    const req2 = {
      params: { sessionId: validSessionId },
      body: { message: '안녕', client_message_id: 'a'.repeat(101) },
      agentUser: { id: 1 },
    };
    const res2 = mockRes();
    await createMessage(req2, res2);
    assert.strictEqual(res2.statusCode, 400);

    const original = agentMessageService.processMessage;
    let calledWith = null;
    agentMessageService.processMessage = async (args) => {
      calledWith = args;
      return { session_id: validSessionId, user_message: {}, assistant_message: {} };
    };
    try {
      const req3 = {
        params: { sessionId: validSessionId },
        body: { message: '안녕', client_message_id: 'client-msg-1' },
        agentUser: { id: 1 },
      };
      const res3 = mockRes();
      await createMessage(req3, res3);
      assert.strictEqual(res3.statusCode, 200);
      assert.strictEqual(calledWith.clientMessageId, 'client-msg-1');
    } finally {
      agentMessageService.processMessage = original;
    }
  });

  await test('AgentMessageError.code 는 매핑 테이블대로 HTTP 상태로 변환된다', async () => {
    const original = agentMessageService.processMessage;
    agentMessageService.processMessage = async () => {
      const err = new Error('세션을 찾을 수 없습니다.');
      err.code = 'AGENT_SESSION_NOT_FOUND';
      throw err;
    };
    try {
      const req = { params: { sessionId: validSessionId }, body: { message: '안녕' }, agentUser: { id: 1 } };
      const res = mockRes();
      await createMessage(req, res);
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.body.error_code, 'AGENT_SESSION_NOT_FOUND');
    } finally {
      agentMessageService.processMessage = original;
    }
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
