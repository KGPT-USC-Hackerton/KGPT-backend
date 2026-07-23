// ============================================================================
// BloomDent Agent — 안전한 템플릿 Fallback 콘텐츠
// ----------------------------------------------------------------------------
// Gemini 실패/timeout/스키마 검증 실패 등 모든 이상 상황에서 사용하는 결정론적
// 콘텐츠 생성기. 저장된 Context Snapshot에서 확인 가능한 내용만 사용하고 새
// 임상 사실을 만들지 않는다. 비용 질문이었더라도 Tool을 실행하지 않았다면
// 숫자를 말하지 않는다(used_tool_results 항상 빈 배열).
// ============================================================================

const FALLBACK_DISCLAIMER =
  'This is a synthetic demo response for hackathon purposes. It is not a diagnosis, treatment plan, clinic quote, or guarantee of insurance benefits. Please consult a licensed dentist for an actual exam.';

/**
 * @param {object} params
 * @param {object} params.contextSnapshot
 * @param {string} params.fallbackReason - 내부 저장용 코드(예: 'GEMINI_TIMEOUT').
 *   HTTP 응답에는 절대 포함하지 않는다(DB content_json에만 저장).
 */
function buildTemplateFallbackContent({ contextSnapshot, fallbackReason }) {
  const images = contextSnapshot?.images || [];
  const flaggedImages = images.filter(
    (image) => image.cavity_detected === true || (image.occlusion_status && image.occlusion_status !== 'normal')
  );

  const content =
    flaggedImages.length > 0
      ? '지금은 자동 답변을 생성하지 못해 저장된 분석 결과를 기준으로 안내드립니다. 추가 확인이 필요한 소견이 있으니 반드시 치과에서 임상 검사를 받아주세요.'
      : '지금은 자동 답변을 생성하지 못했습니다. 저장된 분석 결과에서는 특별한 소견이 없었지만, 정기적인 치과 검진은 계속 권장드립니다.';

  const evidence = flaggedImages.map((image) => ({
    source_type: 'image_analysis',
    position: image.position,
    reference: image.position,
  }));

  return {
    content,
    evidence,
    used_tool_results: [],
    needs_professional_review: true,
    disclaimer: FALLBACK_DISCLAIMER,
    response_mode: 'template_fallback',
    fallback_reason: fallbackReason || 'UNKNOWN',
    model_name: null,
  };
}

module.exports = { buildTemplateFallbackContent, FALLBACK_DISCLAIMER };
