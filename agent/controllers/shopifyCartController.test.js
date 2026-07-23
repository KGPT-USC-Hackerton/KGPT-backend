/**
 * agent/controllers/shopifyCartController.test.js
 * 실행: node agent/controllers/shopifyCartController.test.js
 */

const assert = require('node:assert');
const crypto = require('crypto');

const { createShopifyCart, validateBody } = require('./shopifyCartController');
const { loadShopifyConfig } = require('../config/shopifyConfig');
const { hashIdempotencyKey } = require('../shared/shopifyRequestHash');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
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
const VALID_HASH = 'a'.repeat(64);
const GID = (n) => `gid://shopify/ProductVariant/${n}`;

const ENABLED_ENV = {
  SHOPIFY_ENABLED: 'true',
  SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
  SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'test-token',
  SHOPIFY_VARIANT_GID_TOOTHBRUSH_SOFT: GID(2),
};

function validBody(overrides = {}) {
  return {
    confirmed: true,
    proposal_hash: VALID_HASH,
    items: [{ product_key: 'TOOTHBRUSH_SOFT', quantity: 1 }],
    ...overrides,
  };
}

function baseReq(overrides = {}) {
  return {
    params: { sessionId: SESSION_ID },
    body: validBody(),
    headers: { 'idempotency-key': 'cart-key-001' },
    agentUser: { id: 1 },
    ...overrides,
  };
}

function deps({ env = ENABLED_ENV, serviceResult, serviceSpy, adapterSpy } = {}) {
  return {
    loadShopifyConfig: () => loadShopifyConfig(env),
    createAdapter: () => {
      if (adapterSpy) adapterSpy.created += 1;
      return { createCart: async () => { throw new Error('실제 호출되면 안 됨'); } };
    },
    service: {
      createShopifyCart: async (args, serviceDeps) => {
        if (serviceSpy) {
          serviceSpy.calls += 1;
          serviceSpy.lastArgs = args;
          serviceSpy.lastDeps = serviceDeps;
        }
        if (serviceResult instanceof Error) throw serviceResult;
        return serviceResult || { httpStatus: 200, body: { cart_request_id: 'r1', status: 'succeeded' } };
      },
    },
  };
}

async function run() {
  console.log('shopifyCartController 테스트\n');

  // -------------------- confirmed 검증 --------------------

  await test('confirmed 누락/false/문자열 "true"/1 은 전부 거부된다', async () => {
    for (const confirmed of [undefined, false, 'true', 1, 'yes']) {
      const body = validBody();
      if (confirmed === undefined) delete body.confirmed;
      else body.confirmed = confirmed;

      const res = mockRes();
      await createShopifyCart(baseReq({ body }), res, deps());
      assert.strictEqual(res.statusCode, 400, String(confirmed));
      assert.strictEqual(res.body.error_code, 'SHOPIFY_CART_CONFIRMATION_REQUIRED', String(confirmed));
    }
  });

  // -------------------- unknown field --------------------

  await test('body 의 unknown field 는 400 UNKNOWN_FIELD', async () => {
    for (const field of ['user_id', 'session_id', 'merchandise_id', 'sku', 'price', 'title', 'checkout_url', 'evidence']) {
      const res = mockRes();
      await createShopifyCart(baseReq({ body: validBody({ [field]: 'x' }) }), res, deps());
      assert.strictEqual(res.statusCode, 400, field);
      assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD', field);
    }
  });

  await test('items 의 unknown field(GID/SKU/price 등)도 400 UNKNOWN_FIELD', async () => {
    for (const field of ['merchandiseId', 'variant_gid', 'sku', 'price', 'title', 'url']) {
      const res = mockRes();
      await createShopifyCart(
        baseReq({ body: validBody({ items: [{ product_key: 'TOOTHBRUSH_SOFT', quantity: 1, [field]: 'x' }] }) }),
        res,
        deps()
      );
      assert.strictEqual(res.statusCode, 400, field);
      assert.strictEqual(res.body.error_code, 'UNKNOWN_FIELD', field);
    }
  });

  // -------------------- Idempotency-Key --------------------

  await test('Idempotency-Key 헤더가 없으면 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const res = mockRes();
    await createShopifyCart(baseReq({ headers: {} }), res, deps());
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  await test('허용되지 않는 문자/길이의 Idempotency-Key 는 400 INVALID_IDEMPOTENCY_KEY', async () => {
    for (const key of ['has space', 'line\nbreak', 'A'.repeat(101), '한글키', ' trimmed ']) {
      const res = mockRes();
      await createShopifyCart(baseReq({ headers: { 'idempotency-key': key } }), res, deps());
      assert.strictEqual(res.statusCode, 400, JSON.stringify(key));
      assert.strictEqual(res.body.error_code, 'INVALID_IDEMPOTENCY_KEY', JSON.stringify(key));
    }
  });

  await test('Idempotency-Key 원문은 Service 로 전달되지 않고 해시만 전달된다', async () => {
    const spy = { calls: 0 };
    const res = mockRes();
    const rawKey = 'cart-key-secret-001';
    await createShopifyCart(baseReq({ headers: { 'idempotency-key': rawKey } }), res, deps({ serviceSpy: spy }));

    assert.strictEqual(spy.lastArgs.idempotencyKeyHash, hashIdempotencyKey(rawKey));
    const serializedArgs = JSON.stringify(spy.lastArgs);
    assert.ok(!serializedArgs.includes(rawKey), 'Service 인자에 원문이 섞이면 안 된다');
  });

  // -------------------- proposal_hash / items 형식 --------------------

  await test('proposal_hash 형식이 잘못되면 400 VALIDATION_ERROR', async () => {
    for (const hash of ['short', 'A'.repeat(64), 123, undefined]) {
      const body = validBody();
      if (hash === undefined) delete body.proposal_hash;
      else body.proposal_hash = hash;
      const res = mockRes();
      await createShopifyCart(baseReq({ body }), res, deps());
      assert.strictEqual(res.statusCode, 400, String(hash));
      assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR', String(hash));
    }
  });

  await test('items 가 비었거나 quantity 가 정수가 아니면 400 VALIDATION_ERROR', async () => {
    const cases = [
      validBody({ items: [] }),
      validBody({ items: [{ product_key: 'TOOTHBRUSH_SOFT', quantity: 1.5 }] }),
      validBody({ items: [{ product_key: 'TOOTHBRUSH_SOFT', quantity: '1' }] }),
      validBody({ items: [{ product_key: '', quantity: 1 }] }),
    ];
    for (const body of cases) {
      const res = mockRes();
      await createShopifyCart(baseReq({ body }), res, deps());
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
    }
  });

  await test('잘못된 sessionId UUID 는 400 VALIDATION_ERROR', async () => {
    const res = mockRes();
    await createShopifyCart(baseReq({ params: { sessionId: 'not-a-uuid' } }), res, deps());
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error_code, 'VALIDATION_ERROR');
  });

  // -------------------- SHOPIFY_ENABLED=false --------------------

  await test('SHOPIFY_ENABLED=false 면 503 SHOPIFY_NOT_CONFIGURED 이고 Adapter 를 만들지 않는다', async () => {
    const adapterSpy = { created: 0 };
    const serviceSpy = { calls: 0 };
    const res = mockRes();
    await createShopifyCart(baseReq(), res, deps({ env: { SHOPIFY_ENABLED: 'false' }, adapterSpy, serviceSpy }));

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error_code, 'SHOPIFY_NOT_CONFIGURED');
    assert.strictEqual(adapterSpy.created, 0, 'Adapter 생성 금지');
    assert.strictEqual(serviceSpy.calls, 0, 'Service 호출 금지');
  });

  await test('SHOPIFY_ENABLED 미설정(값 없음)이어도 안전하게 503 처리된다', async () => {
    const res = mockRes();
    await createShopifyCart(baseReq(), res, deps({ env: {} }));
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error_code, 'SHOPIFY_NOT_CONFIGURED');
  });

  await test('설정 로딩 자체가 실패하면 503 SHOPIFY_NOT_CONFIGURED', async () => {
    const res = mockRes();
    await createShopifyCart(baseReq(), res, {
      ...deps(),
      loadShopifyConfig: () => {
        throw new Error('SHOPIFY_INVALID_CONFIGURATION');
      },
    });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error_code, 'SHOPIFY_NOT_CONFIGURED');
  });

  // -------------------- 성공/오류 결과 매핑 --------------------

  await test('Service 성공 결과를 그대로 200 으로 반환한다', async () => {
    const res = mockRes();
    await createShopifyCart(
      baseReq(),
      res,
      deps({
        serviceResult: {
          httpStatus: 200,
          body: {
            cart_request_id: 'r1',
            status: 'succeeded',
            checkout_url: 'https://demo-store.myshopify.com/checkout/abc',
            estimated_cart_total: { amount: '18.97', currency_code: 'USD', is_estimated: true },
            pricing_disclaimer: 'Estimated cart pricing may change at Shopify checkout.',
            warnings: [],
          },
        },
      })
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.estimated_cart_total.amount, '18.97');
    assert.strictEqual(typeof res.body.data.estimated_cart_total.amount, 'string');
    assert.strictEqual('cart_total' in res.body.data, false, 'cart_total 이름은 쓰지 않는다');
  });

  await test('Service 오류 결과는 저장된 상태 코드로 반환되고 원문은 노출되지 않는다', async () => {
    const res = mockRes();
    await createShopifyCart(
      baseReq(),
      res,
      deps({ serviceResult: { httpStatus: 502, error: { code: 'SHOPIFY_CART_OUTCOME_UNKNOWN', cart_request_id: 'r1' } } })
    );

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.error_code, 'SHOPIFY_CART_OUTCOME_UNKNOWN');
    assert.strictEqual(res.body.cart_request_id, 'r1');
    assert.ok(!JSON.stringify(res.body).includes('checkout'));
  });

  await test('ShopifyCartError 는 지정된 httpStatus 로 매핑된다(409/503 등)', async () => {
    const cases = [
      { code: 'PRODUCT_PROPOSAL_STALE', httpStatus: 409 },
      { code: 'IDEMPOTENCY_KEY_CONFLICT', httpStatus: 409 },
      { code: 'SHOPIFY_CART_IN_PROGRESS', httpStatus: 409 },
      { code: 'PRODUCT_VARIANT_NOT_CONFIGURED', httpStatus: 503 },
      { code: 'AGENT_SESSION_NOT_FOUND', httpStatus: 404 },
    ];
    for (const { code, httpStatus } of cases) {
      const error = new Error('x');
      error.name = 'ShopifyCartError';
      error.code = code;
      error.httpStatus = httpStatus;

      const res = mockRes();
      await createShopifyCart(baseReq(), res, deps({ serviceResult: error }));
      assert.strictEqual(res.statusCode, httpStatus, code);
      assert.strictEqual(res.body.error_code, code);
    }
  });

  await test('예상치 못한 예외는 500 SHOPIFY_CART_INTERNAL_ERROR 로 정규화된다', async () => {
    const res = mockRes();
    await createShopifyCart(baseReq(), res, deps({ serviceResult: new Error('내부 스택 정보') }));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error_code, 'SHOPIFY_CART_INTERNAL_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('내부 스택 정보'));
  });

  // -------------------- validateBody 순수 함수 --------------------

  await test('validateBody 는 허용 필드만 통과시킨다', () => {
    assert.ok(validateBody(validBody()).value);
    assert.strictEqual(validateBody(null).error.code, 'VALIDATION_ERROR');
    assert.strictEqual(validateBody([]).error.code, 'VALIDATION_ERROR');
    assert.strictEqual(validateBody(validBody({ extra: 1 })).error.code, 'UNKNOWN_FIELD');
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
