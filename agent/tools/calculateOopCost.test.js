'use strict';

/**
 * agent/tools/calculateOopCost.test.js
 * ----------------------------------------------------------------------------
 * calculateOopCost(순수 함수)에 대한 오프라인 테스트.
 * 백엔드에 test runner(jest)가 없으므로 표준 node:assert 로 작성.
 *
 * 'use strict' 를 파일 최상단에 둔 이유: frozen 객체에 대한 프로퍼티 할당이
 * strict 모드에서는 TypeError 를 던지므로, 아래 mutate 테스트에서
 * try/catch + 값 불변 확인을 안정적으로 검증할 수 있다.
 *
 * 실행: node agent/tools/calculateOopCost.test.js
 */

const assert = require('node:assert');
const {
  calculateOopCost,
  validateCalculateOopCostInput,
  assertSafeIntegerCost,
  CalculateOopCostError,
  ERROR_CODES,
  LIMITS,
} = require('./calculateOopCost');
const demoFeeSchedule = require('../data/demoFeeSchedule');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

function assertThrowsCode(fn, expectedCode) {
  assert.throws(
    fn,
    (err) => {
      assert.ok(err instanceof CalculateOopCostError, `CalculateOopCostError가 아닙니다: ${err}`);
      assert.strictEqual(err.code, expectedCode, `기대 code=${expectedCode}, 실제=${err.code}`);
      return true;
    }
  );
}

function mutationDoesNotStick(mutate, readBack, originalValue) {
  try {
    mutate();
  } catch (e) {
    // strict 모드에서는 frozen 객체 할당이 TypeError를 던진다 — 정상.
  }
  assert.strictEqual(readBack(), originalValue);
}

console.log('calculateOopCost 테스트\n');

// 1) uninsured 단일 procedure 계산
test('uninsured 단일 procedure 계산', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(result.status, 'estimated');
  assert.deepStrictEqual(result.estimates[0].estimated_oop, { min: 80, max: 150 });
  assert.strictEqual(result.estimates[0].confidence, 'medium');
});

// 2) uninsured 여러 procedure 합산
test('uninsured 여러 procedure 합산', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [
      {
        scenario_id: 's1',
        procedures: [
          { procedure_id: 'initial_evaluation', quantity: 1 },
          { procedure_id: 'follow_up_review', quantity: 1 },
        ],
      },
    ],
  });
  assert.deepStrictEqual(result.estimates[0].estimated_oop, { min: 80 + 40, max: 150 + 80 });
});

// 3) quantity 반영
test('quantity가 합계에 곱해져 반영된다', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'basic_restorative_candidate', quantity: 3 }] }],
  });
  assert.deepStrictEqual(result.estimates[0].estimated_oop, { min: 150 * 3, max: 300 * 3 });
});

// 4) 여러 scenario가 서로 독립 계산된다
test('여러 scenario는 서로 합산되지 않고 독립적으로 계산된다', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [
      { scenario_id: 'a', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] },
      { scenario_id: 'b', procedures: [{ procedure_id: 'basic_restorative_candidate', quantity: 1 }] },
    ],
  });
  assert.strictEqual(result.estimates.length, 2);
  assert.deepStrictEqual(result.estimates[0], {
    scenario_id: 'a',
    estimated_oop: { min: 80, max: 150 },
    assumptions: ['Uninsured self-pay demo scenario', 'Synthetic demo fee schedule, not an actual clinic quote'],
    confidence: 'medium',
  });
  assert.deepStrictEqual(result.estimates[1].estimated_oop, { min: 150, max: 300 });
});

// 5) insured -> needs_more_information
test('insured는 needs_more_information과 missing_information 3항목을 반환한다', () => {
  const result = calculateOopCost({
    coverage_status: 'insured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(result.status, 'needs_more_information');
  assert.strictEqual(result.estimates[0].estimated_oop, null);
  assert.strictEqual(result.estimates[0].confidence, 'unknown');
  assert.deepStrictEqual(result.missing_information, ['allowed_amount', 'deductible_remaining', 'coinsurance_rate']);
});

// 6) unknown -> needs_more_information
test('unknown은 needs_more_information과 confirmation_of_insurance_status를 반환한다', () => {
  const result = calculateOopCost({
    coverage_status: 'unknown',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(result.status, 'needs_more_information');
  assert.strictEqual(result.estimates[0].estimated_oop, null);
  assert.deepStrictEqual(result.missing_information, ['confirmation_of_insurance_status']);
});

// 7) 지원하지 않는 procedure_id 거부
test('지원하지 않는 procedure_id는 UNKNOWN_PROCEDURE_ID로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'root_canal', quantity: 1 }] }],
      }),
    ERROR_CODES.UNKNOWN_PROCEDURE_ID
  );
});

// 8) 중복 scenario_id 거부
test('중복 scenario_id는 DUPLICATE_SCENARIO_ID로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        scenarios: [
          { scenario_id: 'dup', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] },
          { scenario_id: 'dup', procedures: [{ procedure_id: 'follow_up_review', quantity: 1 }] },
        ],
      }),
    ERROR_CODES.DUPLICATE_SCENARIO_ID
  );
});

// 9) quantity 0/음수/소수/6이상 거부
test('quantity 0, 음수, 소수, 6 이상은 모두 INVALID_QUANTITY로 거부된다', () => {
  for (const quantity of [0, -1, 1.5, 6]) {
    assertThrowsCode(
      () =>
        calculateOopCost({
          coverage_status: 'uninsured',
          scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity }] }],
        }),
      ERROR_CODES.INVALID_QUANTITY
    );
  }
});

// 10) 빈 scenarios 거부
test('빈 scenarios는 EMPTY_SCENARIOS로 거부된다', () => {
  assertThrowsCode(() => calculateOopCost({ coverage_status: 'uninsured', scenarios: [] }), ERROR_CODES.EMPTY_SCENARIOS);
});

// 11) 빈 procedures 거부
test('빈 procedures는 EMPTY_PROCEDURES로 거부된다', () => {
  assertThrowsCode(
    () => calculateOopCost({ coverage_status: 'uninsured', scenarios: [{ scenario_id: 's1', procedures: [] }] }),
    ERROR_CODES.EMPTY_PROCEDURES
  );
});

// 12) 동일 입력은 항상 동일 출력
test('동일 입력은 항상 동일 출력을 반환한다(결정론)', () => {
  const input = {
    coverage_status: 'uninsured',
    scenarios: [
      {
        scenario_id: 's1',
        procedures: [
          { procedure_id: 'initial_evaluation', quantity: 2 },
          { procedure_id: 'follow_up_review', quantity: 1 },
        ],
      },
    ],
  };
  const first = calculateOopCost(input);
  const second = calculateOopCost(JSON.parse(JSON.stringify(input)));
  assert.deepStrictEqual(first, second);
});

// 13) 입력 객체를 mutate하지 않는다
test('입력 객체를 mutate하지 않는다', () => {
  const input = Object.freeze({
    coverage_status: 'uninsured',
    scenarios: Object.freeze([
      Object.freeze({
        scenario_id: 's1',
        procedures: Object.freeze([Object.freeze({ procedure_id: 'initial_evaluation', quantity: 1 })]),
      }),
    ]),
  });
  const snapshot = JSON.parse(JSON.stringify(input));
  calculateOopCost(input); // frozen 입력이므로 실제로 mutate를 시도했다면 여기서 TypeError가 난다
  assert.deepStrictEqual(input, snapshot);
});

// 14) 결과에 synthetic_demo / fee_schedule_version / disclaimer 포함
test('결과에 source_type=synthetic_demo, fee_schedule_version, disclaimer가 포함된다', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(result.source_type, 'synthetic_demo');
  assert.strictEqual(result.fee_schedule_version, 'bloomdent-demo-2026-07');
  assert.ok(typeof result.disclaimer === 'string' && result.disclaimer.length > 0);
});

// 15) 결과에 USC 관련 문구가 없다
test('결과 JSON에 USC/학생 할인 관련 문구가 전혀 없다', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'basic_restorative_candidate', quantity: 1 }] }],
  });
  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes('usc'), 'USC 관련 문구가 결과에 포함되면 안 됩니다');
  assert.ok(!serialized.includes('student'), '학생 할인 관련 문구가 결과에 포함되면 안 됩니다');
});

// 16) 결과에 실제 보험 보장률 추정치가 없다
test('insured 결과에 숫자로 된 보장률/공제액 추정치가 없고 missing_information 문자열만 있다', () => {
  const result = calculateOopCost({
    coverage_status: 'insured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(result.estimates[0].estimated_oop, null);
  assert.ok(result.missing_information.every((item) => typeof item === 'string'));
  const serialized = JSON.stringify(result);
  assert.ok(!/"allowed_amount"\s*:\s*\d/.test(serialized));
  assert.ok(!/"coinsurance_rate"\s*:\s*\d/.test(serialized));
});

// ---------------------------------------------------------------------------
// 이번 보완 사항: 입력 크기 제한
// ---------------------------------------------------------------------------

test('scenarios가 11개면 MAX_SCENARIOS_EXCEEDED로 거부된다', () => {
  const scenarios = Array.from({ length: LIMITS.MAX_SCENARIOS + 1 }, (_, i) => ({
    scenario_id: `s${i}`,
    procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }],
  }));
  assertThrowsCode(() => calculateOopCost({ coverage_status: 'uninsured', scenarios }), ERROR_CODES.MAX_SCENARIOS_EXCEEDED);
});

test('scenarios가 10개면 통과한다(경계값)', () => {
  const scenarios = Array.from({ length: LIMITS.MAX_SCENARIOS }, (_, i) => ({
    scenario_id: `s${i}`,
    procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }],
  }));
  const result = calculateOopCost({ coverage_status: 'uninsured', scenarios });
  assert.strictEqual(result.estimates.length, LIMITS.MAX_SCENARIOS);
});

test('scenario당 procedures가 21개면 MAX_PROCEDURES_EXCEEDED로 거부된다', () => {
  const procedures = Array.from({ length: LIMITS.MAX_PROCEDURES_PER_SCENARIO + 1 }, () => ({
    procedure_id: 'initial_evaluation',
    quantity: 1,
  }));
  // 중복 procedure_id로 인해 DUPLICATE_PROCEDURE_ID가 먼저 나지 않도록 quantity 검증 전
  // 배열 길이 자체를 검증하는지 확인하기 위해, 여기서는 개수 초과가 먼저 걸리는지만 본다.
  assertThrowsCode(
    () => calculateOopCost({ coverage_status: 'uninsured', scenarios: [{ scenario_id: 's1', procedures }] }),
    ERROR_CODES.MAX_PROCEDURES_EXCEEDED
  );
});

test('scenario_id가 101자면 INVALID_SCENARIO_ID_LENGTH로 거부된다', () => {
  const longId = 'a'.repeat(LIMITS.SCENARIO_ID_MAX_LENGTH + 1);
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        scenarios: [{ scenario_id: longId, procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
      }),
    ERROR_CODES.INVALID_SCENARIO_ID_LENGTH
  );
});

test('scenario_id가 빈 문자열이면 INVALID_SCENARIO_ID_LENGTH로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        scenarios: [{ scenario_id: '', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
      }),
    ERROR_CODES.INVALID_SCENARIO_ID_LENGTH
  );
});

test('scenario_id가 100자면 통과한다(경계값)', () => {
  const id100 = 'a'.repeat(LIMITS.SCENARIO_ID_MAX_LENGTH);
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [{ scenario_id: id100, procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(result.estimates[0].scenario_id, id100);
});

// ---------------------------------------------------------------------------
// 이번 보완 사항: 같은 scenario 내 중복 procedure_id
// ---------------------------------------------------------------------------

test('같은 scenario 안에서 procedure_id가 두 번 나오면 DUPLICATE_PROCEDURE_ID로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        scenarios: [
          {
            scenario_id: 's1',
            procedures: [
              { procedure_id: 'initial_evaluation', quantity: 1 },
              { procedure_id: 'initial_evaluation', quantity: 2 },
            ],
          },
        ],
      }),
    ERROR_CODES.DUPLICATE_PROCEDURE_ID
  );
});

test('서로 다른 scenario에서는 같은 procedure_id가 반복돼도 허용된다', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [
      { scenario_id: 'a', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] },
      { scenario_id: 'b', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] },
    ],
  });
  assert.strictEqual(result.estimates.length, 2);
});

// ---------------------------------------------------------------------------
// 이번 보완 사항: deep freeze
// ---------------------------------------------------------------------------

test('반환 결과는 최상위뿐 아니라 중첩 객체/배열까지 deep freeze 되어 있다', () => {
  const result = calculateOopCost({
    coverage_status: 'uninsured',
    scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
  });
  assert.strictEqual(Object.isFrozen(result), true);
  assert.strictEqual(Object.isFrozen(result.estimates), true);
  assert.strictEqual(Object.isFrozen(result.estimates[0]), true);
  assert.strictEqual(Object.isFrozen(result.estimates[0].estimated_oop), true);
  assert.strictEqual(Object.isFrozen(result.estimates[0].assumptions), true);
  assert.strictEqual(Object.isFrozen(result.missing_information), true);

  mutationDoesNotStick(
    () => {
      result.estimates[0].estimated_oop.min = -1;
    },
    () => result.estimates[0].estimated_oop.min,
    80
  );
  mutationDoesNotStick(
    () => {
      result.status = 'tampered';
    },
    () => result.status,
    'estimated'
  );
});

test('demoFeeSchedule은 중첩 값(min/max)까지 deep freeze 되어 변경되지 않는다', () => {
  assert.strictEqual(Object.isFrozen(demoFeeSchedule), true);
  assert.strictEqual(Object.isFrozen(demoFeeSchedule.PROCEDURES), true);
  assert.strictEqual(Object.isFrozen(demoFeeSchedule.PROCEDURES.initial_evaluation), true);

  mutationDoesNotStick(
    () => {
      demoFeeSchedule.PROCEDURES.initial_evaluation.min = 999999;
    },
    () => demoFeeSchedule.PROCEDURES.initial_evaluation.min,
    80
  );
});

// ---------------------------------------------------------------------------
// 이번 보완 사항: COST_OVERFLOW 가드 (fee schedule/한도로는 실제 도달 불가하므로
// 가드 함수 자체를 직접 호출해 검증한다)
// ---------------------------------------------------------------------------

test('assertSafeIntegerCost는 안전한 정수 범위를 벗어나면 COST_OVERFLOW를 던진다', () => {
  assertThrowsCode(() => assertSafeIntegerCost(Number.MAX_SAFE_INTEGER + 1, { scenario_id: 's1' }), ERROR_CODES.COST_OVERFLOW);
  assert.doesNotThrow(() => assertSafeIntegerCost(Number.MAX_SAFE_INTEGER, { scenario_id: 's1' }));
});

// ---------------------------------------------------------------------------
// 그 외 방어적 검증 (unknown field, 잘못된 coverage_status 등)
// ---------------------------------------------------------------------------

test('is_usc_student 등 정의되지 않은 최상위 필드는 UNKNOWN_FIELD로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        is_usc_student: true,
        scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
      }),
    ERROR_CODES.UNKNOWN_FIELD
  );
});

test('user_id/session_id/history_id 등은 UNKNOWN_FIELD로 거부된다', () => {
  for (const field of ['user_id', 'session_id', 'history_id']) {
    assertThrowsCode(
      () =>
        calculateOopCost({
          coverage_status: 'uninsured',
          [field]: 'x',
          scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
        }),
      ERROR_CODES.UNKNOWN_FIELD
    );
  }
});

test('procedure에 사용자 제공 price 필드가 있으면 UNKNOWN_FIELD로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'uninsured',
        scenarios: [
          { scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1, price: 1 }] },
        ],
      }),
    ERROR_CODES.UNKNOWN_FIELD
  );
});

test('잘못된 coverage_status는 INVALID_COVERAGE_STATUS로 거부된다', () => {
  assertThrowsCode(
    () =>
      calculateOopCost({
        coverage_status: 'discounted',
        scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
      }),
    ERROR_CODES.INVALID_COVERAGE_STATUS
  );
});

test('validateCalculateOopCostInput만 단독으로도 동일하게 검증한다', () => {
  assert.doesNotThrow(() =>
    validateCalculateOopCostInput({
      coverage_status: 'uninsured',
      scenarios: [{ scenario_id: 's1', procedures: [{ procedure_id: 'initial_evaluation', quantity: 1 }] }],
    })
  );
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
