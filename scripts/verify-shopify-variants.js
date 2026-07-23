#!/usr/bin/env node
/**
 * scripts/verify-shopify-variants.js
 * ----------------------------------------------------------------------------
 * 개발자가 명시적으로 실행하는 read-only Shopify Variant 검증 CLI.
 *
 * 안전 원칙:
 *   * read-only query(nodes)만 실행한다. cartCreate 는 절대 호출하지 않는다.
 *   * SHOPIFY_ENABLED=false 여도 실행 가능하다(query-ready 설정만 요구).
 *   * 공개 HTTP Endpoint 로 노출하지 않는다(CLI 전용).
 *   * 실제 Variant GID / Store domain / Private Token 을 절대 출력하지 않는다.
 *     product_key 와 정규화된 상태 코드만 출력한다.
 *
 * 사용법: npm run shopify:verify-variants
 */

require('dotenv').config();

const { loadShopifyConfig, assertQueryReady, ShopifyConfigError } = require('../agent/config/shopifyConfig');
const { createShopifyStorefrontAdapter } = require('../agent/adapters/shopifyStorefrontAdapter');
const { KNOWN_PRODUCT_KEYS, getVariantGid } = require('../agent/catalog/shopifyVariantMapping');
const { compareSku } = require('../agent/catalog/shopifyExpectedSkus');

// 로컬 설정만으로 판정 가능한 상태(원격 조회 이전)
const LOCAL_STATUS = {
  MISSING: 'MISSING',
  INVALID_FORMAT: 'INVALID_FORMAT',
  DUPLICATE_MAPPING: 'DUPLICATE_MAPPING',
};

function buildLocalStatuses(variantMapping) {
  const statuses = new Map();
  for (const productKey of KNOWN_PRODUCT_KEYS) {
    if (variantMapping.duplicate_gid_keys.includes(productKey)) {
      statuses.set(productKey, LOCAL_STATUS.DUPLICATE_MAPPING);
    } else if (variantMapping.invalid_keys.includes(productKey)) {
      statuses.set(productKey, LOCAL_STATUS.INVALID_FORMAT);
    } else if (variantMapping.missing_keys.includes(productKey)) {
      statuses.set(productKey, LOCAL_STATUS.MISSING);
    }
  }
  return statuses;
}

/**
 * 원격 nodes 응답을 product_key 별 상태 코드로 변환한다.
 * 실제 GID 는 어떤 반환값에도 넣지 않는다.
 */
function resolveRemoteStatus({ node, productKey }) {
  if (!node) return 'NOT_FOUND';
  if (node.__typename !== 'ProductVariant') return 'NOT_FOUND';
  if (node.availableForSale === false) return 'UNAVAILABLE';

  // sku 필드가 응답에 아예 없으면(권한 등) SKIPPED_UNAVAILABLE_FIELD.
  const skuStatus = compareSku(productKey, 'sku' in node ? node.sku : undefined);
  if (skuStatus === 'SKU_MISMATCH') return 'SKU_MISMATCH';
  if (skuStatus === 'SKIPPED_UNAVAILABLE_FIELD') return 'SKIPPED_UNAVAILABLE_FIELD';

  return 'OK';
}

async function main() {
  console.log('🛒 Shopify Variant 검증 (read-only, cartCreate 호출 없음)\n');

  let config;
  try {
    config = loadShopifyConfig(process.env);
  } catch (error) {
    console.error(`❌ 설정 오류: ${error.message}`);
    return 1;
  }

  const localStatuses = buildLocalStatuses(config.variantMapping);

  // 설정 진단부터 출력(값이 아니라 상태만).
  console.log('환경 설정 상태:');
  console.log(`  store_domain_configured : ${config.diagnostics.store_domain_configured}`);
  console.log(`  api_version_configured  : ${config.diagnostics.api_version_configured}`);
  console.log(`  private_token_configured: ${config.diagnostics.private_token_configured}`);
  console.log(`  shopify_cart_api_enabled: ${config.enabled}`);
  if (config.diagnostics.unknown_env_keys.length > 0) {
    console.log(`  ⚠️  알 수 없는 환경 변수: ${config.diagnostics.unknown_env_keys.join(', ')}`);
  }
  console.log('');

  // 원격 조회가 불가능하면 로컬 상태만 출력하고 종료한다.
  let queryReady = true;
  try {
    assertQueryReady(config);
  } catch (error) {
    queryReady = false;
    if (!(error instanceof ShopifyConfigError)) throw error;
    console.log(`ℹ️  원격 조회 불가(${error.message}) — 로컬 설정 상태만 표시합니다.\n`);
  }

  const configuredKeys = config.variantMapping.configured_keys;

  if (!queryReady || configuredKeys.length === 0) {
    for (const productKey of KNOWN_PRODUCT_KEYS) {
      console.log(`  ${productKey}: ${localStatuses.get(productKey) || 'CONFIGURED_LOCAL_ONLY'}`);
    }
    console.log('\n원격 검증을 하려면 Store domain / Private Token / Variant GID 설정이 필요합니다.');
    return queryReady ? 0 : 1;
  }

  // 원격 read-only 조회(nodes). 이 CLI 에서만 제한적 retry 가 허용된다.
  const adapter = createShopifyStorefrontAdapter({ config });
  const gids = configuredKeys.map((key) => getVariantGid(key, config.variantMapping));

  const result = await adapter.verifyVariantsExist({ variantGids: gids, timeoutMs: config.timeoutMs });

  if (!result.ok) {
    console.error(`❌ 원격 조회 실패: ${result.errorCode}`);
    return 1;
  }

  const nodeByProductKey = new Map();
  configuredKeys.forEach((productKey, index) => {
    nodeByProductKey.set(productKey, result.nodes[index] || null);
  });

  console.log('Variant 검증 결과 (GID는 출력하지 않습니다):');
  let allOk = true;
  for (const productKey of KNOWN_PRODUCT_KEYS) {
    const localStatus = localStatuses.get(productKey);
    if (localStatus) {
      console.log(`  ${productKey}: ${localStatus}`);
      allOk = false;
      continue;
    }
    const status = resolveRemoteStatus({ node: nodeByProductKey.get(productKey), productKey });
    console.log(`  ${productKey}: ${status}`);
    if (status !== 'OK') allOk = false;
  }

  console.log('');
  if (allOk) {
    console.log('🎉 7개 Variant 전부 검증 통과. opt-in 통합 테스트를 진행할 수 있습니다.');
    return 0;
  }
  console.log('⚠️  일부 Variant 가 검증되지 않았습니다. SHOPIFY_ENABLED=true 로 전환하지 마세요.');
  return 1;
}

// process.exit() 를 즉시 호출하면 fetch(undici) 의 소켓 핸들이 닫히는 도중
// 프로세스가 끊겨 Windows 에서 libuv assertion 이 발생한다. exitCode 만 지정하고
// 이벤트 루프가 자연스럽게 비워지도록 둔다.
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // 원본 오류 메시지에 Token/GID 가 섞일 수 있으므로 이름만 출력한다.
      console.error(`❌ 검증 중 오류가 발생했습니다: ${error.name}`);
      process.exitCode = 1;
    });
}

module.exports = { buildLocalStatuses, resolveRemoteStatus, LOCAL_STATUS };
