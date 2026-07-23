/**
 * agent/services/dentalPassService.test.js
 * DB/HTTP 없이 sessionRepository/dentalPassRepository/clock/token generator를
 * deps로 주입해 결정론적으로 검증한다.
 *
 * 실행: node agent/services/dentalPassService.test.js
 */

const assert = require('node:assert');
const crypto = require('crypto');

const {
  createDentalPass,
  revokeDentalPass,
  getPublicDentalPass,
  DentalPassError,
  MAX_ACTIVE_DENTAL_PASSES,
} = require('./dentalPassService');
const { ActiveDentalPassLimitError, DentalPassTokenCollisionError } = require('../repositories/dentalPassRepository');
const { hashShareToken } = require('../shared/dentalPassToken');
const { computeContextHash } = require('./contextSnapshotService');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✅ ${name}`);
    });
}

async function assertRejectsWithCode(promise, expectedCode) {
  try {
    await promise;
    assert.fail(`예외가 발생해야 합니다 (expected code: ${expectedCode})`);
  } catch (error) {
    assert.ok(error instanceof DentalPassError, `DentalPassError 여야 합니다: ${error}`);
    assert.strictEqual(error.code, expectedCode);
  }
}

function buildReadySession(overrides = {}) {
  const contextSnapshot = {
    history_id: 'history-1',
    survey_session_id: null,
    generated_at: '2026-07-22T00:00:00.000Z',
    images: [
      { position: 'upper', occlusion_status: 'normal', cavity_detected: false, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
      { position: 'lower', occlusion_status: 'normal', cavity_detected: false, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
      { position: 'front', occlusion_status: 'normal', cavity_detected: false, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
    ],
    survey: null,
  };
  const session = {
    id: crypto.randomUUID(),
    user_id: 1,
    history_id: 'history-1',
    survey_session_id: null,
    status: 'ready',
    context_snapshot: contextSnapshot,
    context_hash: computeContextHash(contextSnapshot),
    expires_at: null,
    ...overrides,
  };
  return session;
}

function mockSessionRepository(session) {
  return {
    findByIdAndUser: async () => session,
  };
}

function mockDentalPassRepositoryRecording() {
  const calls = [];
  return {
    calls,
    insertActivePassWithLimit: async (args) => {
      calls.push(args);
    },
  };
}

async function run() {
  console.log('dentalPassService 테스트\n');

  // -------------------- 생성: Session 검증 --------------------
  await test('세션이 없으면 AGENT_SESSION_NOT_FOUND', async () => {
    const sessionRepository = mockSessionRepository(null);
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'x', userId: 1, expiresInHours: 24 }, { sessionRepository }),
      'AGENT_SESSION_NOT_FOUND'
    );
  });

  await test('다른 사용자 세션(레포지토리가 null 반환)도 동일하게 AGENT_SESSION_NOT_FOUND', async () => {
    // findByIdAndUser 는 WHERE id=? AND user_id=? 이므로 비소유는 null과 동일하게 처리된다.
    const sessionRepository = { findByIdAndUser: async (id, userId) => (userId === 1 ? buildReadySession() : null) };
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'x', userId: 999, expiresInHours: 24 }, { sessionRepository }),
      'AGENT_SESSION_NOT_FOUND'
    );
  });

  await test('ready 상태가 아니면 AGENT_SESSION_NOT_READY', async () => {
    const sessionRepository = mockSessionRepository(buildReadySession({ status: 'waiting_for_analysis' }));
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'x', userId: 1, expiresInHours: 24 }, { sessionRepository }),
      'AGENT_SESSION_NOT_READY'
    );
  });

  await test('세션이 만료되었으면 AGENT_SESSION_EXPIRED', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const sessionRepository = mockSessionRepository(
      buildReadySession({ expires_at: '2026-07-21T00:00:00.000Z' })
    );
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'x', userId: 1, expiresInHours: 24 }, { sessionRepository, now }),
      'AGENT_SESSION_EXPIRED'
    );
  });

  await test('context_hash가 저장된 snapshot과 다르면 AGENT_CONTEXT_INTEGRITY_ERROR', async () => {
    const sessionRepository = mockSessionRepository(buildReadySession({ context_hash: 'tampered-hash' }));
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'x', userId: 1, expiresInHours: 24 }, { sessionRepository }),
      'AGENT_CONTEXT_INTEGRITY_ERROR'
    );
  });

  await test('context_snapshot 또는 context_hash가 없으면 AGENT_CONTEXT_INTEGRITY_ERROR', async () => {
    const sessionRepository = mockSessionRepository(buildReadySession({ context_snapshot: null }));
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'x', userId: 1, expiresInHours: 24 }, { sessionRepository }),
      'AGENT_CONTEXT_INTEGRITY_ERROR'
    );
  });

  // -------------------- 생성: 정상 흐름 --------------------
  await test('정상 생성 시 pass_id/share_token/share_path/expires_at/status를 반환한다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const sessionRepository = mockSessionRepository(buildReadySession());
    const dentalPassRepository = mockDentalPassRepositoryRecording();

    const result = await createDentalPass(
      { sessionId: 'session-1', userId: 1, expiresInHours: 24 },
      { sessionRepository, dentalPassRepository, now }
    );

    assert.strictEqual(typeof result.pass_id, 'string');
    assert.strictEqual(typeof result.share_token, 'string');
    assert.strictEqual(result.share_path, `/api/dental-pass/${result.share_token}`);
    assert.strictEqual(result.expires_at, '2026-07-23T00:00:00.000Z');
    assert.strictEqual(result.status, 'active');
  });

  await test('expires_in_hours 기본값(24)/최솟값(1)/최댓값(168)에 맞춰 expires_at을 계산한다', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const sessionRepository = mockSessionRepository(buildReadySession());

    for (const [hours, expected] of [
      [24, '2026-01-02T00:00:00.000Z'],
      [1, '2026-01-01T01:00:00.000Z'],
      [168, '2026-01-08T00:00:00.000Z'],
    ]) {
      const dentalPassRepository = mockDentalPassRepositoryRecording();
      const result = await createDentalPass(
        { sessionId: 'session-1', userId: 1, expiresInHours: hours },
        { sessionRepository, dentalPassRepository, now }
      );
      assert.strictEqual(result.expires_at, expected, `hours=${hours}`);
    }
  });

  await test('DB에는 hash만 저장되고 원문 Token은 저장 인자에 없다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const sessionRepository = mockSessionRepository(buildReadySession());
    const dentalPassRepository = mockDentalPassRepositoryRecording();

    const result = await createDentalPass(
      { sessionId: 'session-1', userId: 1, expiresInHours: 24 },
      { sessionRepository, dentalPassRepository, now }
    );

    assert.strictEqual(dentalPassRepository.calls.length, 1);
    const storedArgs = dentalPassRepository.calls[0];
    assert.strictEqual(storedArgs.shareTokenHash, hashShareToken(result.share_token));
    assert.strictEqual(storedArgs.shareTokenHash.length, 64);
    const serializedArgs = JSON.stringify(storedArgs);
    assert.ok(!serializedArgs.includes(result.share_token), '저장 인자에 원문 Token이 섞이면 안 됩니다.');
  });

  await test('생성 결과의 findings_json(공개 Snapshot)에 schema_version이 포함된다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const sessionRepository = mockSessionRepository(buildReadySession());
    const dentalPassRepository = mockDentalPassRepositoryRecording();

    await createDentalPass(
      { sessionId: 'session-1', userId: 1, expiresInHours: 24 },
      { sessionRepository, dentalPassRepository, now }
    );

    assert.strictEqual(dentalPassRepository.calls[0].findingsJson.schema_version, 'dental-pass-public-v1');
  });

  // -------------------- 생성: 활성 Pass 개수 제한 --------------------
  await test('레포지토리가 개수 제한 초과를 알리면 ACTIVE_DENTAL_PASS_LIMIT_REACHED로 변환한다', async () => {
    const sessionRepository = mockSessionRepository(buildReadySession());
    const dentalPassRepository = {
      insertActivePassWithLimit: async () => {
        throw new ActiveDentalPassLimitError();
      },
    };
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'session-1', userId: 1, expiresInHours: 24 }, { sessionRepository, dentalPassRepository }),
      'ACTIVE_DENTAL_PASS_LIMIT_REACHED'
    );
  });

  await test(`MAX_ACTIVE_DENTAL_PASSES 는 3이다`, () => {
    assert.strictEqual(MAX_ACTIVE_DENTAL_PASSES, 3);
  });

  // -------------------- 생성: Token 해시 충돌 재시도 --------------------
  await test('share_token_hash 충돌 시 최대 시도 안에서 새 토큰으로 재시도해 성공한다', async () => {
    const sessionRepository = mockSessionRepository(buildReadySession());
    let attempts = 0;
    const dentalPassRepository = {
      insertActivePassWithLimit: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new DentalPassTokenCollisionError();
        }
      },
    };
    const seenTokens = new Set();
    const generateShareToken = () => {
      const token = `token-${attempts}-${Math.random()}`;
      seenTokens.add(token);
      return token;
    };

    const result = await createDentalPass(
      { sessionId: 'session-1', userId: 1, expiresInHours: 24 },
      { sessionRepository, dentalPassRepository, generateShareToken }
    );

    assert.strictEqual(attempts, 3);
    assert.strictEqual(result.status, 'active');
  });

  await test('재시도 한도를 초과하면 DENTAL_PASS_CREATE_FAILED', async () => {
    const sessionRepository = mockSessionRepository(buildReadySession());
    const dentalPassRepository = {
      insertActivePassWithLimit: async () => {
        throw new DentalPassTokenCollisionError();
      },
    };
    await assertRejectsWithCode(
      createDentalPass({ sessionId: 'session-1', userId: 1, expiresInHours: 24 }, { sessionRepository, dentalPassRepository }),
      'DENTAL_PASS_CREATE_FAILED'
    );
  });

  // -------------------- 철회 --------------------
  await test('정상 철회 시 status: revoked를 반환한다', async () => {
    const dentalPassRepository = {
      revokeOwnedPass: async (passId, userId) => ({ id: passId, status: 'revoked' }),
    };
    const result = await revokeDentalPass({ passId: 'pass-1', userId: 1 }, { dentalPassRepository });
    assert.deepStrictEqual(result, { pass_id: 'pass-1', status: 'revoked' });
  });

  await test('미존재 또는 비소유 Pass 철회는 DENTAL_PASS_NOT_FOUND', async () => {
    const dentalPassRepository = { revokeOwnedPass: async () => null };
    await assertRejectsWithCode(
      revokeDentalPass({ passId: 'pass-1', userId: 1 }, { dentalPassRepository }),
      'DENTAL_PASS_NOT_FOUND'
    );
  });

  await test('이미 철회된 Pass를 다시 철회해도 idempotent하게 성공한다', async () => {
    let calls = 0;
    const dentalPassRepository = {
      revokeOwnedPass: async () => {
        calls += 1;
        return { id: 'pass-1', status: 'revoked' }; // repository가 이미 idempotent 하게 처리
      },
    };
    const r1 = await revokeDentalPass({ passId: 'pass-1', userId: 1 }, { dentalPassRepository });
    const r2 = await revokeDentalPass({ passId: 'pass-1', userId: 1 }, { dentalPassRepository });
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(r1, { pass_id: 'pass-1', status: 'revoked' });
    assert.deepStrictEqual(r2, { pass_id: 'pass-1', status: 'revoked' });
  });

  // -------------------- 공개 조회 --------------------
  await test('형식이 잘못된 Token은 DB 조회 없이 DENTAL_PASS_NOT_FOUND', async () => {
    let dbCalled = false;
    const dentalPassRepository = { findByTokenHash: async () => { dbCalled = true; return null; } };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'not-valid' }, { dentalPassRepository }),
      'DENTAL_PASS_NOT_FOUND'
    );
    assert.strictEqual(dbCalled, false);
  });

  await test('존재하지 않는 Token은 DENTAL_PASS_NOT_FOUND', async () => {
    const dentalPassRepository = { findByTokenHash: async () => null };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository }),
      'DENTAL_PASS_NOT_FOUND'
    );
  });

  await test('draft 상태 Token은 공개 노출 대신 DENTAL_PASS_NOT_FOUND', async () => {
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'draft',
        expires_at: '2999-01-01T00:00:00.000Z',
        findings_json: { schema_version: 'dental-pass-public-v1', images: [], survey: null, disclaimer: 'x' },
      }),
    };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository }),
      'DENTAL_PASS_NOT_FOUND'
    );
  });

  await test('철회된 Token은 DENTAL_PASS_REVOKED', async () => {
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'revoked',
        expires_at: '2999-01-01T00:00:00.000Z',
        findings_json: {},
      }),
    };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository }),
      'DENTAL_PASS_REVOKED'
    );
  });

  await test('만료된 Token은 DENTAL_PASS_EXPIRED', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: '2026-07-21T00:00:00.000Z',
        findings_json: {},
      }),
    };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now }),
      'DENTAL_PASS_EXPIRED'
    );
  });

  await test('경계값: expires_at === now (정확히 같은 ms) 이면 DENTAL_PASS_EXPIRED', async () => {
    const boundary = '2026-07-22T00:00:00.000Z';
    const now = () => new Date(boundary);
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: boundary,
        findings_json: {},
      }),
    };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now }),
      'DENTAL_PASS_EXPIRED'
    );
  });

  await test('경계값: expires_at 이 now 보다 1ms라도 미래이면 아직 활성이다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: '2026-07-22T00:00:00.001Z', // now 보다 정확히 1ms 뒤
        findings_json: { schema_version: 'dental-pass-public-v1', images: [], survey: null, disclaimer: 'x' },
      }),
    };
    const result = await getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now });
    assert.strictEqual(result.status, 'active');
  });

  await test('DB TIMESTAMP(6)가 마이크로초까지 갖고 있어도(문자열) ms 단위로 안전하게 비교한다', async () => {
    // mysql2 는 TIMESTAMP(6) 컬럼을 JS Date(ms 정밀도)로 반환하지만, 방어적으로
    // 마이크로초 문자열이 들어와도 Date 파싱이 깨지지 않는지 확인한다.
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: '2026-07-22T00:00:00.000001Z', // ms 이후 마이크로초 — Date는 ms까지만 파싱
        findings_json: {},
      }),
    };
    // ms 단위로는 now와 동일하므로 만료로 처리된다(마이크로초는 신뢰하지 않음).
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now }),
      'DENTAL_PASS_EXPIRED'
    );
  });

  await test('revoked 이면서 동시에 expires_at 이 과거(expired)여도 DENTAL_PASS_REVOKED가 우선한다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'revoked',
        expires_at: '2020-01-01T00:00:00.000Z', // 이미 오래 전 만료
        findings_json: {},
      }),
    };
    await assertRejectsWithCode(
      getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now }),
      'DENTAL_PASS_REVOKED'
    );
  });

  await test('활성이고 미만료인 Token은 status/expires_at/summary(Allowlist)를 반환한다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const findingsJson = { schema_version: 'dental-pass-public-v1', images: [], survey: null, disclaimer: 'x' };
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: '2026-07-23T00:00:00.000Z',
        findings_json: findingsJson,
      }),
    };
    const result = await getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now });
    assert.deepStrictEqual(result, {
      status: 'active',
      expires_at: '2026-07-23T00:00:00.000Z',
      summary: findingsJson,
    });
  });

  await test('공개 조회 결과에는 user_id/session_id/token_hash가 포함되지 않는다', async () => {
    const now = () => new Date('2026-07-22T00:00:00.000Z');
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: '2026-07-23T00:00:00.000Z',
        findings_json: { schema_version: 'dental-pass-public-v1', images: [], survey: null, disclaimer: 'x' },
      }),
    };
    const result = await getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository, now });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('user_id'));
    assert.ok(!serialized.includes('session_id'));
    assert.ok(!serialized.includes('token_hash'));
  });

  await test('공개 조회는 sessionRepository/Context Snapshot을 전혀 사용하지 않는다', async () => {
    // getPublicDentalPass 는 dentalPassRepository 만 인자로 받는다 — 구조적으로
    // agent_sessions/context_snapshot 을 재조회하거나 변경할 수 없다.
    const dentalPassRepository = {
      findByTokenHash: async () => ({
        status: 'active',
        expires_at: '2999-01-01T00:00:00.000Z',
        findings_json: {},
      }),
    };
    const result = await getPublicDentalPass({ shareToken: 'a'.repeat(43) }, { dentalPassRepository });
    assert.strictEqual(typeof result, 'object');
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
