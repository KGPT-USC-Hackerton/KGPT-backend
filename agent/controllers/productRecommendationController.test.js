/**
 * agent/controllers/productRecommendationController.test.js
 * 실행: node agent/controllers/productRecommendationController.test.js
 */

const assert = require('node:assert');
const crypto = require('crypto');

const { getProductRecommendations } = require('./productRecommendationController');
const { computeContextHash } = require('../services/contextSnapshotService');
const { loadShopifyConfig } = require('../config/shopifyConfig');

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

const SESSION_ID = crypto.randomUUID();
const GID = (n) => `gid://shopify/ProductVariant/${n}`;

function buildSnapshot(answers = []) {
  return {
    schema_version: 'agent-context-v2',
    history_id: 'h1',
    survey_session_id: null,
    generated_at: '2026-07-23T00:00:00.000Z',
    images: [
      { position: 'upper', occlusion_status: 'normal', cavity_detected: false, cavity_locations: null, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
      { position: 'lower', occlusion_status: 'normal', cavity_detected: false, cavity_locations: null, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
      { position: 'front', occlusion_status: 'normal', cavity_detected: false, cavity_locations: null, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
    ],
    survey: { codebook_version: 'oral-health-questionnaire-v1', codebook_checksum: 'x'.repeat(64), answers },
    needs_clinical_followup: false,
    followup_reason_codes: [],
    initial_message: { text: 'ok', evidence: [] },
  };
}

function buildSession(overrides = {}) {
  const snapshot = overrides.context_snapshot || buildSnapshot();
  return {
    id: SESSION_ID,
    user_id: 1,
    status: 'ready',
    context_snapshot: snapshot,
    context_hash: computeContextHash(snapshot),
    expires_at: null,
    ...overrides,
  };
}

function deps(session, env = {}) {
  return {
    sessionRepository: { findByIdAndUser: async () => session },
    loadShopifyConfig: () => loadShopifyConfig(env),
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  };
}

const ALL_GIDS = {
  SHOPIFY_VARIANT_GID_TOOTHBRUSH_ULTRA_SOFT: GID(1),
  SHOPIFY_VARIANT_GID_TOOTHBRUSH_SOFT: GID(2),
  SHOPIFY_VARIANT_GID_TOOTHPASTE_FLUORIDE: GID(3),
  SHOPIFY_VARIANT_GID_TOOTHPASTE_SENSITIVE: GID(4),
  SHOPIFY_VARIANT_GID_FLOSS_TAPE: GID(5),
  SHOPIFY_VARIANT_GID_INTERDENTAL_STARTER: GID(6),
  SHOPIFY_VARIANT_GID_TONGUE_CLEANER: GID(7),
};

async function run() {
  console.log('productRecommendationController 테스트\n');

  await test('Shopify 설정이 전혀 없어도 추천이 정상 반환된다(하위 호환)', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, {}));

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.data.items.length > 0, '추천 배열을 비우면 안 된다');
    assert.strictEqual(res.body.data.shopify_cart_api_enabled, false);
    assert.strictEqual(res.body.data.all_recommended_variants_configured, false);
  });

  await test('shopify_checkout_enabled 라는 필드명은 사용하지 않는다', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, {}));
    assert.strictEqual('shopify_checkout_enabled' in res.body.data, false);
    assert.strictEqual('shopify_cart_api_enabled' in res.body.data, true);
  });

  await test('purchasable 대신 shopify_variant_configured 를 item 마다 포함한다', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, ALL_GIDS));

    for (const item of res.body.data.items) {
      assert.strictEqual('shopify_variant_configured' in item, true);
      assert.strictEqual('purchasable' in item, false);
      assert.strictEqual(item.shopify_variant_configured, true);
    }
  });

  await test('GID가 없으면 shopify_variant_configured=false 이지만 추천 자체는 유지된다', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, {}));

    assert.ok(res.body.data.items.length > 0);
    for (const item of res.body.data.items) {
      assert.strictEqual(item.shopify_variant_configured, false);
      // 추천 근거는 그대로 유지되어야 한다
      assert.ok(item.reason_code);
      assert.ok(item.display_name);
    }
  });

  await test('SHOPIFY_ENABLED=true 이고 전부 설정되면 all_recommended_variants_configured=true', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, { SHOPIFY_ENABLED: 'true', ...ALL_GIDS }));

    assert.strictEqual(res.body.data.shopify_cart_api_enabled, true);
    assert.strictEqual(res.body.data.all_recommended_variants_configured, true);
  });

  await test('일부 GID가 빠지면 all_recommended_variants_configured=false', async () => {
    const session = buildSession();
    const partial = { ...ALL_GIDS };
    delete partial.SHOPIFY_VARIANT_GID_TOOTHBRUSH_SOFT; // baseline 상품 제외
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, { SHOPIFY_ENABLED: 'true', ...partial }));

    assert.strictEqual(res.body.data.all_recommended_variants_configured, false);
  });

  await test('Shopify 설정 로딩이 실패해도 추천은 실패하지 않는다', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, {
      ...deps(session, {}),
      loadShopifyConfig: () => {
        throw new Error('SHOPIFY_INVALID_CONFIGURATION');
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.data.items.length > 0);
    assert.strictEqual(res.body.data.shopify_cart_api_enabled, false);
  });

  await test('proposal_hash 는 Shopify 설정 유무와 무관하게 동일하다', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };

    const resWithout = mockRes();
    await getProductRecommendations(req, resWithout, deps(session, {}));
    const resWith = mockRes();
    await getProductRecommendations(req, resWith, deps(session, { SHOPIFY_ENABLED: 'true', ...ALL_GIDS }));

    assert.strictEqual(resWithout.body.data.proposal_hash, resWith.body.data.proposal_hash);
  });

  // -------------------- Session 검증 --------------------

  await test('잘못된 sessionId UUID 는 400 VALIDATION_ERROR', async () => {
    const req = { params: { sessionId: 'not-a-uuid' }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(buildSession(), {}));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  await test('세션 미존재(또는 비소유)는 404 AGENT_SESSION_NOT_FOUND', async () => {
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, {
      ...deps(null, {}),
      sessionRepository: { findByIdAndUser: async () => null },
    });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error_code, 'AGENT_SESSION_NOT_FOUND');
  });

  await test('ready 아닌 세션은 409, 만료 세션은 410', async () => {
    const notReady = buildSession({ status: 'waiting_for_analysis' });
    const res1 = mockRes();
    await getProductRecommendations({ params: { sessionId: SESSION_ID }, agentUser: { id: 1 } }, res1, deps(notReady, {}));
    assert.strictEqual(res1.statusCode, 409);
    assert.strictEqual(res1.body.error_code, 'AGENT_SESSION_NOT_READY');

    const expired = buildSession({ expires_at: '2026-07-22T00:00:00.000Z' });
    const res2 = mockRes();
    await getProductRecommendations({ params: { sessionId: SESSION_ID }, agentUser: { id: 1 } }, res2, deps(expired, {}));
    assert.strictEqual(res2.statusCode, 410);
    assert.strictEqual(res2.body.error_code, 'AGENT_SESSION_EXPIRED');
  });

  await test('context_hash 불일치는 500 AGENT_CONTEXT_INTEGRITY_ERROR', async () => {
    const tampered = buildSession({ context_hash: 'f'.repeat(64) });
    const res = mockRes();
    await getProductRecommendations({ params: { sessionId: SESSION_ID }, agentUser: { id: 1 } }, res, deps(tampered, {}));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error_code, 'AGENT_CONTEXT_INTEGRITY_ERROR');
  });

  // -------------------- 민감정보 미노출 --------------------

  await test('응답에 실제 Variant GID / store domain / token 이 노출되지 않는다', async () => {
    const session = buildSession();
    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, {
      SHOPIFY_ENABLED: 'true',
      SHOPIFY_STORE_DOMAIN: 'secret-store.myshopify.com',
      SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'super-secret-token',
      ...ALL_GIDS,
    }));

    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('gid://shopify'));
    assert.ok(!serialized.includes('secret-store'));
    assert.ok(!serialized.includes('super-secret-token'));
  });

  await test('설문 응답 원문(question_code/answer_code)은 evidence 최소화 형태로만 존재한다', async () => {
    const session = buildSession({
      context_snapshot: buildSnapshot([{ question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' }]),
    });
    // context_hash 를 새 snapshot 에 맞춰 재계산
    session.context_hash = computeContextHash(session.context_snapshot);

    const req = { params: { sessionId: SESSION_ID }, agentUser: { id: 1 } };
    const res = mockRes();
    await getProductRecommendations(req, res, deps(session, {}));

    const serialized = JSON.stringify(res.body);
    // evidence 에는 구조화 코드만 들어간다(개인정보/DB id 없음)
    assert.ok(!serialized.includes('user_id'));
    assert.ok(!serialized.includes('survey_session_id'));
    assert.ok(!serialized.includes('history_id'));
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
