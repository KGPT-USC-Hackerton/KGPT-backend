// ============================================================================
// BloomDent Agent — calculateOopCost (V1, 결정론적 순수 함수)
// ----------------------------------------------------------------------------
// DB, Express, 환경 변수, 네트워크에 의존하지 않는다. LLM은 이 함수를 호출하지
// 않고(다음 단계 범위), 가격/할인율/보장률/CDT 코드/치료 조합도 생성하지 않는다.
// 이번 V1은 docs/BloomDent_Agentic_Copilot_Architecture_Revised_Updated.md §5.1의
// 전체 스펙이 아니라 사용자 승인을 받은 축소판이다(§5.1 상단 superseded 주석 참고):
//   - USC 학생 할인/신분 할인/Student Clinic 할인 없음(is_usc_student 입력 자체를 받지 않음)
//   - 실제 보험사 보장률/공제액/연간한도/coinsurance 추정 없음
//   - 프로젝트 내부 버전 관리된 synthetic demo fee schedule만 사용
//   - candidate_procedures(cdt_code 기반) 대신 scenarios[].procedures[] 구조
// ============================================================================

const { PROCEDURES, PROCEDURE_IDS, FEE_SCHEDULE_VERSION, SOURCE_TYPE, DISCLAIMER } = require('../data/demoFeeSchedule');
const { deepFreeze } = require('../shared/deepFreeze');

const ALLOWED_COVERAGE_STATUSES = ['uninsured', 'insured', 'unknown'];
const TOP_LEVEL_ALLOWED_KEYS = ['coverage_status', 'scenarios'];
const SCENARIO_ALLOWED_KEYS = ['scenario_id', 'procedures'];
const PROCEDURE_ALLOWED_KEYS = ['procedure_id', 'quantity'];

const LIMITS = Object.freeze({
  MAX_SCENARIOS: 10,
  MAX_PROCEDURES_PER_SCENARIO: 20,
  SCENARIO_ID_MIN_LENGTH: 1,
  SCENARIO_ID_MAX_LENGTH: 100,
  QUANTITY_MIN: 1,
  QUANTITY_MAX: 5,
});

const ERROR_CODES = Object.freeze({
  INVALID_INPUT_TYPE: 'INVALID_INPUT_TYPE',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  MISSING_COVERAGE_STATUS: 'MISSING_COVERAGE_STATUS',
  INVALID_COVERAGE_STATUS: 'INVALID_COVERAGE_STATUS',
  EMPTY_SCENARIOS: 'EMPTY_SCENARIOS',
  MAX_SCENARIOS_EXCEEDED: 'MAX_SCENARIOS_EXCEEDED',
  INVALID_SCENARIO: 'INVALID_SCENARIO',
  INVALID_SCENARIO_ID_LENGTH: 'INVALID_SCENARIO_ID_LENGTH',
  DUPLICATE_SCENARIO_ID: 'DUPLICATE_SCENARIO_ID',
  EMPTY_PROCEDURES: 'EMPTY_PROCEDURES',
  MAX_PROCEDURES_EXCEEDED: 'MAX_PROCEDURES_EXCEEDED',
  INVALID_PROCEDURE: 'INVALID_PROCEDURE',
  UNKNOWN_PROCEDURE_ID: 'UNKNOWN_PROCEDURE_ID',
  DUPLICATE_PROCEDURE_ID: 'DUPLICATE_PROCEDURE_ID',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  COST_OVERFLOW: 'COST_OVERFLOW',
});

class CalculateOopCostError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CalculateOopCostError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new CalculateOopCostError(code, message, details);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoUnknownKeys(obj, allowedKeys, context) {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      fail(ERROR_CODES.UNKNOWN_FIELD, `허용되지 않은 필드입니다: ${key} (${context})`, { context, field: key });
    }
  }
}

/**
 * calculateOopCost 입력을 검증한다. 위반 시 CalculateOopCostError 를 throw 한다
 * (fail-fast: 첫 위반에서 즉시 중단, 부분 검증 결과를 반환하지 않는다).
 */
function validateCalculateOopCostInput(input) {
  if (!isPlainObject(input)) {
    fail(ERROR_CODES.INVALID_INPUT_TYPE, '입력은 object 여야 합니다.');
  }

  assertNoUnknownKeys(input, TOP_LEVEL_ALLOWED_KEYS, 'top-level');

  if (input.coverage_status === undefined) {
    fail(ERROR_CODES.MISSING_COVERAGE_STATUS, 'coverage_status는 필수입니다.');
  }
  if (!ALLOWED_COVERAGE_STATUSES.includes(input.coverage_status)) {
    fail(
      ERROR_CODES.INVALID_COVERAGE_STATUS,
      `coverage_status는 ${ALLOWED_COVERAGE_STATUSES.join('/')} 중 하나여야 합니다.`,
      { value: input.coverage_status }
    );
  }

  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    fail(ERROR_CODES.EMPTY_SCENARIOS, 'scenarios는 최소 1개 이상의 배열이어야 합니다.');
  }
  if (input.scenarios.length > LIMITS.MAX_SCENARIOS) {
    fail(ERROR_CODES.MAX_SCENARIOS_EXCEEDED, `scenarios는 최대 ${LIMITS.MAX_SCENARIOS}개까지 허용됩니다.`, {
      count: input.scenarios.length,
      max: LIMITS.MAX_SCENARIOS,
    });
  }

  const seenScenarioIds = new Set();

  input.scenarios.forEach((scenario, scenarioIndex) => {
    if (!isPlainObject(scenario)) {
      fail(ERROR_CODES.INVALID_SCENARIO, `scenarios[${scenarioIndex}]는 object여야 합니다.`, { index: scenarioIndex });
    }
    assertNoUnknownKeys(scenario, SCENARIO_ALLOWED_KEYS, `scenarios[${scenarioIndex}]`);

    if (typeof scenario.scenario_id !== 'string') {
      fail(ERROR_CODES.INVALID_SCENARIO, `scenarios[${scenarioIndex}].scenario_id는 문자열이어야 합니다.`, {
        index: scenarioIndex,
      });
    }
    if (
      scenario.scenario_id.length < LIMITS.SCENARIO_ID_MIN_LENGTH ||
      scenario.scenario_id.length > LIMITS.SCENARIO_ID_MAX_LENGTH
    ) {
      fail(
        ERROR_CODES.INVALID_SCENARIO_ID_LENGTH,
        `scenario_id는 ${LIMITS.SCENARIO_ID_MIN_LENGTH}~${LIMITS.SCENARIO_ID_MAX_LENGTH}자여야 합니다.`,
        { scenario_id: scenario.scenario_id, length: scenario.scenario_id.length }
      );
    }
    if (seenScenarioIds.has(scenario.scenario_id)) {
      fail(ERROR_CODES.DUPLICATE_SCENARIO_ID, `scenario_id가 중복되었습니다: ${scenario.scenario_id}`, {
        scenario_id: scenario.scenario_id,
      });
    }
    seenScenarioIds.add(scenario.scenario_id);

    if (!Array.isArray(scenario.procedures) || scenario.procedures.length === 0) {
      fail(
        ERROR_CODES.EMPTY_PROCEDURES,
        `scenarios[${scenarioIndex}].procedures는 최소 1개 이상의 배열이어야 합니다.`,
        { scenario_id: scenario.scenario_id }
      );
    }
    if (scenario.procedures.length > LIMITS.MAX_PROCEDURES_PER_SCENARIO) {
      fail(
        ERROR_CODES.MAX_PROCEDURES_EXCEEDED,
        `scenario당 procedures는 최대 ${LIMITS.MAX_PROCEDURES_PER_SCENARIO}개까지 허용됩니다.`,
        { scenario_id: scenario.scenario_id, count: scenario.procedures.length, max: LIMITS.MAX_PROCEDURES_PER_SCENARIO }
      );
    }

    const seenProcedureIds = new Set();

    scenario.procedures.forEach((procedure, procedureIndex) => {
      if (!isPlainObject(procedure)) {
        fail(
          ERROR_CODES.INVALID_PROCEDURE,
          `scenarios[${scenarioIndex}].procedures[${procedureIndex}]는 object여야 합니다.`,
          { scenario_id: scenario.scenario_id, index: procedureIndex }
        );
      }
      assertNoUnknownKeys(procedure, PROCEDURE_ALLOWED_KEYS, `scenarios[${scenarioIndex}].procedures[${procedureIndex}]`);

      if (typeof procedure.procedure_id !== 'string' || !PROCEDURE_IDS.includes(procedure.procedure_id)) {
        fail(
          ERROR_CODES.UNKNOWN_PROCEDURE_ID,
          `지원하지 않는 procedure_id입니다: ${procedure.procedure_id}`,
          { scenario_id: scenario.scenario_id, procedure_id: procedure.procedure_id }
        );
      }
      if (seenProcedureIds.has(procedure.procedure_id)) {
        fail(
          ERROR_CODES.DUPLICATE_PROCEDURE_ID,
          `같은 scenario 안에서 procedure_id가 중복되었습니다: ${procedure.procedure_id}`,
          { scenario_id: scenario.scenario_id, procedure_id: procedure.procedure_id }
        );
      }
      seenProcedureIds.add(procedure.procedure_id);

      if (
        typeof procedure.quantity !== 'number' ||
        !Number.isInteger(procedure.quantity) ||
        procedure.quantity < LIMITS.QUANTITY_MIN ||
        procedure.quantity > LIMITS.QUANTITY_MAX
      ) {
        fail(
          ERROR_CODES.INVALID_QUANTITY,
          `quantity는 ${LIMITS.QUANTITY_MIN}~${LIMITS.QUANTITY_MAX} 사이의 정수여야 합니다.`,
          { scenario_id: scenario.scenario_id, procedure_id: procedure.procedure_id, value: procedure.quantity }
        );
      }
    });
  });
}

/**
 * 합계가 안전한 정수 범위(Number.isSafeInteger)를 벗어나면 COST_OVERFLOW 로 거부한다.
 * 현재 fee schedule/한도로는 실제로 도달하지 않지만, 계산 로직과 분리해 두어
 * 별도로 직접 테스트할 수 있게 한다.
 */
function assertSafeIntegerCost(value, context) {
  if (!Number.isSafeInteger(value)) {
    fail(ERROR_CODES.COST_OVERFLOW, '계산된 비용이 안전한 정수 범위를 벗어났습니다.', { ...context, value });
  }
}

function calculateUninsuredEstimate(scenario) {
  let min = 0;
  let max = 0;

  for (const procedure of scenario.procedures) {
    const fee = PROCEDURES[procedure.procedure_id];
    min += fee.min * procedure.quantity;
    max += fee.max * procedure.quantity;
  }

  assertSafeIntegerCost(min, { scenario_id: scenario.scenario_id, bound: 'min' });
  assertSafeIntegerCost(max, { scenario_id: scenario.scenario_id, bound: 'max' });

  return {
    scenario_id: scenario.scenario_id,
    estimated_oop: { min, max },
    assumptions: ['Uninsured self-pay demo scenario', 'Synthetic demo fee schedule, not an actual clinic quote'],
    confidence: 'medium',
  };
}

function buildNeedsMoreInformationEstimate(scenario, coverageStatus) {
  const assumptions =
    coverageStatus === 'insured'
      ? ['Insurance coverage details not provided; out-of-pocket cannot be estimated']
      : ['Coverage status unknown; out-of-pocket cannot be estimated'];

  return {
    scenario_id: scenario.scenario_id,
    estimated_oop: null,
    assumptions,
    confidence: 'unknown',
  };
}

/**
 * LLM 없이 동작하는 결정론적 순수 함수. 입력이 유효하지 않으면
 * CalculateOopCostError(.code 로 판별 가능)를 throw 하고, 그 외에는 항상
 * 같은 입력 + 같은 fee schedule version에 대해 같은 구조화된 JSON을 반환한다.
 * 입력 객체는 어떤 경우에도 mutate 하지 않는다.
 */
function calculateOopCost(input) {
  validateCalculateOopCostInput(input);

  const { coverage_status: coverageStatus, scenarios } = input;

  const estimates = scenarios.map((scenario) =>
    coverageStatus === 'uninsured'
      ? calculateUninsuredEstimate(scenario)
      : buildNeedsMoreInformationEstimate(scenario, coverageStatus)
  );

  const status = coverageStatus === 'uninsured' ? 'estimated' : 'needs_more_information';

  let missingInformation = [];
  if (coverageStatus === 'insured') {
    missingInformation = ['allowed_amount', 'deductible_remaining', 'coinsurance_rate'];
  } else if (coverageStatus === 'unknown') {
    missingInformation = ['confirmation_of_insurance_status'];
  }

  return deepFreeze({
    status,
    currency: 'USD',
    fee_schedule_version: FEE_SCHEDULE_VERSION,
    source_type: SOURCE_TYPE,
    estimates,
    missing_information: missingInformation,
    clinical_confirmation_required: true,
    is_guaranteed: false,
    disclaimer: DISCLAIMER,
  });
}

module.exports = {
  calculateOopCost,
  validateCalculateOopCostInput,
  assertSafeIntegerCost,
  CalculateOopCostError,
  ERROR_CODES,
  LIMITS,
};
