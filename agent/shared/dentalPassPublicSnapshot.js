// context_snapshot 전체를 그대로 공개하지 않고, 허용된 필드만 골라 담는
// Allowlist 기반 순수 함수. DB/Express에 의존하지 않는다.

const DENTAL_PASS_PUBLIC_SCHEMA_VERSION = 'dental-pass-public-v1';

const DENTAL_PASS_DISCLAIMER =
  '이 Dental Pass는 접수와 상담을 돕기 위한 참고 자료이며 확정 진단, 치료 계획, 보험 보장 보증이 아닙니다. ' +
  '정확한 진단과 비용은 반드시 치과에서 임상 검사를 받아 확인해야 합니다.';

// 공개 응답에 포함할 필드만 명시적으로 선택한다(ai_confidence, cavity_locations,
// llm_summary, 보험 정보, 비용 추정 등은 의도적으로 제외).
function buildDentalPassPublicSnapshot(contextSnapshot) {
  const images = (contextSnapshot?.images || []).map((image) => ({
    position: image.position,
    occlusion_status: image.occlusion_status,
    cavity_detected: !!image.cavity_detected,
    overall_score: image.overall_score,
    recommendations: image.recommendations,
  }));

  return {
    schema_version: DENTAL_PASS_PUBLIC_SCHEMA_VERSION,
    images,
    survey: null,
    disclaimer: DENTAL_PASS_DISCLAIMER,
  };
}

module.exports = {
  DENTAL_PASS_PUBLIC_SCHEMA_VERSION,
  DENTAL_PASS_DISCLAIMER,
  buildDentalPassPublicSnapshot,
};
