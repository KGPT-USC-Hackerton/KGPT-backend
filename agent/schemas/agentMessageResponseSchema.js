// ============================================================================
// BloomDent Agent — Gemini 최종 응답 JSON Schema (SDK 독립)
// ----------------------------------------------------------------------------
// 이 파일은 @google/genai를 import하지 않는다. 순수 JSON Schema(소문자 type)와
// hand-rolled 검증 함수만 export한다 — SDK 경계는 agent/adapters/geminiAdapter.js
// 한 곳에만 존재해야 한다는 원칙(CLAUDE.md 이번 단계 승인 사항).
//
// 비용 숫자 정책: Gemini의 자유 텍스트 content에는 비용 숫자(예: "$150", "80 USD")를
// 절대 포함시키지 않는다. 실제 min/max 금액은 서버가 tool_results(구조화 데이터)로만
// 전달한다. content는 정규식으로 걸러내는 데 그치지 않고, 서버가 별도의 고정 안내
// 문구로 치환하는 정규화를 함께 적용한다(agent/services/agentMessageService.js).
// ============================================================================

const ALLOWED_SOURCE_TYPES = ['image_analysis', 'survey', 'cost_tool'];
const ALLOWED_POSITIONS = ['upper', 'lower', 'front'];
const ALLOWED_TOOL_NAMES = ['calculate_oop_cost'];

const LIMITS = Object.freeze({
  MAX_CONTENT_LENGTH: 4000,
  MAX_EVIDENCE_ITEMS: 5,
  MAX_USED_TOOL_RESULTS: 3,
  MAX_REFERENCE_LENGTH: 200,
});

// Gemini SDK의 responseJsonSchema 설정에 그대로 전달할 순수 JSON Schema.
// SDK 공식 function-calling 예제(parametersJsonSchema)도 Type enum 없이 소문자
// 'object'/'string' 등을 그대로 쓰고 있어 동일 컨벤션을 따른다.
const AGENT_MESSAGE_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    content: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_type: { type: 'string', enum: ALLOWED_SOURCE_TYPES },
          position: {
            type: 'string',
            enum: ALLOWED_POSITIONS,
            description: "source_type이 image_analysis일 때만: 근거가 된 사진의 position 값 그대로('upper'/'lower'/'front').",
          },
          reference: {
            type: 'string',
            description:
              "이 근거를 식별할 수 있는 짧고 정확한 값만 넣는다(설명 문장 금지). " +
              "source_type='image_analysis'면 position과 동일한 값('upper'/'lower'/'front')만, " +
              "source_type='survey'면 trusted_context의 survey.responses[].category 값 그대로만, " +
              "source_type='cost_tool'이면 이번 대화에서 Tool 실행 결과로 받은 tool_execution_ref 값 그대로만 넣는다.",
          },
        },
        required: ['source_type', 'reference'],
      },
    },
    used_tool_results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', enum: ALLOWED_TOOL_NAMES },
          // 실제 DB tool_run_id가 아니라 서버가 부여한 임시 참조 토큰(tool_call_1 등).
          // 실제 DB id는 절대 모델에게 요구하거나 보여주지 않는다.
          tool_execution_ref: { type: 'string' },
        },
        required: ['tool_name', 'tool_execution_ref'],
      },
    },
    needs_professional_review: { type: 'boolean' },
    disclaimer: { type: 'string' },
  },
  required: ['content', 'evidence', 'used_tool_results', 'needs_professional_review', 'disclaimer'],
});

// content에 비용류 숫자(달러 기호, dollars/usd/원 단위)가 있는지 감지한다.
// 이 패턴에 걸리면 서버가 content 전체를 고정 안내 문구로 치환한다(정규식만으로
// "검증했다"고 주장하지 않기 위해 — 실제 방어는 치환 정규화가 담당).
const COST_LIKE_NUMBER_PATTERN = /\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|usd|원)\b/i;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gemini의 최종 JSON 출력을 서버가 독립적으로 재검증한다.
 * SDK의 responseJsonSchema 통과 여부와 무관하게 항상 이 함수를 통과해야 신뢰한다.
 * 반환: { valid: true, value } | { valid: false, reason }
 */
function validateAgentMessageResponse(parsed) {
  if (!isPlainObject(parsed)) {
    return { valid: false, reason: 'NOT_AN_OBJECT' };
  }

  const allowedTopKeys = ['content', 'evidence', 'used_tool_results', 'needs_professional_review', 'disclaimer'];
  for (const key of Object.keys(parsed)) {
    if (!allowedTopKeys.includes(key)) {
      return { valid: false, reason: `UNKNOWN_FIELD:${key}` };
    }
  }

  if (typeof parsed.content !== 'string' || parsed.content.length === 0 || parsed.content.length > LIMITS.MAX_CONTENT_LENGTH) {
    return { valid: false, reason: 'INVALID_CONTENT' };
  }
  // 비용 숫자 정책은 여기서 구조적으로 거부하지 않는다 — Tool을 사용한 경우
  // (used_tool_results 비어있지 않음) 서비스 레이어가 content를 고정 안내
  // 문구로 정규화하고, Tool을 사용하지 않았는데 비용류 숫자가 있는 경우에만
  // 서비스 레이어가 이를 거부한다(agent/services/agentMessageService.js).
  // COST_LIKE_NUMBER_PATTERN은 그 판단에 재사용할 수 있도록 export만 한다.

  if (!Array.isArray(parsed.evidence) || parsed.evidence.length > LIMITS.MAX_EVIDENCE_ITEMS) {
    return { valid: false, reason: 'INVALID_EVIDENCE' };
  }
  for (const item of parsed.evidence) {
    if (!isPlainObject(item)) return { valid: false, reason: 'INVALID_EVIDENCE_ITEM' };
    if (!ALLOWED_SOURCE_TYPES.includes(item.source_type)) return { valid: false, reason: 'INVALID_EVIDENCE_SOURCE_TYPE' };
    if (item.position !== undefined && !ALLOWED_POSITIONS.includes(item.position)) {
      return { valid: false, reason: 'INVALID_EVIDENCE_POSITION' };
    }
    if (typeof item.reference !== 'string' || item.reference.length === 0 || item.reference.length > LIMITS.MAX_REFERENCE_LENGTH) {
      return { valid: false, reason: 'INVALID_EVIDENCE_REFERENCE' };
    }
  }

  if (!Array.isArray(parsed.used_tool_results) || parsed.used_tool_results.length > LIMITS.MAX_USED_TOOL_RESULTS) {
    return { valid: false, reason: 'INVALID_USED_TOOL_RESULTS' };
  }
  for (const item of parsed.used_tool_results) {
    if (!isPlainObject(item)) return { valid: false, reason: 'INVALID_USED_TOOL_RESULT_ITEM' };
    if (!ALLOWED_TOOL_NAMES.includes(item.tool_name)) return { valid: false, reason: 'INVALID_TOOL_NAME' };
    if (typeof item.tool_execution_ref !== 'string' || item.tool_execution_ref.length === 0) {
      return { valid: false, reason: 'INVALID_TOOL_EXECUTION_REF' };
    }
  }

  if (typeof parsed.needs_professional_review !== 'boolean') {
    return { valid: false, reason: 'INVALID_NEEDS_PROFESSIONAL_REVIEW' };
  }
  if (typeof parsed.disclaimer !== 'string' || parsed.disclaimer.length === 0) {
    return { valid: false, reason: 'INVALID_DISCLAIMER' };
  }

  return { valid: true, value: parsed };
}

module.exports = {
  AGENT_MESSAGE_RESPONSE_JSON_SCHEMA,
  validateAgentMessageResponse,
  COST_LIKE_NUMBER_PATTERN,
  ALLOWED_SOURCE_TYPES,
  ALLOWED_POSITIONS,
  ALLOWED_TOOL_NAMES,
  LIMITS,
};
