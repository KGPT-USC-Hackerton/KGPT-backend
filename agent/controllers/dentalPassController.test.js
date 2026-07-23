/**
 * agent/controllers/dentalPassController.test.js
 * HTTP 요청 파싱/검증 + 에러코드→상태코드 매핑만 검증한다. 서비스는 monkey-patch로 격리.
 *
 * 실행: node agent/controllers/dentalPassController.test.js
 */

const assert = require('node:assert');
const { randomUUID } = require('crypto');

const { createDentalPass, revokeDentalPass, getPublicDentalPass } = require('./dentalPassController');
const dentalPassService = require('../services/dentalPassService');

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

function patch(obj, key, fn) {
  const original = obj[key];
  obj[key] = fn;
  return () => {
    obj[key] = original;
  };
}

async function run() {
  console.log('dentalPassController 테스트\n');

  const validSessionId = randomUUID();
  const validPassId = randomUUID();

  // -------------------- 생성: consent --------------------
  await test('consent 누락 시 400 DENTAL_PASS_CONSENT_REQUIRED', async () => {
    const req = { params: { sessionId: validSessionId }, body: {}, agentUser: { id: 1 } };
    const res = mockRes();
    await createDentalPass(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'DENTAL_PASS_CONSENT_REQUIRED');
  });

  await test('consent: false 시 400 DENTAL_PASS_CONSENT_REQUIRED', async () => {
    const req = { params: { sessionId: validSessionId }, body: { consent: false }, agentUser: { id: 1 } };
    const res = mockRes();
    await createDentalPass(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'DENTAL_PASS_CONSENT_REQUIRED');
  });

  await test('consent: "true"(문자열) 시 400 DENTAL_PASS_CONSENT_REQUIRED', async () => {
    const req = { params: { sessionId: validSessionId }, body: { consent: 'true' }, agentUser: { id: 1 } };
    const res = mockRes();
    await createDentalPass(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'DENTAL_PASS_CONSENT_REQUIRED');
  });

  // -------------------- 생성: unknown field --------------------
  await test('허용되지 않은 필드는 400 UNKNOWN_FIELD', async () => {
    const req = {
      params: { sessionId: validSessionId },
      body: { consent: true, user_id: 999 },
      agentUser: { id: 1 },
    };
    const res = mockRes();
    await createDentalPass(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD');
  });

  await test('session_id/token/token_hash/context_snapshot 등도 UNKNOWN_FIELD', async () => {
    for (const field of ['session_id', 'token', 'share_token_hash', 'context_snapshot']) {
      const req = {
        params: { sessionId: validSessionId },
        body: { consent: true, [field]: 'x' },
        agentUser: { id: 1 },
      };
      const res = mockRes();
      await createDentalPass(req, res);
      assert.strictEqual(res.statusCode, 400, field);
      assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD', field);
    }
  });

  // -------------------- 생성: sessionId 형식 --------------------
  await test('잘못된 sessionId UUID는 400 VALIDATION_ERROR', async () => {
    const req = { params: { sessionId: 'not-a-uuid' }, body: { consent: true }, agentUser: { id: 1 } };
    const res = mockRes();
    await createDentalPass(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  // -------------------- 생성: expires_in_hours 범위 --------------------
  await test('expires_in_hours가 허용 범위 밖이면 400 VALIDATION_ERROR', async () => {
    for (const value of [0, 169, 1.5, -1, '24']) {
      const req = {
        params: { sessionId: validSessionId },
        body: { consent: true, expires_in_hours: value },
        agentUser: { id: 1 },
      };
      const res = mockRes();
      await createDentalPass(req, res);
      assert.strictEqual(res.statusCode, 400, String(value));
      assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR', String(value));
    }
  });

  // -------------------- 생성: 정상 흐름 --------------------
  await test('정상 요청은 서비스를 호출하고 200을 반환한다(consent/expires_in_hours만 전달)', async () => {
    let calledWith = null;
    const restore = patch(dentalPassService, 'createDentalPass', async (args) => {
      calledWith = args;
      return { pass_id: 'p1', share_token: 'tok', share_path: '/api/dental-pass/tok', expires_at: 'x', status: 'active' };
    });
    try {
      const req = {
        params: { sessionId: validSessionId },
        body: { consent: true, expires_in_hours: 48 },
        agentUser: { id: 1 },
      };
      const res = mockRes();
      await createDentalPass(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(calledWith.sessionId, validSessionId);
      assert.strictEqual(calledWith.userId, 1);
      assert.strictEqual(calledWith.expiresInHours, 48);
    } finally {
      restore();
    }
  });

  await test('expires_in_hours 생략 시 기본값 24가 서비스로 전달된다', async () => {
    let calledWith = null;
    const restore = patch(dentalPassService, 'createDentalPass', async (args) => {
      calledWith = args;
      return { pass_id: 'p1', share_token: 'tok', share_path: '/api/dental-pass/tok', expires_at: 'x', status: 'active' };
    });
    try {
      const req = { params: { sessionId: validSessionId }, body: { consent: true }, agentUser: { id: 1 } };
      const res = mockRes();
      await createDentalPass(req, res);
      assert.strictEqual(calledWith.expiresInHours, 24);
    } finally {
      restore();
    }
  });

  // -------------------- 생성: 서비스 에러 매핑 --------------------
  await test('DentalPassError.code는 매핑 테이블대로 HTTP 상태로 변환된다(생성)', async () => {
    const cases = [
      ['AGENT_SESSION_NOT_FOUND', 404],
      ['AGENT_SESSION_NOT_READY', 409],
      ['AGENT_SESSION_EXPIRED', 410],
      ['AGENT_CONTEXT_INTEGRITY_ERROR', 500],
      ['ACTIVE_DENTAL_PASS_LIMIT_REACHED', 409],
    ];
    for (const [code, expectedStatus] of cases) {
      const restore = patch(dentalPassService, 'createDentalPass', async () => {
        const err = new Error('x');
        err.code = code;
        throw err;
      });
      try {
        const req = { params: { sessionId: validSessionId }, body: { consent: true }, agentUser: { id: 1 } };
        const res = mockRes();
        await createDentalPass(req, res);
        assert.strictEqual(res.statusCode, expectedStatus, code);
        assert.strictEqual(res.body.error_code, code, code);
      } finally {
        restore();
      }
    }
  });

  // -------------------- 철회 --------------------
  await test('잘못된 passId UUID는 400 VALIDATION_ERROR', async () => {
    const req = { params: { passId: 'not-a-uuid' }, agentUser: { id: 1 } };
    const res = mockRes();
    await revokeDentalPass(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  await test('정상 철회는 200과 서비스 결과를 반환한다', async () => {
    let calledWith = null;
    const restore = patch(dentalPassService, 'revokeDentalPass', async (args) => {
      calledWith = args;
      return { pass_id: validPassId, status: 'revoked' };
    });
    try {
      const req = { params: { passId: validPassId }, agentUser: { id: 1 } };
      const res = mockRes();
      await revokeDentalPass(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.data.status, 'revoked');
      assert.strictEqual(calledWith.passId, validPassId);
      assert.strictEqual(calledWith.userId, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.data, 'share_token'), false);
    } finally {
      restore();
    }
  });

  await test('미존재/비소유 Pass 철회는 404 DENTAL_PASS_NOT_FOUND', async () => {
    const restore = patch(dentalPassService, 'revokeDentalPass', async () => {
      const err = new Error('x');
      err.code = 'DENTAL_PASS_NOT_FOUND';
      throw err;
    });
    try {
      const req = { params: { passId: validPassId }, agentUser: { id: 1 } };
      const res = mockRes();
      await revokeDentalPass(req, res);
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.body.error_code, 'DENTAL_PASS_NOT_FOUND');
    } finally {
      restore();
    }
  });

  // -------------------- 공개 조회 --------------------
  await test('공개 조회는 req.agentUser 없이도 동작한다(Demo Auth 미요구)', async () => {
    const restore = patch(dentalPassService, 'getPublicDentalPass', async () => ({
      status: 'active',
      expires_at: 'x',
      summary: { schema_version: 'dental-pass-public-v1', images: [], survey: null, disclaimer: 'd' },
    }));
    try {
      const req = { params: { shareToken: 'a'.repeat(43) } }; // agentUser 없음
      const res = mockRes();
      await getPublicDentalPass(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
    } finally {
      restore();
    }
  });

  await test('공개 조회 응답에는 raw share_token, pass_id 등이 포함되지 않는다', async () => {
    const restore = patch(dentalPassService, 'getPublicDentalPass', async () => ({
      status: 'active',
      expires_at: 'x',
      summary: { schema_version: 'dental-pass-public-v1', images: [], survey: null, disclaimer: 'd' },
    }));
    try {
      const req = { params: { shareToken: 'a'.repeat(43) } };
      const res = mockRes();
      await getPublicDentalPass(req, res);
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes('pass_id'));
      assert.ok(!serialized.includes('share_token'));
    } finally {
      restore();
    }
  });

  await test('공개 조회 에러코드는 매핑 테이블대로 변환된다(미존재/철회/만료)', async () => {
    const cases = [
      ['DENTAL_PASS_NOT_FOUND', 404],
      ['DENTAL_PASS_REVOKED', 410],
      ['DENTAL_PASS_EXPIRED', 410],
    ];
    for (const [code, expectedStatus] of cases) {
      const restore = patch(dentalPassService, 'getPublicDentalPass', async () => {
        const err = new Error('x');
        err.code = code;
        throw err;
      });
      try {
        const req = { params: { shareToken: 'a'.repeat(43) } };
        const res = mockRes();
        await getPublicDentalPass(req, res);
        assert.strictEqual(res.statusCode, expectedStatus, code);
        assert.strictEqual(res.body.error_code, code, code);
      } finally {
        restore();
      }
    }
  });

  await test('공개 조회의 모든 실패 케이스(형식오류/미존재/draft/만료/철회/DB오류)는 요청 Token과 hash를 응답에 노출하지 않는다', async () => {
    const requestedToken = 'REQUESTED-RAW-TOKEN-VALUE-1234567890AB'; // 43자는 아니어도 됨(형식오류 케이스 포함 목적)
    const cases = [
      { code: 'DENTAL_PASS_NOT_FOUND' }, // 형식 오류/미존재/draft 전부 이 코드로 통일됨
      { code: 'DENTAL_PASS_EXPIRED' },
      { code: 'DENTAL_PASS_REVOKED' },
      { code: undefined }, // DB 오류 등 매핑되지 않은 예외 → 500 catch-all
    ];
    for (const { code } of cases) {
      const restore = patch(dentalPassService, 'getPublicDentalPass', async () => {
        const err = new Error('내부 DB 오류'); // 원본 SQL 에러 메시지를 흉내
        if (code) err.code = code;
        throw err;
      });
      try {
        const req = { params: { shareToken: requestedToken } };
        const res = mockRes();
        await getPublicDentalPass(req, res);
        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes(requestedToken), `code=${code}: 요청 Token이 응답에 노출되면 안 됩니다.`);
        assert.ok(!serialized.toLowerCase().includes('hash'), `code=${code}: hash 관련 필드가 응답에 노출되면 안 됩니다.`);
      } finally {
        restore();
      }
    }
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
