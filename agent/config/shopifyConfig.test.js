/**
 * agent/config/shopifyConfig.test.js
 * 실행: node agent/config/shopifyConfig.test.js
 */

const assert = require('node:assert');
const {
  ShopifyConfigError,
  parseStrictBoolean,
  normalizeStoreDomain,
  validateApiVersion,
  loadShopifyConfig,
  assertQueryReady,
  assertCartReady,
} = require('./shopifyConfig');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('shopifyConfig 테스트\n');

// -------------------- 엄격한 boolean 파싱 --------------------

test('값이 없으면 안전한 기본값 false', () => {
  assert.strictEqual(parseStrictBoolean(undefined, 'X'), false);
  assert.strictEqual(parseStrictBoolean(null, 'X'), false);
});

test('"true"/"false" 문자열만 허용한다', () => {
  assert.strictEqual(parseStrictBoolean('true', 'X'), true);
  assert.strictEqual(parseStrictBoolean('false', 'X'), false);
});

test('"1"/"yes"/빈 문자열/임의 문자열은 SHOPIFY_INVALID_CONFIGURATION', () => {
  for (const raw of ['1', '0', 'yes', 'no', '', 'TRUE', 'True', 'enabled']) {
    assert.throws(() => parseStrictBoolean(raw, 'SHOPIFY_ENABLED'), (err) => {
      assert.ok(err instanceof ShopifyConfigError);
      assert.strictEqual(err.code, 'SHOPIFY_INVALID_CONFIGURATION');
      return true;
    }, `raw=${JSON.stringify(raw)}`);
  }
});

// -------------------- Store domain 정규화 --------------------

test('정확한 myshopify.com hostname만 허용하고 소문자로 정규화한다', () => {
  assert.strictEqual(normalizeStoreDomain('My-Store.myshopify.com'), 'my-store.myshopify.com');
});

test('scheme/path/query/fragment/port/userinfo가 있으면 거부한다', () => {
  const invalid = [
    'https://my-store.myshopify.com',
    'http://my-store.myshopify.com',
    'my-store.myshopify.com/admin',
    'my-store.myshopify.com?x=1',
    'my-store.myshopify.com#frag',
    'my-store.myshopify.com:443',
    'user@my-store.myshopify.com',
  ];
  for (const raw of invalid) {
    assert.throws(() => normalizeStoreDomain(raw), ShopifyConfigError, raw);
  }
});

test('myshopify.com 이 아닌 도메인은 거부한다', () => {
  assert.throws(() => normalizeStoreDomain('example.com'), ShopifyConfigError);
  assert.throws(() => normalizeStoreDomain('my-store.myshopify.net'), ShopifyConfigError);
});

// -------------------- API version --------------------

test('YYYY-MM 형식만 허용하고 기본값은 2026-07이다', () => {
  assert.strictEqual(validateApiVersion(undefined), '2026-07');
  assert.strictEqual(validateApiVersion(''), '2026-07');
  assert.strictEqual(validateApiVersion('2026-04'), '2026-04');
});

test('latest/unstable은 명시적으로 거부한다', () => {
  assert.throws(() => validateApiVersion('latest'), ShopifyConfigError);
  assert.throws(() => validateApiVersion('unstable'), ShopifyConfigError);
});

test('잘못된 월/형식은 거부한다', () => {
  for (const raw of ['2026-13', '2026-00', '26-07', '2026/07', 'v2026-07']) {
    assert.throws(() => validateApiVersion(raw), ShopifyConfigError, raw);
  }
});

// -------------------- 비활성 환경 하위 호환 --------------------

test('SHOPIFY_* 환경 변수가 하나도 없어도 로드에 성공한다(추천 API 하위 호환)', () => {
  const config = loadShopifyConfig({});
  assert.strictEqual(config.enabled, false);
  assert.strictEqual(config.storeDomain, null);
  assert.strictEqual(config.hasPrivateToken, false);
  assert.strictEqual(config.diagnostics.store_domain_configured, false);
  assert.strictEqual(config.diagnostics.private_token_configured, false);
  assert.strictEqual(config.variantMapping.configured_keys.length, 0);
  assert.strictEqual(config.variantMapping.missing_keys.length, 7);
});

test('domain/token 형식이 잘못돼 있어도 loadShopifyConfig 자체는 던지지 않는다', () => {
  const config = loadShopifyConfig({ SHOPIFY_STORE_DOMAIN: 'https://bad.example.com' });
  assert.strictEqual(config.storeDomain, null);
  assert.ok(config.diagnostics.store_domain_error);
});

// -------------------- 3단계 준비도 --------------------

test('assertQueryReady: domain/apiVersion/token이 있으면 SHOPIFY_ENABLED=false여도 통과', () => {
  const config = loadShopifyConfig({
    SHOPIFY_ENABLED: 'false',
    SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
    SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'dummy-token-for-test',
  });
  assert.strictEqual(assertQueryReady(config), true);
});

test('assertQueryReady: token이 없으면 실패', () => {
  const config = loadShopifyConfig({ SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com' });
  assert.throws(() => assertQueryReady(config), ShopifyConfigError);
});

test('assertCartReady: SHOPIFY_ENABLED=false면 실패', () => {
  const config = loadShopifyConfig({
    SHOPIFY_ENABLED: 'false',
    SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
    SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'dummy-token-for-test',
  });
  assert.throws(() => assertCartReady(config), ShopifyConfigError);
});

test('assertCartReady: 모든 조건 충족 시 통과', () => {
  const config = loadShopifyConfig({
    SHOPIFY_ENABLED: 'true',
    SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
    SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'dummy-token-for-test',
  });
  assert.strictEqual(assertCartReady(config), true);
});

// -------------------- Lease 관계 검증 --------------------

test('lease > timeout + margin 이면 lease_relation_ok = true', () => {
  const config = loadShopifyConfig({
    SHOPIFY_TIMEOUT_MS: '10000',
    SHOPIFY_PENDING_LEASE_MS: '60000',
    SHOPIFY_LEASE_SAFETY_MARGIN_MS: '5000',
  });
  assert.strictEqual(config.diagnostics.lease_relation_ok, true);
});

test('clamp 이후에도 lease <= timeout + margin 이면 cart-ready가 fail-closed된다', () => {
  // lease 10000(최솟값), timeout 30000(최댓값) → 10000 > 30000+5000 이 아니므로 실패해야 함
  const config = loadShopifyConfig({
    SHOPIFY_ENABLED: 'true',
    SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
    SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'dummy-token-for-test',
    SHOPIFY_TIMEOUT_MS: '30000',
    SHOPIFY_PENDING_LEASE_MS: '10000',
    SHOPIFY_LEASE_SAFETY_MARGIN_MS: '5000',
  });
  assert.strictEqual(config.diagnostics.lease_relation_ok, false);
  assert.throws(() => assertCartReady(config), (err) => {
    assert.strictEqual(err.code, 'SHOPIFY_INVALID_CONFIGURATION');
    return true;
  });
});

test('범위 밖 숫자는 clamp된다', () => {
  const config = loadShopifyConfig({ SHOPIFY_TIMEOUT_MS: '999999', SHOPIFY_MAX_QUERY_RETRIES: '99' });
  assert.strictEqual(config.timeoutMs, 30000);
  assert.strictEqual(config.maxQueryRetries, 5);
});

test('정수가 아닌 숫자 설정은 SHOPIFY_INVALID_CONFIGURATION', () => {
  assert.throws(() => loadShopifyConfig({ SHOPIFY_TIMEOUT_MS: 'abc' }), ShopifyConfigError);
  assert.throws(() => loadShopifyConfig({ SHOPIFY_TIMEOUT_MS: '1.5' }), ShopifyConfigError);
});

// -------------------- 진단 정보에 비밀값 미포함 --------------------

test('diagnostics에는 실제 domain/token/GID 값이 들어가지 않는다', () => {
  const config = loadShopifyConfig({
    SHOPIFY_ENABLED: 'true',
    SHOPIFY_STORE_DOMAIN: 'secret-store-name.myshopify.com',
    SHOPIFY_STOREFRONT_PRIVATE_TOKEN: 'super-secret-token-value',
    SHOPIFY_VARIANT_GID_FLOSS_TAPE: 'gid://shopify/ProductVariant/1234567890',
  });
  const serialized = JSON.stringify(config.diagnostics);
  assert.ok(!serialized.includes('secret-store-name'));
  assert.ok(!serialized.includes('super-secret-token-value'));
  assert.ok(!serialized.includes('1234567890'));
  // 대신 상태와 product_key 이름만 담긴다
  assert.strictEqual(config.diagnostics.private_token_configured, true);
  assert.ok(config.diagnostics.configured_product_keys.includes('FLOSS_TAPE'));
});

test('RUN_SHOPIFY_INTEGRATION_TEST/ALLOW_SHOPIFY_CART_MUTATION_TEST도 엄격 파싱된다', () => {
  const config = loadShopifyConfig({ RUN_SHOPIFY_INTEGRATION_TEST: 'true', ALLOW_SHOPIFY_CART_MUTATION_TEST: 'false' });
  assert.strictEqual(config.runIntegrationTest, true);
  assert.strictEqual(config.allowCartMutationTest, false);
  assert.throws(() => loadShopifyConfig({ RUN_SHOPIFY_INTEGRATION_TEST: '1' }), ShopifyConfigError);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
