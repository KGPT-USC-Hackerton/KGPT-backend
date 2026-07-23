// ============================================================================
// BloomDent Agent — Tool Allowlist (V1: calculate_oop_cost 단 하나)
// ----------------------------------------------------------------------------
// @google/genai를 import하지 않는다(순수 JSON 선언). geminiAdapter.js가 이
// 선언을 그대로 tools:[{functionDeclarations:[...]}] 에 실어 SDK에 전달한다.
// 이 파일이 "서버가 승인한 Tool" 목록의 유일한 출처다 — 다른 어떤 곳에서도
// Tool 이름을 하드코딩하지 않는다.
// ============================================================================

const { calculateOopCost, validateCalculateOopCostInput, CalculateOopCostError } = require('./calculateOopCost');

const CALCULATE_OOP_COST_TOOL_NAME = 'calculate_oop_cost';

// SDK 공식 function-calling 예제의 parametersJsonSchema와 동일하게 소문자 JSON
// Schema 사용(Type enum 불필요).
const CALCULATE_OOP_COST_DECLARATION = Object.freeze({
  name: CALCULATE_OOP_COST_TOOL_NAME,
  description:
    'BloomDent 내부 synthetic demo fee schedule을 기준으로 결정론적 본인부담금 추정치를 계산한다. ' +
    '실제 병원 가격이나 보험 보장률을 계산하지 않는다. ' +
    '여러 비용 시나리오가 필요하면 이 Tool을 여러 번 호출하지 말고, ' +
    '한 번의 호출 안에서 scenarios 배열에 전부 담아 전달해야 한다.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      coverage_status: { type: 'string', enum: ['uninsured', 'insured', 'unknown'] },
      scenarios: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            scenario_id: { type: 'string' },
            procedures: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  procedure_id: {
                    type: 'string',
                    enum: ['initial_evaluation', 'basic_restorative_candidate', 'follow_up_review'],
                  },
                  quantity: { type: 'integer', minimum: 1, maximum: 5 },
                },
                required: ['procedure_id', 'quantity'],
              },
            },
          },
          required: ['scenario_id', 'procedures'],
        },
      },
    },
    required: ['coverage_status', 'scenarios'],
  },
});

const ALLOWED_TOOL_NAMES = Object.freeze([CALCULATE_OOP_COST_TOOL_NAME]);

/**
 * 허용 목록에 있는 Tool만 실행한다. 이름이 다르면 실행하지 않고 예외를 던진다.
 * calculateOopCost 자체의 스키마 검증(CalculateOopCostError)은 그대로 던져
 * 호출부(agentMessageService)가 tool-input-invalid로 처리하게 한다.
 */
function executeTool(toolName, toolInput) {
  if (toolName !== CALCULATE_OOP_COST_TOOL_NAME) {
    const err = new Error(`허용되지 않은 Tool입니다: ${toolName}`);
    err.code = 'TOOL_NOT_ALLOWED';
    throw err;
  }
  validateCalculateOopCostInput(toolInput);
  return calculateOopCost(toolInput);
}

module.exports = {
  CALCULATE_OOP_COST_TOOL_NAME,
  CALCULATE_OOP_COST_DECLARATION,
  ALLOWED_TOOL_NAMES,
  executeTool,
  CalculateOopCostError,
};
