const { validate: isUuid } = require('uuid');
const { agentError } = require('../shared/agentResponse');
const { computeContextHash } = require('../services/contextSnapshotService');
const { recommendProducts } = require('../services/productRecommendationService');
const { isVariantConfigured } = require('../catalog/shopifyVariantMapping');
const { loadShopifyConfig } = require('../config/shopifyConfig');
const defaultAgentRepository = require('../repositories/agentRepository');

// GET /api/agent/sessions/:sessionId/product-recommendations
//
// 이 엔드포인트는 외부 API를 전혀 호출하지 않는다(Gemini/Shopify 0회).
// Shopify secret이나 Variant GID가 하나도 없어도 정상 동작해야 하며,
// Shopify 관련 정보는 "로컬 설정 상태"만 표시한다.

const ERROR_STATUS_MAP = {
  AGENT_SESSION_NOT_FOUND: 404,
  AGENT_SESSION_NOT_READY: 409,
  AGENT_SESSION_EXPIRED: 410,
  AGENT_CONTEXT_INTEGRITY_ERROR: 500,
};

async function getProductRecommendations(req, res, deps = {}) {
  const sessionRepository = deps.sessionRepository || defaultAgentRepository;
  const now = deps.now || (() => new Date());
  const configLoader = deps.loadShopifyConfig || loadShopifyConfig;

  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId)) {
      return agentError(res, 400, 'VALIDATION_ERROR', 'sessionId는 유효한 UUID 형식이어야 합니다.');
    }

    const userId = req.agentUser.id;
    const session = await sessionRepository.findByIdAndUser(sessionId, userId);
    if (!session) {
      return agentError(res, 404, 'AGENT_SESSION_NOT_FOUND', '해당 세션을 찾을 수 없습니다.');
    }
    if (session.status !== 'ready') {
      return agentError(res, 409, 'AGENT_SESSION_NOT_READY', '세션이 ready 상태가 아닙니다.');
    }
    if (session.expires_at && new Date(session.expires_at).getTime() <= now().getTime()) {
      return agentError(res, 410, 'AGENT_SESSION_EXPIRED', '세션이 만료되었습니다.');
    }
    if (!session.context_snapshot || !session.context_hash) {
      return agentError(res, 500, 'AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot이 존재하지 않습니다.');
    }
    if (computeContextHash(session.context_snapshot) !== session.context_hash) {
      return agentError(res, 500, 'AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot 무결성 검증에 실패했습니다.');
    }

    // 6A-1 추천 로직은 그대로 사용하고(무변경), Shopify 설정 상태만 덧붙인다.
    const recommendation = recommendProducts({
      sessionId,
      contextHash: session.context_hash,
      contextSnapshot: session.context_snapshot,
    });

    // 설정 로딩이 실패해도(형식 오류 등) 추천 자체는 실패시키지 않는다.
    let shopifyCartApiEnabled = false;
    let variantMapping = null;
    try {
      const config = configLoader(process.env);
      shopifyCartApiEnabled = config.enabled;
      variantMapping = config.variantMapping;
    } catch (error) {
      shopifyCartApiEnabled = false;
      variantMapping = null;
    }

    const items = recommendation.items.map((item) => ({
      ...item,
      // 로컬에 형식이 유효하고 중복되지 않은 GID가 설정됐는지만 의미한다.
      // availableForSale/재고/게시 상태/가격/Checkout 성공을 보장하지 않는다.
      shopify_variant_configured: variantMapping ? isVariantConfigured(item.product_key, variantMapping) : false,
    }));

    const allConfigured = items.length > 0 && items.every((item) => item.shopify_variant_configured);

    return res.status(200).json({
      success: true,
      data: {
        catalog_version: recommendation.catalog_version,
        ruleset_version: recommendation.ruleset_version,
        proposal_hash: recommendation.proposal_hash,
        shopify_cart_api_enabled: shopifyCartApiEnabled,
        all_recommended_variants_configured: allConfigured,
        items,
        // 비진단적 안전 안내(예: 치아 통증 시 치과 상담 권유). 상품 추천과
        // 분리되어 있고 Shopify Cart로 전달되지 않는다.
        safety_notices: recommendation.safety_notices,
        disclaimer: recommendation.disclaimer,
      },
    });
  } catch (error) {
    const status = ERROR_STATUS_MAP[error.code];
    if (status) {
      return agentError(res, status, error.code, error.message);
    }
    console.error('Agent getProductRecommendations Error:', error.message);
    return agentError(res, 500, 'AGENT_INTERNAL_ERROR', '상품 추천 조회 중 오류가 발생했습니다.');
  }
}

module.exports = { getProductRecommendations };
