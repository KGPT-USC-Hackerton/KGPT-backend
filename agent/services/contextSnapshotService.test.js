/**
 * agent/services/contextSnapshotService.test.js
 * ----------------------------------------------------------------------------
 * contextSnapshotService의 순수 함수(DB 의존 없음)에 대한 오프라인 테스트.
 * 백엔드에 test runner(jest)가 없으므로 표준 node:assert로 작성.
 *
 * 실행: node agent/services/contextSnapshotService.test.js
 */

const assert = require('node:assert');
const {
  decideReadiness,
  pickLatestPerPosition,
  buildInitialMessage,
  buildSurveyAnswersOrError,
  buildContextSnapshot,
  computeContextHash,
} = require('./contextSnapshotService');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('contextSnapshotService 테스트\n');

// ---------------------------------------------------------------------------
// decideReadiness
// ---------------------------------------------------------------------------

const AUTH_USER_ID = 1;

function completedImageRow(position) {
  return { position, analysis_status: 'completed', user_id: AUTH_USER_ID };
}

function completedImageAnalysisRow(position, overrides = {}) {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 100000),
    image_type: position,
    analyzed_at: overrides.analyzed_at ?? '2026-07-20T00:00:00.000Z',
    occlusion_status: 'normal',
    occlusion_comment: null,
    cavity_detected: false,
    cavity_locations: null,
    overall_score: 8.5,
    recommendations: '정기검진 권장',
    ai_confidence: 0.72,
    llm_summary: null,
    ...overrides,
  };
}

test('history_id에 해당하는 이미지가 없으면 history_not_found', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [],
    imageAnalysisRows: [],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'history_not_found');
});

test('history_id가 다른 사용자 소유면 history_not_found (존재 여부 숨김)', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [
      { position: 'upper', analysis_status: 'completed', user_id: 999 },
      { position: 'lower', analysis_status: 'completed', user_id: 999 },
      { position: 'front', analysis_status: 'completed', user_id: 999 },
    ],
    imageAnalysisRows: [],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'history_not_found');
});

test('position 3종 중 하나라도 없으면 waiting_for_analysis', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [completedImageRow('upper'), completedImageRow('lower')],
    imageAnalysisRows: [],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'waiting_for_analysis');
});

test('pending/processing이 섞여 있으면 waiting_for_analysis', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [
      completedImageRow('upper'),
      { position: 'lower', analysis_status: 'processing', user_id: AUTH_USER_ID },
      { position: 'front', analysis_status: 'pending', user_id: AUTH_USER_ID },
    ],
    imageAnalysisRows: [],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'waiting_for_analysis');
});

test('failed가 하나라도 섞여 있으면 analysis_failed', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [
      completedImageRow('upper'),
      completedImageRow('lower'),
      { position: 'front', analysis_status: 'failed', user_id: AUTH_USER_ID },
    ],
    imageAnalysisRows: [],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'analysis_failed');
});

test('3종 모두 completed지만 image_analysis에 position별 완료 레코드가 없으면 waiting_for_analysis', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [completedImageRow('upper'), completedImageRow('lower'), completedImageRow('front')],
    imageAnalysisRows: [completedImageAnalysisRow('upper'), completedImageAnalysisRow('lower')],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'waiting_for_analysis');
});

test('survey_session_id가 요청됐는데 소유 레코드가 0건이면 survey_session_not_found', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [completedImageRow('upper'), completedImageRow('lower'), completedImageRow('front')],
    imageAnalysisRows: [
      completedImageAnalysisRow('upper'),
      completedImageAnalysisRow('lower'),
      completedImageAnalysisRow('front'),
    ],
    requestedSurveySessionId: 'survey-abc',
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'survey_session_not_found');
});

test('3종 모두 completed + image_analysis 3건 모두 있으면 ready', () => {
  const result = decideReadiness({
    authUserId: AUTH_USER_ID,
    imageRows: [completedImageRow('upper'), completedImageRow('lower'), completedImageRow('front')],
    imageAnalysisRows: [
      completedImageAnalysisRow('upper'),
      completedImageAnalysisRow('lower'),
      completedImageAnalysisRow('front'),
    ],
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.imagesByPosition.size, 3);
});

// ---------------------------------------------------------------------------
// pickLatestPerPosition
// ---------------------------------------------------------------------------

test('pickLatestPerPosition은 중복 position 중 (analyzed_at, id) 기준 최신 1건만 선택한다', () => {
  const older = completedImageAnalysisRow('upper', { id: 1, analyzed_at: '2026-07-01T00:00:00.000Z', overall_score: 5 });
  const newer = completedImageAnalysisRow('upper', { id: 2, analyzed_at: '2026-07-02T00:00:00.000Z', overall_score: 9 });

  const byPosition = pickLatestPerPosition([older, newer]);
  assert.strictEqual(byPosition.get('upper').overall_score, 9);

  const byPositionReversed = pickLatestPerPosition([newer, older]);
  assert.strictEqual(byPositionReversed.get('upper').overall_score, 9);
});

// ---------------------------------------------------------------------------
// buildInitialMessage
// ---------------------------------------------------------------------------

test('cavity_detected/occlusion 이상이 있으면 확인 필요 문구 + evidence를 포함한다', () => {
  const images = [
    { position: 'upper', cavity_detected: true, occlusion_status: 'normal', ai_confidence: 0.8 },
    { position: 'lower', cavity_detected: false, occlusion_status: 'normal', ai_confidence: 0.7 },
    { position: 'front', cavity_detected: false, occlusion_status: 'crossbite', ai_confidence: 0.6 },
  ];
  const message = buildInitialMessage(images);
  assert.match(message.text, /추가 확인이 필요한 소견/);
  assert.strictEqual(message.evidence.length, 2);
  assert.deepStrictEqual(
    message.evidence.map((e) => e.position),
    ['upper', 'front']
  );
});

test('특이 소견이 없으면 안전 문구를 반환하고 evidence는 비어있다', () => {
  const images = [
    { position: 'upper', cavity_detected: false, occlusion_status: 'normal', ai_confidence: 0.8 },
    { position: 'lower', cavity_detected: false, occlusion_status: 'normal', ai_confidence: 0.7 },
    { position: 'front', cavity_detected: false, occlusion_status: 'normal', ai_confidence: 0.6 },
  ];
  const message = buildInitialMessage(images);
  assert.match(message.text, /특별한 소견은 발견되지 않았어요/);
  assert.strictEqual(message.evidence.length, 0);
});

test('초기 메시지에는 CDT 코드/보험/비용 문구가 절대 섞이지 않는다', () => {
  const images = [
    { position: 'upper', cavity_detected: true, occlusion_status: 'normal', ai_confidence: 0.8 },
    { position: 'lower', cavity_detected: false, occlusion_status: 'normal', ai_confidence: 0.7 },
    { position: 'front', cavity_detected: false, occlusion_status: 'normal', ai_confidence: 0.6 },
  ];
  const message = buildInitialMessage(images);
  assert.doesNotMatch(message.text, /CDT|보험|비용|원\b/);
});

// ---------------------------------------------------------------------------
// computeContextHash
// ---------------------------------------------------------------------------

function baseSnapshotInput(overrides = {}) {
  const imagesByPosition = pickLatestPerPosition([
    completedImageAnalysisRow('upper'),
    completedImageAnalysisRow('lower'),
    completedImageAnalysisRow('front'),
  ]);
  return {
    historyId: 'history-1',
    surveySessionId: null,
    imagesByPosition,
    surveyInfo: buildSurveyAnswersOrError([]),
    generatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

test('generated_at만 다르면 context_hash는 동일하다', () => {
  const snapshotA = buildContextSnapshot(baseSnapshotInput({ generatedAt: '2026-07-20T00:00:00.000Z' }));
  const snapshotB = buildContextSnapshot(baseSnapshotInput({ generatedAt: '2026-07-21T12:34:56.000Z' }));
  assert.strictEqual(computeContextHash(snapshotA), computeContextHash(snapshotB));
});

test('근거 필드가 하나라도 다르면 context_hash도 달라진다', () => {
  const imagesByPositionChanged = pickLatestPerPosition([
    completedImageAnalysisRow('upper', { overall_score: 1 }),
    completedImageAnalysisRow('lower'),
    completedImageAnalysisRow('front'),
  ]);
  const snapshotA = buildContextSnapshot(baseSnapshotInput());
  const snapshotB = buildContextSnapshot(baseSnapshotInput({ imagesByPosition: imagesByPositionChanged }));
  assert.notStrictEqual(computeContextHash(snapshotA), computeContextHash(snapshotB));
});

test('객체 키 삽입 순서가 달라도 context_hash는 동일하다 (canonical 정렬 확인)', () => {
  const snapshotA = buildContextSnapshot(baseSnapshotInput());
  const snapshotBReordered = {
    initial_message: snapshotA.initial_message,
    images: snapshotA.images,
    survey: snapshotA.survey,
    survey_session_id: snapshotA.survey_session_id,
    history_id: snapshotA.history_id,
    schema_version: snapshotA.schema_version,
    needs_clinical_followup: snapshotA.needs_clinical_followup,
    followup_reason_codes: snapshotA.followup_reason_codes,
    generated_at: '2099-01-01T00:00:00.000Z',
  };
  assert.strictEqual(computeContextHash(snapshotA), computeContextHash(snapshotBReordered));
});

// ---------------------------------------------------------------------------
// Context Snapshot v2 (buildSurveyAnswersOrError / buildContextSnapshot)
// ---------------------------------------------------------------------------

test('설문 응답이 없으면(빈 배열) survey:null, needs_clinical_followup:false다', () => {
  const info = buildSurveyAnswersOrError([]);
  assert.deepStrictEqual(info, { ok: true, survey: null, needsClinicalFollowup: false, followupReasonCodes: [] });
});

test('신규 Session의 Context Snapshot은 schema_version: agent-context-v2 를 갖는다', () => {
  const snapshot = buildContextSnapshot(baseSnapshotInput());
  assert.strictEqual(snapshot.schema_version, 'agent-context-v2');
});

test('Allowlist 밖 문항(병력 DIABETES_STATUS/치과방문 등)은 survey.answers에 포함되지 않는다', () => {
  const info = buildSurveyAnswersOrError([
    { question_number: 1, option_number: 1 }, // DENTAL_VISIT_LAST_YEAR (Allowlist 제외)
    { question_number: 2, option_number: 1 }, // DIABETES_STATUS (병력 → Allowlist 제외)
    { question_number: 12, option_number: 2 }, // FLUORIDE_TOOTHPASTE_STATUS(Allowlist)
  ]);
  assert.strictEqual(info.ok, true);
  assert.deepStrictEqual(info.survey.answers, [{ question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: 'NO' }]);
});

test('응답 순서가 달라도 동일한 응답 집합이면 context_hash가 같다', () => {
  const rowsA = [
    { question_number: 6, option_number: 1 },
    { question_number: 11, option_number: 4 },
  ];
  const rowsB = [
    { question_number: 11, option_number: 4 },
    { question_number: 6, option_number: 1 },
  ];
  const snapshotA = buildContextSnapshot(baseSnapshotInput({ surveyInfo: buildSurveyAnswersOrError(rowsA) }));
  const snapshotB = buildContextSnapshot(baseSnapshotInput({ surveyInfo: buildSurveyAnswersOrError(rowsB) }));
  assert.strictEqual(computeContextHash(snapshotA), computeContextHash(snapshotB));
});

test('동일 question_number 중복 응답은 buildSurveyAnswersOrError가 실패로 감지한다(부분 Snapshot 생성 안 함)', () => {
  const info = buildSurveyAnswersOrError([
    { question_number: 1, option_number: 1 },
    { question_number: 1, option_number: 2 },
  ]);
  assert.deepStrictEqual(info, { ok: false, code: 'AGENT_SURVEY_RESPONSE_DUPLICATE' });
});

test('코드북 밖 question_number는 AGENT_SURVEY_MAPPING_UNSUPPORTED로 실패한다', () => {
  const info = buildSurveyAnswersOrError([{ question_number: 999, option_number: 1 }]);
  assert.deepStrictEqual(info, { ok: false, code: 'AGENT_SURVEY_MAPPING_UNSUPPORTED' });
});

test('DB category/score가 코드북과 다르면 AGENT_SURVEY_CODEBOOK_MISMATCH로 실패한다', () => {
  // Q1 opt1의 팀 정본은 category '구강관리/양치습관', score 5 — score를 조작한 행은 tamper로 감지된다.
  const info = buildSurveyAnswersOrError([{ question_number: 1, option_number: 1, category: '구강관리/양치습관', score: 3 }]);
  assert.deepStrictEqual(info, { ok: false, code: 'AGENT_SURVEY_CODEBOOK_MISMATCH' });
});

test('기존(v1) Snapshot 형태를 그대로 넣어도 computeContextHash는 정상 동작한다(하위 호환)', () => {
  // schema_version/needs_clinical_followup 필드가 아예 없는 과거 형태의 객체.
  const legacyV1Snapshot = {
    history_id: 'history-1',
    survey_session_id: null,
    generated_at: '2026-01-01T00:00:00.000Z',
    images: [],
    survey: null,
    initial_message: { text: 'x', evidence: [] },
  };
  const hash1 = computeContextHash(legacyV1Snapshot);
  const hash2 = computeContextHash({ ...legacyV1Snapshot, generated_at: '2099-01-01T00:00:00.000Z' });
  assert.strictEqual(hash1, hash2); // generated_at 제외 정책은 v1/v2 공통으로 그대로 유지됨
  assert.strictEqual(typeof hash1, 'string');
  assert.strictEqual(hash1.length, 64);
});

// -------------------- needs_clinical_followup 파생 규칙 --------------------

test('CHEWING_DISCOMFORT/TOOTH_PAIN/GUM_PAIN=YES, SELF_RATED=POOR면 4개 followup_reason_codes가 모두 나온다', () => {
  const info = buildSurveyAnswersOrError([
    { question_number: 4, option_number: 1 }, // CHEWING_DISCOMFORT YES
    { question_number: 5, option_number: 1 }, // TOOTH_PAIN YES
    { question_number: 6, option_number: 1 }, // GUM_PAIN YES
    { question_number: 7, option_number: 4 }, // SELF_RATED POOR
  ]);
  assert.strictEqual(info.ok, true);
  assert.strictEqual(info.needsClinicalFollowup, true);
  assert.deepStrictEqual(info.followupReasonCodes, [
    'RECENT_CHEWING_DISCOMFORT',
    'RECENT_TOOTH_PAIN',
    'RECENT_GUM_PAIN_OR_BLEEDING',
    'SELF_RATED_ORAL_HEALTH_POOR',
  ]);
});

test('모두 NO/양호면 needs_clinical_followup은 false다', () => {
  const info = buildSurveyAnswersOrError([
    { question_number: 4, option_number: 2 }, // NO
    { question_number: 5, option_number: 2 }, // NO
    { question_number: 6, option_number: 2 }, // NO
    { question_number: 7, option_number: 1 }, // VERY_GOOD
  ]);
  assert.strictEqual(info.needsClinicalFollowup, false);
  assert.deepStrictEqual(info.followupReasonCodes, []);
});

test('Q5=YES만 있어도 TOOTHPASTE_SENSITIVE 관련 필드는 어디에도 생기지 않는다(followup만 생성)', () => {
  const info = buildSurveyAnswersOrError([{ question_number: 5, option_number: 1 }]);
  assert.deepStrictEqual(info.followupReasonCodes, ['RECENT_TOOTH_PAIN']);
  assert.ok(!JSON.stringify(info).includes('SENSITIVE'));
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
