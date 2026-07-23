/**
 * agent/services/shopifyCartService.test.js
 * fake repository/adapter + 주입 clock 만 사용한다. 실제 DB/Shopify 호출 0회,
 * 실제 sleep 0회(모든 lease 판정은 주입한 시각으로만 시뮬레이션).
 *
 * 실행: node agent/services/shopifyCartService.test.js
 */

const assert = require('node:assert');
const crypto = require('crypto');

const { createShopifyCart, ShopifyCartError, cartLinesMatchRequest, buildResultFromRow } = require('./shopifyCartService');
const { computeContextHash } = require('./contextSnapshotService');
const { recommendProducts } = require('./productRecommendationService');
const { loadShopifyConfig } = require('../config/shopifyConfig');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✅ ${name}`);
    });
}

const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const SESSION_ID = crypto.randomUUID();
const USER_ID = 1;
const FIXED_NOW = new Date('2026-07-23T00:00:00.000Z');

// SHOPIFY_ENABLED=true + 7개 GID 전부 설정된 테스트용 config
function testConfig(overrides = {}) {
  return loadShopifyConfig({
    SHOPIFY_ENABLED: 'true',
    SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
    SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'test-token',
    SHOPIFY_VARIANT_GID_TOOTHBRUSH_ULTRA_SOFT: GID(1),
    SHOPIFY_VARIANT_GID_TOOTHBRUSH_SOFT: GID(2),
    SHOPIFY_VARIANT_GID_TOOTHPASTE_FLUORIDE: GID(3),
    SHOPIFY_VARIANT_GID_TOOTHPASTE_SENSITIVE: GID(4),
    SHOPIFY_VARIANT_GID_FLOSS_TAPE: GID(5),
    SHOPIFY_VARIANT_GID_INTERDENTAL_STARTER: GID(6),
    SHOPIFY_VARIANT_GID_TONGUE_CLEANER: GID(7),
    ...overrides,
  });
}

function buildContextSnapshot() {
  return {
    schema_version: 'agent-context-v2',
    history_id: 'h1',
    survey_session_id: null,
    generated_at: FIXED_NOW.toISOString(),
    images: [
      { position: 'upper', occlusion_status: 'normal', cavity_detected: false, cavity_locations: null, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
      { position: 'lower', occlusion_status: 'normal', cavity_detected: false, cavity_locations: null, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
      { position: 'front', occlusion_status: 'normal', cavity_detected: false, cavity_locations: null, overall_score: 9, recommendations: 'ok', ai_confidence: 0.9, llm_summary: null },
    ],
    survey: { codebook_version: 'oral-health-questionnaire-v1', codebook_checksum: 'x'.repeat(64), answers: [] },
    needs_clinical_followup: false,
    followup_reason_codes: [],
    initial_message: { text: 'ok', evidence: [] },
  };
}

function buildSession(overrides = {}) {
  const contextSnapshot = buildContextSnapshot();
  return {
    id: SESSION_ID,
    user_id: USER_ID,
    status: 'ready',
    context_snapshot: contextSnapshot,
    context_hash: computeContextHash(contextSnapshot),
    expires_at: null,
    ...overrides,
  };
}

function sessionRepositoryFor(session) {
  return { findByIdAndUser: async () => session };
}

// 실제 추천 결과에서 proposal_hash 와 선택 가능한 첫 상품을 얻는다.
function currentRecommendation(session) {
  return recommendProducts({
    sessionId: SESSION_ID,
    contextHash: session.context_hash,
    contextSnapshot: session.context_snapshot,
  });
}

/**
 * 메모리 기반 fake repository. 실제 SQL 의 조건부 UPDATE 의미(WHERE status='pending')를
 * 그대로 흉내내 affectedRows 를 반환한다.
 */
function fakeCartRepository(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.id, { ...r }]));
  const byIdempotency = new Map(initialRows.map((r) => [`${r.user_id}:${r.idempotency_key_hash}`, r.id]));
  const calls = { insert: 0, markExternalCallStarted: 0, markSucceeded: 0, markTerminalError: 0 };

  const repo = {
    rows,
    calls,
    async insertPendingClaim({ id, userId, sessionId, idempotencyKeyHash, requestHash, proposalHash, shopifyConfigFingerprint, selectedItems, now }) {
      calls.insert += 1;
      const key = `${userId}:${idempotencyKeyHash}`;
      if (byIdempotency.has(key)) {
        const error = new Error('duplicate');
        error.code = 'SHOPIFY_CART_CLAIM_CONFLICT';
        error.existingRow = rows.get(byIdempotency.get(key));
        throw error;
      }
      const row = {
        id, user_id: userId, session_id: sessionId, idempotency_key_hash: idempotencyKeyHash,
        request_hash: requestHash, proposal_hash: proposalHash, shopify_config_fingerprint: shopifyConfigFingerprint,
        selected_items_json: selectedItems, status: 'pending', attempt_count: 0,
        shopify_cart_id: null, checkout_url: null,
        estimated_total_amount: null, estimated_total_currency_code: null, estimated_total_is_estimated: null,
        warning_codes_json: null, normalized_error_code: null, normalized_http_status: null, safe_error_details_json: null,
        external_call_started_at: null, completed_at: null, created_at: now, updated_at: now,
      };
      rows.set(id, row);
      byIdempotency.set(key, id);
      return { claimed: true, id };
    },
    async findById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async findByIdempotency(userId, hash) {
      const id = byIdempotency.get(`${userId}:${hash}`);
      return id ? { ...rows.get(id) } : null;
    },
    async markExternalCallStarted({ id, now }) {
      calls.markExternalCallStarted += 1;
      const row = rows.get(id);
      if (!row || row.status !== 'pending' || row.external_call_started_at !== null || row.attempt_count !== 0) return 0;
      row.external_call_started_at = now;
      row.attempt_count = 1;
      row.updated_at = now;
      return 1;
    },
    async markSucceeded({ id, shopifyCartId, checkoutUrl, estimatedTotalAmount, estimatedTotalCurrencyCode, estimatedTotalIsEstimated, warningCodes, now }) {
      calls.markSucceeded += 1;
      const row = rows.get(id);
      if (!row || row.status !== 'pending') return 0;
      Object.assign(row, {
        status: 'succeeded', shopify_cart_id: shopifyCartId, checkout_url: checkoutUrl,
        estimated_total_amount: estimatedTotalAmount, estimated_total_currency_code: estimatedTotalCurrencyCode,
        estimated_total_is_estimated: estimatedTotalIsEstimated ? 1 : 0,
        warning_codes_json: warningCodes || [], normalized_error_code: null, normalized_http_status: null,
        safe_error_details_json: null, completed_at: now, updated_at: now,
      });
      return 1;
    },
    async markTerminalError({ id, status, normalizedErrorCode, normalizedHttpStatus, safeErrorDetails, now }) {
      calls.markTerminalError += 1;
      const row = rows.get(id);
      if (!row || row.status !== 'pending') return 0;
      Object.assign(row, {
        status, normalized_error_code: normalizedErrorCode, normalized_http_status: normalizedHttpStatus,
        safe_error_details_json: safeErrorDetails || null, shopify_cart_id: null, checkout_url: null,
        estimated_total_amount: null, estimated_total_currency_code: null, estimated_total_is_estimated: null,
        warning_codes_json: null, completed_at: now, updated_at: now,
      });
      return 1;
    },
    async expireStaleBeforeDispatch({ id, beforeDispatchCutoff, now }) {
      const row = rows.get(id);
      if (!row || row.status !== 'pending' || row.external_call_started_at !== null) return 0;
      if (!(new Date(row.created_at) < new Date(beforeDispatchCutoff))) return 0;
      Object.assign(row, {
        status: 'failed', normalized_error_code: 'SHOPIFY_CART_ABORTED_BEFORE_DISPATCH',
        normalized_http_status: 503, completed_at: now, updated_at: now,
      });
      return 1;
    },
    async expireStaleAfterDispatch({ id, afterDispatchCutoff, now }) {
      const row = rows.get(id);
      if (!row || row.status !== 'pending' || row.external_call_started_at === null) return 0;
      if (!(new Date(row.external_call_started_at) < new Date(afterDispatchCutoff))) return 0;
      Object.assign(row, {
        status: 'outcome_unknown', normalized_error_code: 'SHOPIFY_CART_OUTCOME_UNKNOWN',
        normalized_http_status: 502, completed_at: now, updated_at: now,
      });
      return 1;
    },
  };
  return repo;
}

function successAdapter(overrides = {}) {
  const calls = { createCart: 0 };
  return {
    calls,
    async createCart({ lines }) {
      calls.createCart += 1;
      return {
        outcome: 'succeeded',
        httpStatus: 200,
        errorCode: null,
        safeErrorDetails: null,
        warningCodes: [],
        cart: {
          id: 'gid://shopify/Cart/abc',
          checkoutUrl: 'https://demo-store.myshopify.com/checkout/abc',
          lines: lines.map((l) => ({ quantity: l.quantity, merchandiseId: l.merchandiseId })),
          totalAmount: '18.97',
          totalCurrencyCode: 'USD',
          totalAmountEstimated: true,
          ...overrides.cart,
        },
      };
    },
  };
}

async function callCreate({ session, repo, adapter, config, now = () => FIXED_NOW, items, proposalHash, idempotencyKeyHash = 'hash-1', generateId }) {
  const rec = currentRecommendation(session);
  return createShopifyCart(
    {
      sessionId: SESSION_ID,
      userId: USER_ID,
      proposalHash: proposalHash || rec.proposal_hash,
      items: items || [{ product_key: rec.items[0].product_key, quantity: 1 }],
      idempotencyKeyHash,
    },
    {
      sessionRepository: sessionRepositoryFor(session),
      cartRepository: repo,
      adapter,
      config: config || testConfig(),
      now,
      generateId: generateId || (() => 'cart-req-1'),
    }
  );
}

async function assertRejectsWithCode(promise, code) {
  try {
    await promise;
    assert.fail(`예외가 발생해야 합니다: ${code}`);
  } catch (error) {
    assert.ok(error instanceof ShopifyCartError, `ShopifyCartError 여야 합니다: ${error}`);
    assert.strictEqual(error.code, code);
  }
}

async function run() {
  console.log('shopifyCartService 테스트\n');

  // -------------------- 정상 흐름 --------------------

  await test('정상 요청은 cartCreate 1회 후 succeeded 결과를 반환한다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    const result = await callCreate({ session, repo, adapter });

    assert.strictEqual(result.httpStatus, 200);
    assert.strictEqual(result.body.status, 'succeeded');
    assert.strictEqual(result.body.checkout_url, 'https://demo-store.myshopify.com/checkout/abc');
    assert.deepStrictEqual(result.body.estimated_cart_total, { amount: '18.97', currency_code: 'USD', is_estimated: true });
    assert.match(result.body.pricing_disclaimer, /Estimated cart pricing/);
    assert.strictEqual(adapter.calls.createCart, 1);
  });

  await test('성공 시 attempt_count=1 이고 금액/통화/estimated flag 가 저장된다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    await callCreate({ session, repo, adapter: successAdapter() });

    const row = repo.rows.get('cart-req-1');
    assert.strictEqual(row.status, 'succeeded');
    assert.strictEqual(row.attempt_count, 1);
    assert.strictEqual(row.estimated_total_amount, '18.97');
    assert.strictEqual(row.estimated_total_currency_code, 'USD');
    assert.strictEqual(row.estimated_total_is_estimated, 1);
    assert.strictEqual(row.completed_at, FIXED_NOW);
    assert.strictEqual(row.normalized_error_code, null);
    assert.strictEqual(row.normalized_http_status, null);
    assert.strictEqual(row.safe_error_details_json, null);
  });

  await test('external_call_started_at 이 Shopify 호출 전에 기록된다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    let startedAtWhenCalled = null;
    const adapter = {
      calls: { createCart: 0 },
      async createCart({ lines }) {
        this.calls.createCart += 1;
        startedAtWhenCalled = repo.rows.get('cart-req-1').external_call_started_at;
        return successAdapter().createCart({ lines });
      },
    };
    await callCreate({ session, repo, adapter });
    assert.strictEqual(startedAtWhenCalled, FIXED_NOW, 'fetch 시점에 이미 기록돼 있어야 한다');
  });

  // -------------------- 사전 검증(claim 이전) --------------------

  await test('SHOPIFY_ENABLED=false 면 DB 행 생성 없이 SHOPIFY_NOT_CONFIGURED', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    await assertRejectsWithCode(
      callCreate({ session, repo, adapter, config: testConfig({ SHOPIFY_ENABLED: 'false' }) }),
      'SHOPIFY_NOT_CONFIGURED'
    );
    assert.strictEqual(repo.calls.insert, 0, 'DB 행을 만들면 안 된다');
    assert.strictEqual(adapter.calls.createCart, 0);
  });

  await test('선택 상품의 Variant GID 가 없으면 503 PRODUCT_VARIANT_NOT_CONFIGURED (호출 0회)', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    const rec = currentRecommendation(session);
    // 추천된 상품의 GID 만 비운 config
    const configWithoutGid = testConfig({ [`SHOPIFY_VARIANT_GID_${rec.items[0].product_key}`]: '' });

    try {
      await callCreate({ session, repo, adapter, config: configWithoutGid });
      assert.fail('예외가 발생해야 합니다');
    } catch (error) {
      assert.strictEqual(error.code, 'PRODUCT_VARIANT_NOT_CONFIGURED');
      assert.strictEqual(error.httpStatus, 503);
    }
    assert.strictEqual(repo.calls.insert, 0);
    assert.strictEqual(adapter.calls.createCart, 0);
  });

  await test('proposal_hash 불일치는 409 PRODUCT_PROPOSAL_STALE (호출 0회)', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    try {
      await callCreate({ session, repo, adapter, proposalHash: 'f'.repeat(64) });
      assert.fail('예외가 발생해야 합니다');
    } catch (error) {
      assert.strictEqual(error.code, 'PRODUCT_PROPOSAL_STALE');
      assert.strictEqual(error.httpStatus, 409);
    }
    assert.strictEqual(adapter.calls.createCart, 0);
  });

  await test('추천에 없는 상품은 PRODUCT_NOT_RECOMMENDED (호출 0회)', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    await assertRejectsWithCode(
      callCreate({ session, repo, adapter, items: [{ product_key: 'TONGUE_CLEANER', quantity: 1 }] }),
      'PRODUCT_NOT_RECOMMENDED'
    );
    assert.strictEqual(adapter.calls.createCart, 0);
  });

  await test('수량 범위 초과/중복 product_key 는 거부된다', async () => {
    const session = buildSession();
    const rec = currentRecommendation(session);
    const key = rec.items[0].product_key;

    await assertRejectsWithCode(
      callCreate({ session, repo: fakeCartRepository(), adapter: successAdapter(), items: [{ product_key: key, quantity: 99 }] }),
      'INVALID_PRODUCT_QUANTITY'
    );
    await assertRejectsWithCode(
      callCreate({
        session, repo: fakeCartRepository(), adapter: successAdapter(),
        items: [{ product_key: key, quantity: 1 }, { product_key: key, quantity: 1 }],
      }),
      'VALIDATION_ERROR'
    );
  });

  await test('Session 소유권/상태/무결성 검증이 Shopify 호출 이전에 수행된다', async () => {
    const adapter = successAdapter();
    await assertRejectsWithCode(
      createShopifyCart(
        { sessionId: SESSION_ID, userId: USER_ID, proposalHash: 'a'.repeat(64), items: [{ product_key: 'FLOSS_TAPE', quantity: 1 }], idempotencyKeyHash: 'h' },
        { sessionRepository: { findByIdAndUser: async () => null }, cartRepository: fakeCartRepository(), adapter, config: testConfig(), now: () => FIXED_NOW }
      ),
      'AGENT_SESSION_NOT_FOUND'
    );
    assert.strictEqual(adapter.calls.createCart, 0);
  });

  // -------------------- Idempotency 재현 --------------------

  await test('같은 Key + 같은 request_hash + succeeded → Shopify 재호출 0회로 결과 재현', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();

    const first = await callCreate({ session, repo, adapter });
    const second = await callCreate({ session, repo, adapter, generateId: () => 'cart-req-2' });

    assert.strictEqual(adapter.calls.createCart, 1, 'Shopify 는 한 번만 호출돼야 한다');
    assert.deepStrictEqual(second.body.estimated_cart_total, first.body.estimated_cart_total);
    assert.strictEqual(second.body.checkout_url, first.body.checkout_url);
    assert.strictEqual(second.body.status, 'succeeded');
  });

  await test('같은 Key + 다른 request_hash → 409 IDEMPOTENCY_KEY_CONFLICT (호출 0회)', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    const rec = currentRecommendation(session);

    await callCreate({ session, repo, adapter, items: [{ product_key: rec.items[0].product_key, quantity: 1 }] });
    const callsAfterFirst = adapter.calls.createCart;

    // 같은 Idempotency-Key 로 수량만 다르게 요청
    await assertRejectsWithCode(
      callCreate({ session, repo, adapter, items: [{ product_key: rec.items[0].product_key, quantity: 2 }], generateId: () => 'cart-req-2' }),
      'IDEMPOTENCY_KEY_CONFLICT'
    );
    assert.strictEqual(adapter.calls.createCart, callsAfterFirst, '충돌 시 Shopify 호출 없음');
  });

  await test('Variant Mapping 이 바뀌면 같은 Key 라도 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();

    await callCreate({ session, repo, adapter });
    // 같은 상품이지만 GID 만 다른 config → shopify_config_fingerprint 가 달라진다
    const rec = currentRecommendation(session);
    const changedConfig = testConfig({ [`SHOPIFY_VARIANT_GID_${rec.items[0].product_key}`]: GID(999) });

    await assertRejectsWithCode(
      callCreate({ session, repo, adapter, config: changedConfig, generateId: () => 'cart-req-2' }),
      'IDEMPOTENCY_KEY_CONFLICT'
    );
  });

  await test('failed 결과는 저장된 정규화 오류로 동일하게 재현된다(재호출 0회)', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const failingAdapter = {
      calls: { createCart: 0 },
      async createCart() {
        this.calls.createCart += 1;
        return {
          outcome: 'failed', httpStatus: 200, errorCode: 'SHOPIFY_USER_ERROR',
          safeErrorDetails: { category: 'CART_INPUT', field_codes: ['LINES_0_MERCHANDISE_ID'] },
          warningCodes: [], cart: null,
        };
      },
    };

    const first = await callCreate({ session, repo, adapter: failingAdapter });
    assert.strictEqual(first.error.code, 'SHOPIFY_USER_ERROR');
    assert.strictEqual(first.httpStatus, 422);

    const second = await callCreate({ session, repo, adapter: failingAdapter, generateId: () => 'cart-req-2' });
    assert.strictEqual(failingAdapter.calls.createCart, 1);
    assert.strictEqual(second.error.code, 'SHOPIFY_USER_ERROR');
    assert.strictEqual(second.httpStatus, 422);
  });

  await test('outcome_unknown 결과도 재호출 없이 재현되고 checkout_url 을 만들지 않는다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const timeoutAdapter = {
      calls: { createCart: 0 },
      async createCart() {
        this.calls.createCart += 1;
        return {
          outcome: 'outcome_unknown', httpStatus: null, errorCode: 'SHOPIFY_TIMEOUT',
          safeErrorDetails: { category: 'TIMEOUT' }, warningCodes: [], cart: null,
        };
      },
    };

    const first = await callCreate({ session, repo, adapter: timeoutAdapter });
    assert.strictEqual(first.httpStatus, 502);
    assert.strictEqual(first.error.code, 'SHOPIFY_TIMEOUT');
    assert.ok(!JSON.stringify(first).includes('checkout'));

    const second = await callCreate({ session, repo, adapter: timeoutAdapter, generateId: () => 'cart-req-2' });
    assert.strictEqual(timeoutAdapter.calls.createCart, 1, 'Mutation 재호출 금지');
    assert.strictEqual(second.error.code, 'SHOPIFY_TIMEOUT');

    const row = repo.rows.get('cart-req-1');
    assert.strictEqual(row.status, 'outcome_unknown');
    assert.strictEqual(row.checkout_url, null);
    assert.strictEqual(row.estimated_total_amount, null);
  });

  // -------------------- 동시성 --------------------

  await test('동시 같은 Key 요청에서도 cartCreate 는 정확히 1회만 실행된다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();

    const results = await Promise.allSettled([
      callCreate({ session, repo, adapter, generateId: () => 'cart-req-A' }),
      callCreate({ session, repo, adapter, generateId: () => 'cart-req-B' }),
      callCreate({ session, repo, adapter, generateId: () => 'cart-req-C' }),
    ]);

    assert.strictEqual(adapter.calls.createCart, 1, `cartCreate 호출 횟수: ${adapter.calls.createCart}`);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1);
  });

  await test('dispatch claim 이 실패(affectedRows=0)하면 Shopify 를 호출하지 않는다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    // 다른 주체가 이미 상태를 바꿔버린 상황을 시뮬레이션
    repo.markExternalCallStarted = async ({ id }) => {
      const row = repo.rows.get(id);
      row.status = 'outcome_unknown';
      row.normalized_error_code = 'SHOPIFY_CART_OUTCOME_UNKNOWN';
      row.normalized_http_status = 502;
      return 0;
    };

    const result = await callCreate({ session, repo, adapter });
    assert.strictEqual(adapter.calls.createCart, 0, 'claim 실패 시 호출 금지');
    assert.strictEqual(result.error.code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
  });

  // -------------------- stale pending (주입 clock 만 사용, 실제 sleep 없음) --------------------

  await test('stale A(호출 전, created_at 기준)는 failed 로 전이되고 Shopify 를 호출하지 않는다', async () => {
    const session = buildSession();
    const staleCreatedAt = new Date(FIXED_NOW.getTime() - 120000); // lease(60s) 초과
    const repo = fakeCartRepository([
      {
        id: 'stale-1', user_id: USER_ID, session_id: SESSION_ID, idempotency_key_hash: 'hash-1',
        request_hash: null, proposal_hash: null, shopify_config_fingerprint: null, selected_items_json: [],
        status: 'pending', attempt_count: 0, external_call_started_at: null,
        created_at: staleCreatedAt, updated_at: staleCreatedAt,
      },
    ]);
    const adapter = successAdapter();
    const session2 = session;
    const rec = currentRecommendation(session2);
    // 기존 행의 request_hash 를 이번 요청과 동일하게 맞춰야 conflict 가 아니라 stale 경로로 간다
    const probeRepo = fakeCartRepository();
    await callCreate({ session: session2, repo: probeRepo, adapter: successAdapter(), idempotencyKeyHash: 'probe' });
    repo.rows.get('stale-1').request_hash = probeRepo.rows.get('cart-req-1').request_hash;

    const result = await callCreate({ session: session2, repo, adapter, items: [{ product_key: rec.items[0].product_key, quantity: 1 }] });

    assert.strictEqual(adapter.calls.createCart, 0, 'stale 처리에서 Shopify 호출 금지');
    assert.strictEqual(result.error.code, 'SHOPIFY_CART_ABORTED_BEFORE_DISPATCH');
    assert.strictEqual(repo.rows.get('stale-1').status, 'failed');
  });

  await test('stale B(호출 후)는 external_call_started_at 기준으로 판정되어 outcome_unknown 이 된다', async () => {
    const session = buildSession();
    const probeRepo = fakeCartRepository();
    await callCreate({ session, repo: probeRepo, adapter: successAdapter(), idempotencyKeyHash: 'probe' });
    const sharedRequestHash = probeRepo.rows.get('cart-req-1').request_hash;

    // created_at 은 최근이지만 external_call_started_at 이 오래된 경우
    const repo = fakeCartRepository([
      {
        id: 'stale-2', user_id: USER_ID, session_id: SESSION_ID, idempotency_key_hash: 'hash-1',
        request_hash: sharedRequestHash, proposal_hash: null, shopify_config_fingerprint: null, selected_items_json: [],
        status: 'pending', attempt_count: 1,
        external_call_started_at: new Date(FIXED_NOW.getTime() - 120000),
        created_at: new Date(FIXED_NOW.getTime() - 1000),
        updated_at: FIXED_NOW,
      },
    ]);
    const adapter = successAdapter();
    const result = await callCreate({ session, repo, adapter });

    assert.strictEqual(adapter.calls.createCart, 0, 'Mutation 재호출 절대 금지');
    assert.strictEqual(result.error.code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
    assert.strictEqual(repo.rows.get('stale-2').status, 'outcome_unknown');
  });

  await test('lease 가 아직 살아있는 pending 은 409 SHOPIFY_CART_IN_PROGRESS', async () => {
    const session = buildSession();
    const probeRepo = fakeCartRepository();
    await callCreate({ session, repo: probeRepo, adapter: successAdapter(), idempotencyKeyHash: 'probe' });
    const sharedRequestHash = probeRepo.rows.get('cart-req-1').request_hash;

    const repo = fakeCartRepository([
      {
        id: 'fresh-1', user_id: USER_ID, session_id: SESSION_ID, idempotency_key_hash: 'hash-1',
        request_hash: sharedRequestHash, proposal_hash: null, shopify_config_fingerprint: null, selected_items_json: [],
        status: 'pending', attempt_count: 1,
        external_call_started_at: new Date(FIXED_NOW.getTime() - 1000), // lease 내
        created_at: new Date(FIXED_NOW.getTime() - 2000),
        updated_at: FIXED_NOW,
      },
    ]);
    const adapter = successAdapter();
    await assertRejectsWithCode(callCreate({ session, repo, adapter }), 'SHOPIFY_CART_IN_PROGRESS');
    assert.strictEqual(adapter.calls.createCart, 0);
  });

  // -------------------- Shopify 성공 + DB 저장 실패 --------------------

  await test('Shopify 성공 후 markSucceeded 가 affectedRows=0 이면 succeeded 를 반환하지 않는다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    repo.markSucceeded = async () => 0; // 상태 충돌 시뮬레이션

    const result = await callCreate({ session, repo, adapter });

    assert.strictEqual(adapter.calls.createCart, 1);
    assert.ok(!result.body, 'succeeded 본문을 반환하면 안 된다');
    assert.strictEqual(result.error.code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
    assert.ok(!JSON.stringify(result).includes('checkout'), '저장되지 않은 checkoutUrl 을 반환하면 안 된다');
  });

  await test('Shopify 성공 후 DB UPDATE 가 예외로 실패해도 outcome_unknown 으로 처리된다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    repo.markSucceeded = async () => {
      throw new Error('DB 연결 끊김');
    };

    const result = await callCreate({ session, repo, adapter });

    assert.strictEqual(adapter.calls.createCart, 1);
    assert.strictEqual(result.error.code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
    assert.ok(!JSON.stringify(result).includes('checkout'));
    assert.ok(!JSON.stringify(result).includes('DB 연결 끊김'), '내부 오류 원문 미노출');
  });

  await test('Shopify 성공 후 전이마저 실패하면 행은 pending + external_call_started_at 으로 남는다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const adapter = successAdapter();
    repo.markSucceeded = async () => 0;
    repo.markTerminalError = async () => {
      throw new Error('DB down');
    };

    const result = await callCreate({ session, repo, adapter });

    assert.strictEqual(result.error.code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
    const row = repo.rows.get('cart-req-1');
    assert.strictEqual(row.status, 'pending');
    assert.notStrictEqual(row.external_call_started_at, null, 'lease 만료 후 outcome_unknown 으로 정리될 수 있어야 한다');
  });

  await test('응답 line 이 요청과 다르면 succeeded 로 처리하지 않는다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    const mismatchAdapter = {
      calls: { createCart: 0 },
      async createCart() {
        this.calls.createCart += 1;
        return {
          outcome: 'succeeded', httpStatus: 200, errorCode: null, safeErrorDetails: null, warningCodes: [],
          cart: {
            id: 'gid://shopify/Cart/abc',
            checkoutUrl: 'https://demo-store.myshopify.com/checkout/abc',
            lines: [{ quantity: 99, merchandiseId: GID(999) }], // 요청과 불일치
            totalAmount: '18.97', totalCurrencyCode: 'USD', totalAmountEstimated: true,
          },
        };
      },
    };
    const result = await callCreate({ session, repo, adapter: mismatchAdapter });
    assert.strictEqual(result.error.code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
    assert.strictEqual(repo.rows.get('cart-req-1').status, 'outcome_unknown');
  });

  // -------------------- 순수 헬퍼 --------------------

  await test('cartLinesMatchRequest 는 순서에 의존하지 않고 multiset 으로 비교한다', () => {
    const requested = [
      { variant_gid: GID(1), quantity: 1 },
      { variant_gid: GID(2), quantity: 2 },
    ];
    assert.strictEqual(
      cartLinesMatchRequest([{ merchandiseId: GID(2), quantity: 2 }, { merchandiseId: GID(1), quantity: 1 }], requested),
      true
    );
    assert.strictEqual(cartLinesMatchRequest([{ merchandiseId: GID(1), quantity: 1 }], requested), false, '누락 감지');
    assert.strictEqual(
      cartLinesMatchRequest(
        [{ merchandiseId: GID(1), quantity: 1 }, { merchandiseId: GID(2), quantity: 2 }, { merchandiseId: GID(3), quantity: 1 }],
        requested
      ),
      false,
      '예상치 못한 line 감지'
    );
    assert.strictEqual(
      cartLinesMatchRequest([{ merchandiseId: GID(1), quantity: 1 }, { merchandiseId: GID(2), quantity: 5 }], requested),
      false,
      'quantity 불일치 감지'
    );
  });

  await test('buildResultFromRow 는 failed/outcome_unknown 에서 checkout_url 을 반환하지 않는다', () => {
    const result = buildResultFromRow({
      id: 'r1', status: 'failed', normalized_error_code: 'SHOPIFY_USER_ERROR', normalized_http_status: 422,
      checkout_url: 'https://should-not-leak.example.com/c',
    });
    assert.strictEqual(result.httpStatus, 422);
    assert.ok(!JSON.stringify(result).includes('should-not-leak'));
  });

  // -------------------- Shopify 로 나가는 데이터 --------------------

  await test('Adapter 에는 merchandiseId/quantity 만 전달되고 설문/의료정보는 전달되지 않는다', async () => {
    const session = buildSession();
    const repo = fakeCartRepository();
    let receivedArgs = null;
    const spyAdapter = {
      async createCart(args) {
        receivedArgs = args;
        return successAdapter().createCart(args);
      },
    };
    await callCreate({ session, repo, adapter: spyAdapter });

    assert.deepStrictEqual(Object.keys(receivedArgs).sort(), ['lines', 'timeoutMs']);
    for (const line of receivedArgs.lines) {
      assert.deepStrictEqual(Object.keys(line).sort(), ['merchandiseId', 'quantity']);
    }
    const serialized = JSON.stringify(receivedArgs);
    for (const forbidden of ['product_key', 'reason_code', 'evidence', 'survey', 'cavity', 'session_id', 'user_id', 'cart_request_id']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
