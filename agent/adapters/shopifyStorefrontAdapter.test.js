/**
 * agent/adapters/shopifyStorefrontAdapter.test.js
 * fake fetch 만 사용하며 실제 Shopify 호출은 0회다.
 *
 * 실행: node agent/adapters/shopifyStorefrontAdapter.test.js
 */

const assert = require('node:assert');
const {
  PRIVATE_TOKEN_HEADER,
  OUTCOME,
  isSafeCheckoutUrl,
  isValidMoney,
  hasStructuralPreExecutionError,
  toFieldCodes,
  createShopifyStorefrontAdapter,
} = require('./shopifyStorefrontAdapter');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✅ ${name}`);
    });
}

const CONFIG = {
  storeDomain: 'demo-store.myshopify.com',
  apiVersion: '2026-07',
  privateToken: 'test-private-token-value',
  timeoutMs: 5000,
  maxQueryRetries: 2,
};

const GID = (n) => `gid://shopify/ProductVariant/${n}`;

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

function fakeFetchReturning(response, recorder) {
  return async (url, options) => {
    if (recorder) recorder.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
}

function successCartBody(overrides = {}) {
  return {
    data: {
      cartCreate: {
        cart: {
          id: 'gid://shopify/Cart/abc123',
          checkoutUrl: 'https://demo-store.myshopify.com/checkout/abc',
          lines: { nodes: [{ quantity: 1, merchandise: { id: GID(111) } }] },
          cost: { totalAmount: { amount: '18.97', currencyCode: 'USD' }, totalAmountEstimated: true },
          ...overrides.cart,
        },
        userErrors: overrides.userErrors || [],
        warnings: overrides.warnings || [],
      },
    },
  };
}

const DEFAULT_LINES = [{ merchandiseId: GID(111), quantity: 1 }];

async function run() {
  console.log('shopifyStorefrontAdapter 테스트\n');

  // -------------------- 인증 헤더 --------------------

  await test('Private Token 은 Shopify-Storefront-Private-Token 헤더로만 전송된다', async () => {
    const calls = [];
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody()), calls),
    });
    await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });

    const headers = calls[0].options.headers;
    assert.strictEqual(headers[PRIVATE_TOKEN_HEADER], CONFIG.privateToken);
    assert.strictEqual(PRIVATE_TOKEN_HEADER, 'Shopify-Storefront-Private-Token');
  });

  await test('Public Token 헤더(X-Shopify-Storefront-Access-Token)는 절대 사용하지 않는다', async () => {
    const calls = [];
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody()), calls),
    });
    await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });

    const headerNames = Object.keys(calls[0].options.headers);
    assert.ok(!headerNames.some((n) => n.toLowerCase() === 'x-shopify-storefront-access-token'));
  });

  await test('요청 URL 에 store domain 과 API version 이 정확히 포함된다', async () => {
    const calls = [];
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody()), calls),
    });
    await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(calls[0].url, 'https://demo-store.myshopify.com/api/2026-07/graphql.json');
  });

  // -------------------- 전송 데이터 최소화 --------------------

  await test('Shopify 로는 merchandiseId 와 quantity 만 전송한다(attributes/note/metafields 없음)', async () => {
    const calls = [];
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody()), calls),
    });
    await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });

    const body = JSON.parse(calls[0].options.body);
    assert.deepStrictEqual(Object.keys(body.variables.input), ['lines']);
    assert.deepStrictEqual(Object.keys(body.variables.input.lines[0]).sort(), ['merchandiseId', 'quantity']);
    const serialized = JSON.stringify(body.variables);
    for (const forbidden of ['attributes', 'note', 'metafields', 'sellingPlanId', 'buyerIdentity', 'discountCodes']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  });

  await test('cart_request_id/설문응답/의료정보가 Shopify 요청에 포함되지 않는다', async () => {
    const calls = [];
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody()), calls),
    });
    // Adapter 는 lines 외의 어떤 값도 인자로 받지 않으므로 구조적으로 불가능하다.
    await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    const serialized = calls[0].options.body;
    for (const forbidden of ['cart_request_id', 'session_id', 'user_id', 'survey', 'question_code', 'cavity', 'reason_code']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  });

  // -------------------- A/B/C/D 오류 분류 --------------------

  await test('B: HTTP 401/403 은 known failed(SHOPIFY_AUTH_FAILED)', async () => {
    for (const status of [401, 403]) {
      const adapter = createShopifyStorefrontAdapter({
        config: CONFIG,
        fetchImpl: fakeFetchReturning(jsonResponse(status, {})),
      });
      const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
      assert.strictEqual(result.outcome, OUTCOME.FAILED, `status=${status}`);
      assert.strictEqual(result.errorCode, 'SHOPIFY_AUTH_FAILED');
      assert.strictEqual(result.safeErrorDetails.category, 'AUTHENTICATION');
    }
  });

  await test('B: userErrors 존재 + cart null 은 known failed(SHOPIFY_USER_ERROR)', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(
        jsonResponse(200, {
          data: {
            cartCreate: {
              cart: null,
              userErrors: [{ field: ['lines', '0', 'merchandiseId'], message: '원문 메시지' }],
              warnings: [],
            },
          },
        })
      ),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.FAILED);
    assert.strictEqual(result.errorCode, 'SHOPIFY_USER_ERROR');
    assert.deepStrictEqual(result.safeErrorDetails.field_codes, ['LINES_0_MERCHANDISE_ID']);
    assert.ok(!JSON.stringify(result).includes('원문 메시지'));
  });

  await test('B: top-level error(구조적 사전 실행 오류) + data 없음 은 known failed', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(
        jsonResponse(200, { errors: [{ message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] })
      ),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.FAILED);
    assert.strictEqual(result.errorCode, 'SHOPIFY_GRAPHQL_ERROR');
  });

  await test('C: top-level errors + partial data 동시 존재는 outcome_unknown', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(
        jsonResponse(200, {
          errors: [{ message: 'partial', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
          data: { cartCreate: null },
        })
      ),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN);
  });

  await test('C: extensions.code 없는 top-level error 는 message 추측 없이 outcome_unknown', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, { errors: [{ message: 'Field is invalid' }] })),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN);
  });

  await test('C: userErrors 와 cart 가 동시에 존재하면 outcome_unknown', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(
        jsonResponse(200, successCartBody({ userErrors: [{ field: ['lines'], message: 'x' }] }))
      ),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN);
  });

  await test('C: HTTP 5xx / JSON parse 실패 / 네트워크 오류 / timeout 은 전부 outcome_unknown', async () => {
    const cases = [
      { fetchImpl: fakeFetchReturning(jsonResponse(500, {})), expectedCode: 'SHOPIFY_UNAVAILABLE' },
      { fetchImpl: fakeFetchReturning(jsonResponse(503, {})), expectedCode: 'SHOPIFY_UNAVAILABLE' },
      {
        fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('bad json'); } }),
        expectedCode: 'SHOPIFY_INVALID_RESPONSE',
      },
      { fetchImpl: fakeFetchReturning(Object.assign(new Error('net'), { name: 'FetchError' })), expectedCode: 'SHOPIFY_UNAVAILABLE' },
      { fetchImpl: fakeFetchReturning(Object.assign(new Error('abort'), { name: 'AbortError' })), expectedCode: 'SHOPIFY_TIMEOUT' },
    ];
    for (const { fetchImpl, expectedCode } of cases) {
      const adapter = createShopifyStorefrontAdapter({ config: CONFIG, fetchImpl });
      const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
      assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN, expectedCode);
      assert.strictEqual(result.errorCode, expectedCode);
    }
  });

  await test('D: HTTP 429 는 자동 재시도 없이 보수적으로 outcome_unknown', async () => {
    let callCount = 0;
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse(429, {});
      },
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN);
    assert.strictEqual(result.errorCode, 'SHOPIFY_RATE_LIMITED');
    assert.strictEqual(callCount, 1, 'cartCreate 는 재시도하지 않아야 한다');
  });

  // -------------------- Mutation 무재시도 --------------------

  await test('cartCreate 는 어떤 오류에도 정확히 1회만 호출된다', async () => {
    const errorCases = [
      Object.assign(new Error('abort'), { name: 'AbortError' }),
      Object.assign(new Error('reset'), { name: 'FetchError' }),
      jsonResponse(500, {}),
      jsonResponse(502, {}),
      jsonResponse(503, {}),
      jsonResponse(504, {}),
      jsonResponse(429, {}),
    ];
    for (const errorCase of errorCases) {
      let callCount = 0;
      const adapter = createShopifyStorefrontAdapter({
        config: CONFIG,
        fetchImpl: async () => {
          callCount += 1;
          if (errorCase instanceof Error) throw errorCase;
          return errorCase;
        },
      });
      await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
      assert.strictEqual(callCount, 1, `재시도 발생: ${errorCase.name || errorCase.status}`);
    }
  });

  await test('read-only Query 만 제한적 retry 를 수행한다', async () => {
    let callCount = 0;
    const adapter = createShopifyStorefrontAdapter({
      config: { ...CONFIG, maxQueryRetries: 2 },
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse(503, {});
      },
    });
    await adapter.verifyVariantsExist({ variantGids: [GID(111)], timeoutMs: 100 });
    assert.strictEqual(callCount, 3, 'maxQueryRetries=2 이면 최초 1회 + 재시도 2회');
  });

  // -------------------- 성공 판정과 필수 필드 --------------------

  await test('정상 응답이면 succeeded 이고 금액은 Decimal 문자열 그대로 유지된다', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody())),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.SUCCEEDED);
    assert.strictEqual(result.cart.totalAmount, '18.97');
    assert.strictEqual(typeof result.cart.totalAmount, 'string');
    assert.strictEqual(result.cart.totalCurrencyCode, 'USD');
    assert.strictEqual(result.cart.totalAmountEstimated, true);
  });

  await test('checkoutUrl 누락/lines 누락/cost 누락은 succeeded 가 아니라 outcome_unknown', async () => {
    const partials = [
      successCartBody({ cart: { checkoutUrl: null } }),
      successCartBody({ cart: { lines: null } }),
      successCartBody({ cart: { cost: null } }),
      successCartBody({ cart: { id: '' } }),
    ];
    for (const body of partials) {
      const adapter = createShopifyStorefrontAdapter({ config: CONFIG, fetchImpl: fakeFetchReturning(jsonResponse(200, body)) });
      const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
      assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN);
    }
  });

  await test('amount 가 숫자 문자열이 아니거나 currencyCode 가 없으면 outcome_unknown', async () => {
    const invalidCosts = [
      { totalAmount: { amount: 'not-a-number', currencyCode: 'USD' }, totalAmountEstimated: true },
      { totalAmount: { amount: '18.97', currencyCode: '' }, totalAmountEstimated: true },
      { totalAmount: { amount: 18.97, currencyCode: 'USD' }, totalAmountEstimated: true },
      { totalAmount: { amount: '18.97', currencyCode: 'USD' }, totalAmountEstimated: 'yes' },
    ];
    for (const cost of invalidCosts) {
      const adapter = createShopifyStorefrontAdapter({
        config: CONFIG,
        fetchImpl: fakeFetchReturning(jsonResponse(200, successCartBody({ cart: { cost } }))),
      });
      const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
      assert.strictEqual(result.outcome, OUTCOME.OUTCOME_UNKNOWN, JSON.stringify(cost));
    }
  });

  await test('warnings 만 존재하는 경우 성공을 차단하지 않고 코드만 정규화한다', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(
        jsonResponse(200, successCartBody({ warnings: [{ code: 'MERCHANDISE_NOT_ENOUGH_STOCK', message: '원문' }] }))
      ),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    assert.strictEqual(result.outcome, OUTCOME.SUCCEEDED);
    assert.deepStrictEqual(result.warningCodes, ['MERCHANDISE_NOT_ENOUGH_STOCK']);
    assert.ok(!JSON.stringify(result).includes('원문'));
  });

  // -------------------- checkoutUrl 검증 --------------------

  await test('checkoutUrl 은 https 이고 userinfo 가 없어야 하며 hostname 은 제한하지 않는다', () => {
    assert.strictEqual(isSafeCheckoutUrl('https://demo.myshopify.com/checkout/abc'), true);
    assert.strictEqual(isSafeCheckoutUrl('https://shop.custom-domain.com/checkouts/xyz'), true, 'Custom Domain 허용');
    assert.strictEqual(isSafeCheckoutUrl('http://demo.myshopify.com/checkout'), false, 'http 거부');
    assert.strictEqual(isSafeCheckoutUrl('https://user:pass@demo.myshopify.com/c'), false, 'userinfo 거부');
    assert.strictEqual(isSafeCheckoutUrl('not-a-url'), false);
    assert.strictEqual(isSafeCheckoutUrl(''), false);
    assert.strictEqual(isSafeCheckoutUrl(null), false);
  });

  // -------------------- 순수 헬퍼 --------------------

  await test('isValidMoney 는 Decimal 문자열만 통과시킨다', () => {
    assert.strictEqual(isValidMoney({ amount: '18.97', currencyCode: 'USD' }), true);
    assert.strictEqual(isValidMoney({ amount: '0', currencyCode: 'USD' }), true);
    assert.strictEqual(isValidMoney({ amount: '18,97', currencyCode: 'USD' }), false);
    assert.strictEqual(isValidMoney({ amount: 18.97, currencyCode: 'USD' }), false);
    assert.strictEqual(isValidMoney(null), false);
  });

  await test('hasStructuralPreExecutionError 는 extensions.code 만 본다', () => {
    assert.strictEqual(hasStructuralPreExecutionError([{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }]), true);
    assert.strictEqual(hasStructuralPreExecutionError([{ message: 'validation failed' }]), false);
    assert.strictEqual(hasStructuralPreExecutionError([{ extensions: { code: 'THROTTLED' } }]), false);
    assert.strictEqual(hasStructuralPreExecutionError([]), false);
  });

  await test('toFieldCodes 는 field 배열만 코드로 바꾸고 message 는 버린다', () => {
    assert.deepStrictEqual(toFieldCodes([{ field: ['lines', '0', 'merchandiseId'], message: 'secret' }]), [
      'LINES_0_MERCHANDISE_ID',
    ]);
    assert.deepStrictEqual(toFieldCodes([{ message: 'no field' }]), []);
  });

  // -------------------- 비밀값 미노출 --------------------

  await test('반환값 어디에도 Token/store domain/GID 가 포함되지 않는다', async () => {
    const adapter = createShopifyStorefrontAdapter({
      config: CONFIG,
      fetchImpl: fakeFetchReturning(jsonResponse(401, {})),
    });
    const result = await adapter.createCart({ lines: DEFAULT_LINES, timeoutMs: 1000 });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(CONFIG.privateToken));
    assert.ok(!serialized.includes(CONFIG.storeDomain));
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
