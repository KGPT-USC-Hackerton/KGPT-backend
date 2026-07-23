/**
 * agent/services/productRecommendationService.test.js
 * 실행: node agent/services/productRecommendationService.test.js
 */

const assert = require('node:assert');
const { recommendProducts } = require('./productRecommendationService');
const { PRODUCTS } = require('../catalog/hygieneProductCatalog');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('productRecommendationService 테스트\n');

function baseSnapshot(overrides = {}) {
  return {
    schema_version: 'agent-context-v2',
    images: [
      { position: 'upper', cavity_detected: false, occlusion_status: 'normal' },
      { position: 'lower', cavity_detected: false, occlusion_status: 'normal' },
      { position: 'front', cavity_detected: false, occlusion_status: 'normal' },
    ],
    survey: { codebook_version: 'oral-health-questionnaire-v1', codebook_checksum: 'x', answers: [] },
    ...overrides,
  };
}

function withAnswers(answers) {
  return baseSnapshot({ survey: { codebook_version: 'oral-health-questionnaire-v1', codebook_checksum: 'x', answers } });
}

function findItem(items, productKey) {
  return items.find((i) => i.product_key === productKey);
}

// -------------------- 결정론 --------------------

test('동일 입력이면 동일 추천 결과(items/proposal_hash)를 반환한다', () => {
  const snapshot = withAnswers([{ question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'YES' }]);
  const r1 = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const r2 = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.deepStrictEqual(r1, r2);
});

test('items는 product_key 오름차순으로 결정론적으로 정렬된다', () => {
  const snapshot = withAnswers([
    { question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const keys = result.items.map((i) => i.product_key);
  assert.deepStrictEqual(keys, [...keys].sort());
});

test('proposal_hash는 64자 hex이고 session_id/context_hash가 다르면 값이 달라진다', () => {
  const snapshot = baseSnapshot();
  const r1 = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const r2 = recommendProducts({ sessionId: 's2', contextHash: 'h1', contextSnapshot: snapshot });
  const r3 = recommendProducts({ sessionId: 's1', contextHash: 'h2', contextSnapshot: snapshot });
  assert.match(r1.proposal_hash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(r1.proposal_hash, r2.proposal_hash);
  assert.notStrictEqual(r1.proposal_hash, r3.proposal_hash);
});

// -------------------- 칫솔(Q6) --------------------

test('Q6=YES 이면 TOOTHBRUSH_ULTRA_SOFT를 GENTLE_BRUSHING_SUPPORT로 추천하고 치과 진료 권고 문구가 포함된다', () => {
  const snapshot = withAnswers([{ question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'YES' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHBRUSH_ULTRA_SOFT');
  assert.ok(item);
  assert.strictEqual(item.reason_code, 'GENTLE_BRUSHING_SUPPORT');
  assert.match(item.rationale, /치과/);
  assert.strictEqual(findItem(result.items, 'TOOTHBRUSH_SOFT'), undefined); // 동시에 두 개 다 추천 안 함
});

test('Q6=NO 또는 응답 없음이면 TOOTHBRUSH_SOFT(baseline)만 추천된다', () => {
  const withNo = recommendProducts({
    sessionId: 's1',
    contextHash: 'h1',
    contextSnapshot: withAnswers([{ question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'NO' }]),
  });
  const withNothing = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: baseSnapshot() });
  for (const result of [withNo, withNothing]) {
    assert.ok(findItem(result.items, 'TOOTHBRUSH_SOFT'));
    assert.strictEqual(findItem(result.items, 'TOOTHBRUSH_ULTRA_SOFT'), undefined);
  }
});

test('잇몸 민감성(ULTRA_SOFT)은 이미지 소견만으로는 절대 추론되지 않는다(survey 응답 필요)', () => {
  const snapshot = baseSnapshot({ images: [{ position: 'upper', cavity_detected: true }] });
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'TOOTHBRUSH_ULTRA_SOFT'), undefined);
});

// -------------------- 치약(Q12 + cavity) --------------------

test('Q12=NO 이면 TOOTHPASTE_FLUORIDE를 FLUORIDE_HYGIENE_SUPPORT로 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'TOOTHPASTE_FLUORIDE').reason_code, 'FLUORIDE_HYGIENE_SUPPORT');
});

test('Q12=UNKNOWN 이어도 TOOTHPASTE_FLUORIDE를 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'UNKNOWN' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.ok(findItem(result.items, 'TOOTHPASTE_FLUORIDE'));
});

test('Q12=YES 이고 cavity 근거도 없으면 TOOTHPASTE_FLUORIDE를 추천하지 않는다(중복 추천 억제)', () => {
  const snapshot = withAnswers([{ question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'YES' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'TOOTHPASTE_FLUORIDE'), undefined);
});

test('cavity_detected=true 이면 Q12=YES 여도 CAVITY_PREVENTION_SUPPORT로 추천한다(cavity가 우선)', () => {
  const snapshot = baseSnapshot({
    images: [
      { position: 'upper', cavity_detected: true },
      { position: 'lower', cavity_detected: false },
      { position: 'front', cavity_detected: false },
    ],
    survey: { codebook_version: 'v', codebook_checksum: 'x', answers: [{ question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'YES' }] },
  });
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHPASTE_FLUORIDE');
  assert.strictEqual(item.reason_code, 'CAVITY_PREVENTION_SUPPORT');
  assert.deepStrictEqual(item.evidence, [{ source: 'image_analysis', position: 'upper' }]);
  // "정확한 진단/치료는 치과에서"처럼 전문 진료로 안내하는 문구는 안전한 관용구이므로
  // 허용하고, "이 상품이 치료/완치한다"는 식의 제품 효능 주장만 금지 표현으로 본다.
  assert.doesNotMatch(item.rationale, /치료합니다|치료해|완치|치료 효과/);
});

// -------------------- 치실(Q11) --------------------

test('Q11=NEVER 이면 FLOSS_TAPE를 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.ok(findItem(result.items, 'FLOSS_TAPE'));
});

test('Q11=DOES_NOT_KNOW_TOOL 이면 FLOSS_TAPE를 추천한다(특정 사이즈 치간칫솔은 추천하지 않음)', () => {
  const snapshot = withAnswers([{ question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'DOES_NOT_KNOW_TOOL' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.ok(findItem(result.items, 'FLOSS_TAPE'));
  assert.strictEqual(findItem(result.items, 'INTERDENTAL_STARTER'), undefined);
});

test('Q11=SOMETIMES/ALWAYS/MOST_DAYS 이면 FLOSS_TAPE를 추천하지 않는다', () => {
  for (const answer of ['SOMETIMES', 'ALWAYS', 'MOST_DAYS']) {
    const snapshot = withAnswers([{ question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: answer }]);
    const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
    assert.strictEqual(findItem(result.items, 'FLOSS_TAPE'), undefined, answer);
  }
});

// -------------------- 자동 추천 금지 상품 --------------------

test('TOOTHPASTE_SENSITIVE는 어떤 입력에도 자동 추천되지 않는다(Q5=YES 포함)', () => {
  const snapshot = withAnswers([{ question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'TOOTHPASTE_SENSITIVE'), undefined);
  assert.strictEqual(PRODUCTS.TOOTHPASTE_SENSITIVE.allowed_reason_codes.length, 0);
});

test('INTERDENTAL_STARTER/TONGUE_CLEANER는 어떤 입력에도 자동 추천되지 않는다', () => {
  const snapshot = withAnswers([
    { question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' },
    { question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'YES' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'INTERDENTAL_STARTER'), undefined);
  assert.strictEqual(findItem(result.items, 'TONGUE_CLEANER'), undefined);
});

// -------------------- 우식 위험(Q13/Q14) → 우식 예방 불소치약 --------------------

test('Q13(간식)=FOUR_OR_MORE 이면 우식 예방으로 TOOTHPASTE_FLUORIDE(CAVITY_PREVENTION_SUPPORT)를 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'SUGARY_STICKY_SNACKS_PER_DAY', answer_code: 'FOUR_OR_MORE' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHPASTE_FLUORIDE');
  assert.ok(item);
  assert.strictEqual(item.reason_code, 'CAVITY_PREVENTION_SUPPORT');
  assert.deepStrictEqual(item.evidence, [
    { source: 'survey_answer', question_code: 'SUGARY_STICKY_SNACKS_PER_DAY', answer_code: 'FOUR_OR_MORE' },
  ]);
});

test('Q14(음료)=FOUR_OR_MORE 이면 우식 예방으로 TOOTHPASTE_FLUORIDE를 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'SUGARY_DRINKS_PER_DAY', answer_code: 'FOUR_OR_MORE' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHPASTE_FLUORIDE');
  assert.ok(item);
  assert.strictEqual(item.reason_code, 'CAVITY_PREVENTION_SUPPORT');
});

test('Q13/Q14가 낮은 빈도(NONE/ONCE)면 우식 위험으로 추천하지 않는다(억지 추천 없음)', () => {
  const snapshot = withAnswers([
    { question_code: 'SUGARY_STICKY_SNACKS_PER_DAY', answer_code: 'NONE' },
    { question_code: 'SUGARY_DRINKS_PER_DAY', answer_code: 'ONCE' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'TOOTHPASTE_FLUORIDE'), undefined);
});

// -------------------- 양치 부족(Q9/Q10) → 우식 예방 불소치약 --------------------

test('Q9(어제 양치 횟수)=ONE 이면 우식 예방으로 TOOTHPASTE_FLUORIDE를 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'BRUSHING_COUNT_YESTERDAY', answer_code: 'ONE' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHPASTE_FLUORIDE');
  assert.ok(item);
  assert.strictEqual(item.reason_code, 'CAVITY_PREVENTION_SUPPORT');
});

test('Q10(취침 전 칫솔질)=NEVER 이면 우식 예방으로 TOOTHPASTE_FLUORIDE를 추천한다', () => {
  const snapshot = withAnswers([{ question_code: 'BEDTIME_BRUSHING_LAST_WEEK', answer_code: 'NEVER' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHPASTE_FLUORIDE');
  assert.ok(item);
  assert.strictEqual(item.reason_code, 'CAVITY_PREVENTION_SUPPORT');
  // 양치 부족은 칫솔(baseline)도 항상 함께 제공된다.
  assert.ok(findItem(result.items, 'TOOTHBRUSH_SOFT'));
});

test('Q9/Q10가 충분(THREE/ALWAYS)하면 양치 부족으로 추천하지 않는다', () => {
  const snapshot = withAnswers([
    { question_code: 'BRUSHING_COUNT_YESTERDAY', answer_code: 'THREE' },
    { question_code: 'BEDTIME_BRUSHING_LAST_WEEK', answer_code: 'ALWAYS' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(findItem(result.items, 'TOOTHPASTE_FLUORIDE'), undefined);
});

// -------------------- Q15(흡연) 안전 처리 --------------------

test('Q15(흡연)=CURRENT 는 상품 추천을 만들지도 바꾸지도 않는다(과도한 추천 없음)', () => {
  const withoutSmoking = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: baseSnapshot() });
  const withSmoking = recommendProducts({
    sessionId: 's1',
    contextHash: 'h1',
    contextSnapshot: withAnswers([{ question_code: 'SMOKING_STATUS', answer_code: 'CURRENT' }]),
  });
  assert.deepStrictEqual(withoutSmoking.items, withSmoking.items);
  // 흡연 응답만으로는 어떤 안전 안내나 상품도 생성되지 않는다.
  assert.strictEqual(withSmoking.safety_notices.length, 0);
});

// -------------------- Q2/Q3 병력은 추천 근거 아님 --------------------

test('Q2(당뇨)/Q3(심혈관) 병력 응답만으로는 어떤 상품도 추가로 만들지 않는다', () => {
  // 병력 문항은 Snapshot Allowlist에서 제외되므로 answers에 들어오더라도(방어적)
  // 추천 규칙이 참조하지 않아 baseline 칫솔 외 상품이 생기지 않는다.
  const snapshot = withAnswers([
    { question_code: 'DIABETES_STATUS', answer_code: 'YES' },
    { question_code: 'CARDIOVASCULAR_DISEASE_STATUS', answer_code: 'YES' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].product_key, 'TOOTHBRUSH_SOFT');
});

// -------------------- Q5(치아 통증) 안전 안내 정책 --------------------

test('Q5=YES 단독 → 상품 0개(칫솔 baseline만), 진료 권유 안전 안내가 존재한다', () => {
  const snapshot = withAnswers([{ question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  // baseline 칫솔 1개만(통증 때문에 생긴 상품은 없음)
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].product_key, 'TOOTHBRUSH_SOFT');
  // 진료 권유 안전 신호 존재
  assert.strictEqual(result.safety_notices.length, 1);
  assert.strictEqual(result.safety_notices[0].code, 'DENTAL_CONSULTATION_RECOMMENDED');
  assert.strictEqual(result.safety_notices[0].message, '치아 통증의 원인 확인을 위해 치과 상담을 권장합니다');
});

test('Q5=YES + Q11=NEVER → 치실 추천은 유지되고, 시린이 치약은 없다', () => {
  const snapshot = withAnswers([
    { question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' },
    { question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.ok(findItem(result.items, 'FLOSS_TAPE'));
  assert.strictEqual(findItem(result.items, 'TOOTHPASTE_SENSITIVE'), undefined);
  assert.strictEqual(result.safety_notices.length, 1);
});

test('Q5=YES + Q12=NO → 불소치약 추천은 유지되고, 그 근거(evidence)는 Q12만이다(Q5 미포함)', () => {
  const snapshot = withAnswers([
    { question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const item = findItem(result.items, 'TOOTHPASTE_FLUORIDE');
  assert.ok(item);
  assert.deepStrictEqual(item.evidence, [
    { source: 'survey_answer', question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
});

test('Q5=YES 는 어떤 상품의 reason/evidence에도 포함되지 않는다(특히 TOOTHPASTE_SENSITIVE)', () => {
  const snapshot = withAnswers([
    { question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
    { question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  for (const item of result.items) {
    const evidenceSerialized = JSON.stringify(item.evidence);
    assert.ok(!evidenceSerialized.includes('TOOTH_PAIN_LAST_3_MONTHS'), item.product_key);
  }
});

test('안전 안내(safety_notices)는 items에 섞이지 않으며, 카트로 넘어갈 items 직렬화에 안전 문구가 없다', () => {
  const snapshot = withAnswers([
    { question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  // Shopify Cart는 items의 product_key/quantity만 사용한다 → items 직렬화에 안전 문구가 없어야 한다.
  const itemsSerialized = JSON.stringify(result.items);
  assert.ok(!itemsSerialized.includes('치과 상담'));
  assert.ok(!itemsSerialized.includes('DENTAL_CONSULTATION_RECOMMENDED'));
});

test('안전 안내와 사용자 메시지에 특정 질환명/진단 문구가 포함되지 않는다', () => {
  const snapshot = withAnswers([{ question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' }]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const serialized = JSON.stringify(result);
  for (const forbidden of ['충치', '치수염', '감염', '진단', '응급']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

// -------------------- 빈 추천 허용 / mutate 없음 / evidence 최소화 --------------------

test('설문·이미지 근거가 전혀 없으면 baseline 칫솔 1개만 반환한다(억지 추천 없음)', () => {
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: baseSnapshot() });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].product_key, 'TOOTHBRUSH_SOFT');
});

test('추천 과정에서 contextSnapshot 입력 객체를 mutate하지 않는다', () => {
  const snapshot = withAnswers([
    { question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' },
    { question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'YES' },
  ]);
  const before = JSON.parse(JSON.stringify(snapshot));
  recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  assert.deepStrictEqual(snapshot, before);
});

test('evidence에는 question_code/answer_code/source/position 외 개인정보가 없다', () => {
  const snapshot = withAnswers([
    { question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'YES' },
    { question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: 'NEVER' },
    { question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' },
  ]);
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: snapshot });
  const serialized = JSON.stringify(result);
  for (const forbidden of ['user_id', 'session_id', 'history_id', 'survey_session_id']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test('disclaimer는 치료/완치를 보장하지 않는다고 명시하고, 단정적인 효능 주장은 없다', () => {
  const result = recommendProducts({ sessionId: 's1', contextHash: 'h1', contextSnapshot: baseSnapshot() });
  assert.match(result.disclaimer, /보장하지 않습니다/);
  assert.doesNotMatch(result.disclaimer, /치료됩니다|완치됩니다|치료해 드립니다/);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
