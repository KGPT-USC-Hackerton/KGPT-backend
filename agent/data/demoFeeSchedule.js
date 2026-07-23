// ============================================================================
// BloomDent Agent — Synthetic Demo Fee Schedule (V1)
// ----------------------------------------------------------------------------
// 아래 금액은 실제 병원 견적, 공식 수가, 보험 허용금액이 아니다.
// 해커톤 데모용으로 프로젝트 내부에서 버전 관리하는 synthetic 값이며,
// calculateOopCost 응답의 source_type: "synthetic_demo" 로 항상 함께 표시된다.
//
// 이 파일은 docs/BloomDent_Agentic_Copilot_Architecture_Revised_Updated.md §5.1의
// 전체 스펙이 아니라, 사용자 승인을 받은 축소 V1 범위다(USC 학생 할인, 실제 보험
// 보장률·공제액·연간한도 추정, 실제 USC/병원 가격 연동은 전부 제외). §5.1 상단의
// superseded 주석 참고.
//
// 값 자체와 중첩 객체(min/max)까지 런타임에 변경되지 않도록 deepFreeze 한다.
// ============================================================================

const { deepFreeze } = require('../shared/deepFreeze');

const FEE_SCHEDULE_VERSION = 'bloomdent-demo-2026-07';
const SOURCE_TYPE = 'synthetic_demo';

const PROCEDURES = {
  initial_evaluation: { min: 80, max: 150 },
  basic_restorative_candidate: { min: 150, max: 300 },
  follow_up_review: { min: 40, max: 80 },
};

const PROCEDURE_IDS = Object.keys(PROCEDURES);

const DISCLAIMER =
  'This is a synthetic demo estimate for hackathon purposes. It is not a diagnosis, treatment plan, clinic quote, or guarantee of insurance benefits.';

module.exports = deepFreeze({
  FEE_SCHEDULE_VERSION,
  SOURCE_TYPE,
  PROCEDURES,
  PROCEDURE_IDS,
  DISCLAIMER,
});
