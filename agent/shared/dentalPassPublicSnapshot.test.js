/**
 * agent/shared/dentalPassPublicSnapshot.test.js
 * 실행: node agent/shared/dentalPassPublicSnapshot.test.js
 */

const assert = require('node:assert');
const {
  DENTAL_PASS_PUBLIC_SCHEMA_VERSION,
  buildDentalPassPublicSnapshot,
} = require('./dentalPassPublicSnapshot');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('dentalPassPublicSnapshot Allowlist 테스트\n');

const sampleContextSnapshot = {
  history_id: 'history-secret-1',
  survey_session_id: 'survey-secret-1',
  generated_at: '2026-07-22T00:00:00.000Z',
  images: [
    {
      position: 'upper',
      occlusion_status: 'malocclusion_suspected',
      cavity_detected: true,
      cavity_locations: ['upper-left-molar'],
      overall_score: 6.5,
      recommendations: '치과 정밀 검진을 권장합니다.',
      ai_confidence: 0.87,
      llm_summary: 'Gemini가 생성한 상세 소견 텍스트',
    },
    {
      position: 'lower',
      occlusion_status: 'normal',
      cavity_detected: false,
      cavity_locations: null,
      overall_score: 8.9,
      recommendations: '정기 검진을 유지하세요.',
      ai_confidence: 0.95,
      llm_summary: null,
    },
  ],
  survey: {
    survey_session_id: 'survey-secret-1',
    responses: [{ category: 'smoking_drinking', score: 40 }],
  },
  initial_message: { text: '...', evidence: [] },
};

test('schema_version 필드가 포함된다', () => {
  const snapshot = buildDentalPassPublicSnapshot(sampleContextSnapshot);
  assert.strictEqual(snapshot.schema_version, DENTAL_PASS_PUBLIC_SCHEMA_VERSION);
  assert.strictEqual(snapshot.schema_version, 'dental-pass-public-v1');
});

test('images는 허용된 5개 필드만 포함한다', () => {
  const snapshot = buildDentalPassPublicSnapshot(sampleContextSnapshot);
  assert.strictEqual(snapshot.images.length, 2);
  for (const image of snapshot.images) {
    assert.deepStrictEqual(Object.keys(image).sort(), [
      'cavity_detected',
      'occlusion_status',
      'overall_score',
      'position',
      'recommendations',
    ]);
  }
  assert.strictEqual(snapshot.images[0].position, 'upper');
  assert.strictEqual(snapshot.images[0].cavity_detected, true);
});

test('ai_confidence/cavity_locations/llm_summary는 제외된다', () => {
  const snapshot = buildDentalPassPublicSnapshot(sampleContextSnapshot);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('ai_confidence'));
  assert.ok(!serialized.includes('cavity_locations'));
  assert.ok(!serialized.includes('llm_summary'));
  assert.ok(!serialized.includes('Gemini가 생성한'));
});

test('history_id/survey_session_id/survey 응답은 결과에 노출되지 않는다', () => {
  const snapshot = buildDentalPassPublicSnapshot(sampleContextSnapshot);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('history-secret-1'));
  assert.ok(!serialized.includes('survey-secret-1'));
  assert.ok(!serialized.includes('smoking_drinking'));
  assert.strictEqual(snapshot.survey, null);
});

test('disclaimer 문자열이 항상 포함된다', () => {
  const snapshot = buildDentalPassPublicSnapshot(sampleContextSnapshot);
  assert.strictEqual(typeof snapshot.disclaimer, 'string');
  assert.ok(snapshot.disclaimer.length > 0);
});

test('top-level 키는 정확히 schema_version/images/survey/disclaimer 4개다', () => {
  const snapshot = buildDentalPassPublicSnapshot(sampleContextSnapshot);
  assert.deepStrictEqual(Object.keys(snapshot).sort(), ['disclaimer', 'images', 'schema_version', 'survey']);
});

test('금지된 필드(user_id/session_id/history_id/survey_session_id/cloudinary_url/llm_summary/ai_confidence/cavity_locations/share_token/share_token_hash/tool_results/trace_id)는 어디에도 없다', () => {
  const snapshot = buildDentalPassPublicSnapshot({
    ...sampleContextSnapshot,
    // context_snapshot 쪽에도 실수로 이런 키가 섞여 들어온다고 가정해도 안전한지 확인.
    user_id: 1,
    session_id: 'session-secret',
    cloudinary_url: 'https://res.cloudinary.com/secret.jpg',
    share_token: 'raw-token-should-not-leak',
    share_token_hash: 'hash-should-not-leak',
    tool_results: [{ tool_name: 'calculate_oop_cost' }],
    trace_id: 'trace-secret',
  });
  const forbiddenFields = [
    'user_id',
    'session_id',
    'history_id',
    'survey_session_id',
    'cloudinary_url',
    'llm_summary',
    'ai_confidence',
    'cavity_locations',
    'share_token',
    'share_token_hash',
    'tool_results',
    'trace_id',
  ];
  const serialized = JSON.stringify(snapshot);
  for (const field of forbiddenFields) {
    assert.ok(!serialized.includes(field), `${field} 가 공개 Snapshot에 섞이면 안 됩니다.`);
  }
});

test('images가 없는 context_snapshot도 안전하게 처리한다', () => {
  const snapshot = buildDentalPassPublicSnapshot({});
  assert.deepStrictEqual(snapshot.images, []);
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
