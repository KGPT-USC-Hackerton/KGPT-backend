/**
 * agent/catalog/surveyCodebook.test.js
 * 실행: node agent/catalog/surveyCodebook.test.js
 *
 * 팀 KGPT-backend 정본 문진표(database/seed_survey_questionnaire.sql) 기준.
 */

const assert = require('node:assert');
const {
  CODEBOOK_VERSION,
  CATEGORY,
  QUESTIONS,
  SNAPSHOT_ALLOWLIST_QUESTION_CODES,
  CODEBOOK_CHECKSUM,
  validateAndMapResponses,
  filterAllowlistedAnswers,
  computeCodebookChecksum,
} = require('./surveyCodebook');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('surveyCodebook 테스트\n');

test('codebook_version은 oral-health-questionnaire-v1이다', () => {
  assert.strictEqual(CODEBOOK_VERSION, 'oral-health-questionnaire-v1');
});

test('question_number 1~15가 정확히 유일하게 존재한다', () => {
  assert.strictEqual(QUESTIONS.length, 15);
  const numbers = QUESTIONS.map((q) => q.question_number).sort((a, b) => a - b);
  assert.deepStrictEqual(numbers, Array.from({ length: 15 }, (_, i) => i + 1));
});

test('question_code가 모두 유일하다', () => {
  const codes = QUESTIONS.map((q) => q.question_code);
  assert.strictEqual(new Set(codes).size, codes.length);
});

test('모든 문항 max_score=5이고, 각 옵션은 팀 정본 category(6개 ENUM 내)와 0~5 score를 가진다', () => {
  const allowedCategories = new Set(Object.values(CATEGORY));
  for (const q of QUESTIONS) {
    assert.strictEqual(q.max_score, 5, q.question_code);
    for (const opt of q.options) {
      assert.ok(allowedCategories.has(opt.category), `${q.question_code}:${opt.category}`);
      assert.strictEqual(typeof opt.score, 'number', q.question_code);
      assert.ok(opt.score >= 0 && opt.score <= 5, `${q.question_code}:${opt.score}`);
    }
  }
});

test('병력 문항(Q2 당뇨, Q3 심혈관)은 score 0이고 category는 구치/구강건조다', () => {
  for (const qn of [2, 3]) {
    const q = QUESTIONS.find((x) => x.question_number === qn);
    for (const opt of q.options) {
      assert.strictEqual(opt.score, 0, q.question_code);
      assert.strictEqual(opt.category, CATEGORY.MOLAR_DRYNESS, q.question_code);
    }
  }
});

test('각 문항 옵션의 option_number는 1부터 연속이고 answer_code가 유일하다', () => {
  for (const q of QUESTIONS) {
    const numbers = q.options.map((o) => o.option_number);
    assert.deepStrictEqual(numbers, Array.from({ length: q.options.length }, (_, i) => i + 1), q.question_code);
    const codes = q.options.map((o) => o.answer_code);
    assert.strictEqual(new Set(codes).size, codes.length, q.question_code);
  }
});

test('개인정보/자유기재 관련 필드는 어디에도 없다(성명/주민번호/전화번호/이메일/주소/바코드)', () => {
  const serialized = JSON.stringify(QUESTIONS);
  for (const forbidden of ['성명', '주민번호', '전화번호', '이메일', '주소', '바코드', 'free_text', 'freeText']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test('16번 이상 문항(자유기재 등)은 정의되지 않는다', () => {
  assert.strictEqual(QUESTIONS.some((q) => q.question_number > 15), false);
});

// -------------------- validateAndMapResponses --------------------

test('정상 응답은 question_code 오름차순으로 매핑된다', () => {
  const result = validateAndMapResponses([
    { question_number: 12, option_number: 2 },
    { question_number: 1, option_number: 1 },
  ]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.answers, [
    { question_code: 'DENTAL_VISIT_LAST_YEAR', answer_code: 'YES' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
});

test('동일 question_number 중복은 AGENT_SURVEY_RESPONSE_DUPLICATE', () => {
  const result = validateAndMapResponses([
    { question_number: 1, option_number: 1 },
    { question_number: 1, option_number: 2 },
  ]);
  assert.deepStrictEqual(result, { ok: false, code: 'AGENT_SURVEY_RESPONSE_DUPLICATE' });
});

test('코드북 밖의 question_number는 AGENT_SURVEY_MAPPING_UNSUPPORTED(조용히 무시하지 않는다)', () => {
  const result = validateAndMapResponses([{ question_number: 999, option_number: 1 }]);
  assert.deepStrictEqual(result, { ok: false, code: 'AGENT_SURVEY_MAPPING_UNSUPPORTED' });
});

test('존재하는 question_number이지만 잘못된 option_number는 AGENT_SURVEY_MAPPING_UNSUPPORTED', () => {
  const result = validateAndMapResponses([{ question_number: 1, option_number: 99 }]);
  assert.deepStrictEqual(result, { ok: false, code: 'AGENT_SURVEY_MAPPING_UNSUPPORTED' });
});

test('DB category가 팀 정본과 다르면 AGENT_SURVEY_CODEBOOK_MISMATCH', () => {
  // Q1 opt1의 정본 category는 구강관리/양치습관 — 다른 값이면 tamper로 본다.
  const result = validateAndMapResponses([{ question_number: 1, option_number: 1, category: '흡연/음주', score: 5 }]);
  assert.deepStrictEqual(result, { ok: false, code: 'AGENT_SURVEY_CODEBOOK_MISMATCH' });
});

test('DB score가 팀 정본과 다르면 AGENT_SURVEY_CODEBOOK_MISMATCH', () => {
  // Q1 opt1의 정본 score는 5 — 다른 값이면 tamper로 본다.
  const result = validateAndMapResponses([{ question_number: 1, option_number: 1, category: '구강관리/양치습관', score: 3 }]);
  assert.deepStrictEqual(result, { ok: false, code: 'AGENT_SURVEY_CODEBOOK_MISMATCH' });
});

test('category/score가 팀 정본과 일치하면 정상 매핑된다(scored survey 하위호환)', () => {
  const result = validateAndMapResponses([{ question_number: 1, option_number: 1, category: '구강관리/양치습관', score: 5 }]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.answers, [{ question_code: 'DENTAL_VISIT_LAST_YEAR', answer_code: 'YES' }]);
});

test('병력 문항의 score 0/구치·구강건조도 정본과 일치하면 정상 매핑된다', () => {
  const result = validateAndMapResponses([{ question_number: 2, option_number: 1, category: '구치/구강건조', score: 0 }]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.answers, [{ question_code: 'DIABETES_STATUS', answer_code: 'YES' }]);
});

test('question_text가 바뀌어도 매핑 결과(question_code/answer_code)는 변하지 않는다', () => {
  const result = validateAndMapResponses([{ question_number: 1, option_number: 1 }]);
  assert.strictEqual(result.answers[0].question_code, 'DENTAL_VISIT_LAST_YEAR');
});

// -------------------- Allowlist --------------------

test('Snapshot Allowlist는 상품추천/안전안내에 쓰는 11개 question_code이고 병력 문항을 제외한다', () => {
  assert.strictEqual(SNAPSHOT_ALLOWLIST_QUESTION_CODES.length, 11);
  assert.deepStrictEqual(
    [...SNAPSHOT_ALLOWLIST_QUESTION_CODES].sort(),
    [
      'BEDTIME_BRUSHING_LAST_WEEK',
      'BRUSHING_COUNT_YESTERDAY',
      'CHEWING_DISCOMFORT_LAST_3_MONTHS',
      'FLUORIDE_TOOTHPASTE_STATUS',
      'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS',
      'INTERDENTAL_CLEANING_LAST_WEEK',
      'SELF_RATED_ORAL_HEALTH',
      'SMOKING_STATUS',
      'SUGARY_DRINKS_PER_DAY',
      'SUGARY_STICKY_SNACKS_PER_DAY',
      'TOOTH_PAIN_LAST_3_MONTHS',
    ]
  );
  // 병력 문항은 상품 추천 근거로 쓰지 않기 위해 Allowlist에서 제외된다.
  assert.ok(!SNAPSHOT_ALLOWLIST_QUESTION_CODES.includes('DIABETES_STATUS'));
  assert.ok(!SNAPSHOT_ALLOWLIST_QUESTION_CODES.includes('CARDIOVASCULAR_DISEASE_STATUS'));
});

test('filterAllowlistedAnswers는 Allowlist 밖 항목(병력/치과방문 등)을 제거한다', () => {
  const answers = [
    { question_code: 'DIABETES_STATUS', answer_code: 'YES' },
    { question_code: 'DENTAL_VISIT_LAST_YEAR', answer_code: 'YES' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ];
  const filtered = filterAllowlistedAnswers(answers);
  assert.deepStrictEqual(filtered, [{ question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' }]);
});

test('TOOTHPASTE_SENSITIVE 관련 후속 문항(TEMPERATURE_TRIGGERED_TOOTH_SENSITIVITY)은 존재하지 않는다', () => {
  const codes = QUESTIONS.map((q) => q.question_code);
  assert.ok(!codes.includes('TEMPERATURE_TRIGGERED_TOOTH_SENSITIVITY'));
});

// -------------------- Checksum --------------------

test('CODEBOOK_CHECKSUM은 64자 hex이고 결정론적이다', () => {
  assert.strictEqual(CODEBOOK_CHECKSUM.length, 64);
  assert.match(CODEBOOK_CHECKSUM, /^[0-9a-f]{64}$/);
  assert.strictEqual(computeCodebookChecksum(QUESTIONS), CODEBOOK_CHECKSUM);
});

test('option의 score 한 개만 달라져도 checksum이 달라진다(팀 배점을 checksum이 커버한다)', () => {
  const mutated = JSON.parse(JSON.stringify(QUESTIONS));
  mutated[0].options[0].score = mutated[0].options[0].score + 1;
  assert.notStrictEqual(computeCodebookChecksum(mutated), CODEBOOK_CHECKSUM);
});

test('question_text 한 글자만 달라져도 checksum이 달라진다', () => {
  const mutated = JSON.parse(JSON.stringify(QUESTIONS));
  mutated[0].question_text += ' ';
  assert.notStrictEqual(computeCodebookChecksum(mutated), CODEBOOK_CHECKSUM);
});

test('배열 순서가 달라도(question_number/option_number 기준 정렬 후) checksum은 동일하다', () => {
  const shuffled = [...QUESTIONS].reverse().map((q) => ({ ...q, options: [...q.options].reverse() }));
  assert.strictEqual(computeCodebookChecksum(shuffled), CODEBOOK_CHECKSUM);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
