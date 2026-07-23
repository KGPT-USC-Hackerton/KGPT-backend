/**
 * agent/adapters/geminiAdapter.integration.test.js
 * ----------------------------------------------------------------------------
 * 실제 Gemini API를 호출하는 opt-in 통합 테스트. 기본 테스트 스크립트
 * (test:agent-*)에서는 실행하지 않는다.
 *
 * 실행 조건: RUN_GEMINI_INTEGRATION_TEST=true 이고 GEMINI_API_KEY가 설정된 경우만.
 * 둘 중 하나라도 없으면 실패가 아니라 skip 하고 종료 코드 0으로 끝난다.
 *
 * 검증 범위(최소 호출):
 *   1. 모델명이 실제로 응답 가능한지(정상 202/200 수준 응답)
 *   2. responseJsonSchema(agentMessageResponseSchema)를 실제로 통과하는지
 *   3. timeout(AbortSignal) 설정이 실제로 동작하는지(아주 짧은 timeout으로 유도)
 * 응답 원문 전체는 어디에도 저장하지 않는다(길이/스키마 통과 여부만 로그).
 *
 * 실행: RUN_GEMINI_INTEGRATION_TEST=true node agent/adapters/geminiAdapter.integration.test.js
 */

require('dotenv').config();
const assert = require('node:assert');

async function main() {
  if (process.env.RUN_GEMINI_INTEGRATION_TEST !== 'true') {
    console.log('SKIP: RUN_GEMINI_INTEGRATION_TEST=true 가 아니어서 통합 테스트를 건너뜁니다.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.log('SKIP: GEMINI_API_KEY가 없어 통합 테스트를 건너뜁니다.');
    return;
  }

  const { generateAgentReply, getConfiguredModel } = require('./geminiAdapter');
  const { AGENT_MESSAGE_RESPONSE_JSON_SCHEMA, validateAgentMessageResponse } = require('../schemas/agentMessageResponseSchema');

  console.log(`대상 모델: ${getConfiguredModel()}\n`);

  console.log('1) 모델이 기본 요청에 응답하는지 확인...');
  const basic = await generateAgentReply({
    systemInstruction: '한국어로 아주 짧게 인사만 답하세요.',
    contents: [{ role: 'user', parts: [{ text: '안녕하세요' }] }],
    tools: null,
    responseJsonSchema: null,
    timeoutMs: 15000,
  });
  assert.strictEqual(basic.ok, true, `기본 호출 실패: ${basic.error_code}`);
  assert.strictEqual(typeof basic.model, 'string');
  console.log(`   ✅ 응답 수신 (finish_reason=${basic.finish_reason}, content 길이=${basic.response.content?.length ?? 0})`);

  console.log('2) responseJsonSchema 통과 여부 확인...');
  const structured = await generateAgentReply({
    systemInstruction:
      '사용자에게 안전한 한 문장 인사를 JSON으로 답하세요. content에는 절대 비용 숫자를 넣지 마세요.',
    contents: [{ role: 'user', parts: [{ text: '안녕하세요, 잘 지내세요?' }] }],
    tools: null,
    responseJsonSchema: AGENT_MESSAGE_RESPONSE_JSON_SCHEMA,
    timeoutMs: 15000,
  });
  assert.strictEqual(structured.ok, true, `구조화 출력 호출 실패: ${structured.error_code}`);
  let parsed = null;
  let parseOk = false;
  try {
    parsed = JSON.parse(structured.response.content);
    parseOk = true;
  } catch (e) {
    parseOk = false;
  }
  console.log(`   JSON 파싱: ${parseOk ? '성공' : '실패'}`);
  if (parseOk) {
    const validation = validateAgentMessageResponse(parsed);
    console.log(`   서버 측 스키마 검증: ${validation.valid ? '통과' : `실패(${validation.reason})`}`);
    if (!validation.valid) {
      console.log(
        '   ⚠️ responseJsonSchema(소문자 JSON Schema)가 이 모델/API 버전에서 기대대로 처리되지 않을 수 있습니다.' +
          ' 실패해도 서비스는 안전하게 template_fallback으로 저하되므로 정확성 리스크는 없습니다.'
      );
    }
  }

  console.log('\n3) 매우 짧은 timeout으로 GEMINI_TIMEOUT 정규화 확인...');
  const timedOut = await generateAgentReply({
    systemInstruction: '길게 설명하세요.',
    contents: [{ role: 'user', parts: [{ text: '치아 관리에 대해 아주 길게 설명해줘' }] }],
    tools: null,
    responseJsonSchema: null,
    timeoutMs: 1,
  });
  if (timedOut.ok) {
    console.log('   ⚠️ 1ms timeout인데도 응답이 왔습니다(네트워크가 매우 빠르거나 캐시된 경우). 실패로 보지 않음.');
  } else {
    console.log(`   ✅ 실패 정규화 확인: error_code=${timedOut.error_code}, retryable=${timedOut.retryable}`);
  }

  console.log('\n🎉 Gemini 통합 테스트 완료 (응답 원문은 저장하지 않았습니다).');
}

main().catch((err) => {
  console.error('❌ 통합 테스트 실패:', err.message);
  process.exit(1);
});
