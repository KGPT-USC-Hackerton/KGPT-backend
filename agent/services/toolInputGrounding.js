// ============================================================================
// BloomDent Agent — calculate_oop_cost 입력 근거(grounding) 검증
// ----------------------------------------------------------------------------
// calculateOopCost.js의 스키마 검증(구조/타입)과는 별개로, 이 모듈은 "이 Tool
// 호출이 실제 Context Snapshot과 사용자 발화에 근거하는가"를 서버가 독립적으로
// 판단한다. LLM이 스스로 판단했다는 사실을 신뢰하지 않는다.
//
// DB/SDK/네트워크 의존 없는 순수 함수 — FakeAdapter 없이도 단위 테스트 가능.
// ============================================================================

const COST_QUESTION_PATTERN = /(cost|price|얼마|비용|가격|estimate|out.?of.?pocket|\boop\b)/i;
const FOLLOW_UP_PATTERN = /(follow.?up|다시\s*확인|재확인|후속|check\s*again|recheck|업데이트)/i;
const HYPOTHETICAL_PATTERN = /(what\s*if|hypothetical(ly)?|가정|만약|what\s*would)/i;
// 한국어 조사("은/는/이/가")가 "보험"과 서술어 사이에 붙는 경우(예: "보험이 없어요")를
// 포함하기 위해 조사를 선택적으로 허용한다.
const INSURED_STATEMENT_PATTERN = /(i\s*have\s*insurance|보험\s*(이|가|은|는)?\s*(있|가입)|insured|my\s*insurance)/i;
const UNINSURED_STATEMENT_PATTERN = /(no\s*insurance|uninsured|보험\s*(이|가|은|는)?\s*(없|no)|don'?t\s*have\s*insurance)/i;

function textContainsAny(texts, pattern) {
  return (texts || []).some((text) => typeof text === 'string' && pattern.test(text));
}

/**
 * calculate_oop_cost 호출 입력이 근거를 갖는지 검증하고, coverage_status를
 * 필요 시 안전한 값('unknown')으로 서버가 직접 보정한다.
 *
 * 반환:
 *   { valid: true, correctedInput }  — correctedInput은 원본을 얕은 복사한 뒤
 *     coverage_status만 필요 시 교체한 새 객체(원본 mutate 안 함).
 *   { valid: false, violations: [{ procedure_id, reason }] }
 */
function validateToolInputGrounding({ toolInput, contextSnapshot, userMessage, recentMessageTexts }) {
  const allTexts = [userMessage, ...(recentMessageTexts || [])];

  const hasCavityDetected = (contextSnapshot?.images || []).some((image) => image.cavity_detected === true);
  const isCostQuestion = textContainsAny(allTexts, COST_QUESTION_PATTERN);
  const isFollowUp = textContainsAny(allTexts, FOLLOW_UP_PATTERN);
  const isHypothetical = textContainsAny(allTexts, HYPOTHETICAL_PATTERN);

  const violations = [];

  for (const scenario of toolInput.scenarios || []) {
    for (const procedure of scenario.procedures || []) {
      if (procedure.procedure_id === 'initial_evaluation' && !isCostQuestion) {
        violations.push({ procedure_id: procedure.procedure_id, reason: 'NOT_A_COST_QUESTION' });
      }
      if (procedure.procedure_id === 'follow_up_review' && !isFollowUp) {
        violations.push({ procedure_id: procedure.procedure_id, reason: 'NOT_A_FOLLOW_UP_QUESTION' });
      }
      if (procedure.procedure_id === 'basic_restorative_candidate' && !hasCavityDetected && !isHypothetical) {
        violations.push({ procedure_id: procedure.procedure_id, reason: 'NO_CAVITY_DETECTED_AND_NOT_HYPOTHETICAL' });
      }
    }
  }

  if (violations.length > 0) {
    return { valid: false, violations };
  }

  const statedInsured = textContainsAny(allTexts, INSURED_STATEMENT_PATTERN);
  const statedUninsured = textContainsAny(allTexts, UNINSURED_STATEMENT_PATTERN);
  const coverageStatusStated = statedInsured || statedUninsured;

  const correctedInput = {
    ...toolInput,
    coverage_status: coverageStatusStated ? toolInput.coverage_status : 'unknown',
  };

  return { valid: true, correctedInput };
}

module.exports = { validateToolInputGrounding };
