/**
 * agent/adapters/geminiAdapter.test.js
 * ----------------------------------------------------------------------------
 * 실제 Gemini API를 호출하지 않는 오프라인 테스트. 설정 clamping, 에러 정규화,
 * API 키 미설정 시 GEMINI_NOT_CONFIGURED 즉시 반환(네트워크 호출 없음)만 검증한다.
 * 실제 SDK 호출 검증은 agent/adapters/geminiAdapter.integration.test.js(opt-in).
 *
 * 실행: node agent/adapters/geminiAdapter.test.js
 */

const assert = require('node:assert');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('geminiAdapter 테스트\n');

test('GEMINI_MODEL 미설정/빈값이면 기본 모델로 fallback', () => {
  delete require.cache[require.resolve('./geminiAdapter')];
  const original = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  const adapter = require('./geminiAdapter');
  assert.strictEqual(adapter.getConfiguredModel(), adapter.DEFAULT_MODEL);
  process.env.GEMINI_MODEL = '   ';
  assert.strictEqual(adapter.getConfiguredModel(), adapter.DEFAULT_MODEL);
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  assert.strictEqual(adapter.getConfiguredModel(), 'gemini-2.5-flash');
  if (original !== undefined) process.env.GEMINI_MODEL = original;
  else delete process.env.GEMINI_MODEL;
});

test('GEMINI_TIMEOUT_MS는 [1000, 30000]으로 clamp 되고, 비정상 값은 기본값 15000', () => {
  const adapter = require('./geminiAdapter');
  const original = process.env.GEMINI_TIMEOUT_MS;

  process.env.GEMINI_TIMEOUT_MS = '500';
  assert.strictEqual(adapter.getConfiguredTimeoutMs(), 1000);

  process.env.GEMINI_TIMEOUT_MS = '999999';
  assert.strictEqual(adapter.getConfiguredTimeoutMs(), 30000);

  process.env.GEMINI_TIMEOUT_MS = 'not-a-number';
  assert.strictEqual(adapter.getConfiguredTimeoutMs(), 15000);

  process.env.GEMINI_TIMEOUT_MS = '-1000';
  assert.strictEqual(adapter.getConfiguredTimeoutMs(), 15000);

  process.env.GEMINI_TIMEOUT_MS = '5000';
  assert.strictEqual(adapter.getConfiguredTimeoutMs(), 5000);

  if (original !== undefined) process.env.GEMINI_TIMEOUT_MS = original;
  else delete process.env.GEMINI_TIMEOUT_MS;
});

test('GEMINI_MAX_TOOL_CALLS는 어떤 설정이 와도 최대 3, 0 이하/비정상은 기본값', () => {
  const adapter = require('./geminiAdapter');
  const original = process.env.GEMINI_MAX_TOOL_CALLS;

  process.env.GEMINI_MAX_TOOL_CALLS = '10';
  assert.strictEqual(adapter.getConfiguredMaxToolCalls(), 3);

  process.env.GEMINI_MAX_TOOL_CALLS = '0';
  assert.strictEqual(adapter.getConfiguredMaxToolCalls(), 3);

  process.env.GEMINI_MAX_TOOL_CALLS = '-5';
  assert.strictEqual(adapter.getConfiguredMaxToolCalls(), 3);

  process.env.GEMINI_MAX_TOOL_CALLS = 'abc';
  assert.strictEqual(adapter.getConfiguredMaxToolCalls(), 3);

  process.env.GEMINI_MAX_TOOL_CALLS = '2';
  assert.strictEqual(adapter.getConfiguredMaxToolCalls(), 2);

  if (original !== undefined) process.env.GEMINI_MAX_TOOL_CALLS = original;
  else delete process.env.GEMINI_MAX_TOOL_CALLS;
});

test('GEMINI_API_KEY 미설정 시 SDK 호출 없이 GEMINI_NOT_CONFIGURED를 즉시 반환한다', async () => {
  const adapter = require('./geminiAdapter');
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const result = await adapter.generateAgentReply({
    systemInstruction: 'test',
    contents: [],
    tools: null,
    responseJsonSchema: null,
    timeoutMs: 1000,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error_code, 'GEMINI_NOT_CONFIGURED');
  assert.strictEqual(result.retryable, false);

  if (original !== undefined) process.env.GEMINI_API_KEY = original;
});

test('normalizeError: AbortError는 GEMINI_TIMEOUT(retryable)으로 매핑된다', () => {
  const adapter = require('./geminiAdapter');
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  const result = adapter.normalizeError(err, 'secret-key');
  assert.strictEqual(result.error_code, 'GEMINI_TIMEOUT');
  assert.strictEqual(result.retryable, true);
});

test('normalizeError: status 401/403은 GEMINI_AUTH_FAILED(non-retryable)', () => {
  const adapter = require('./geminiAdapter');
  for (const status of [401, 403]) {
    const result = adapter.normalizeError({ status, message: 'auth failed' }, 'secret');
    assert.strictEqual(result.error_code, 'GEMINI_AUTH_FAILED');
    assert.strictEqual(result.retryable, false);
  }
});

test('normalizeError: status 429는 GEMINI_RATE_LIMITED(retryable)', () => {
  const adapter = require('./geminiAdapter');
  const result = adapter.normalizeError({ status: 429, message: 'rate limited' }, 'secret');
  assert.strictEqual(result.error_code, 'GEMINI_RATE_LIMITED');
  assert.strictEqual(result.retryable, true);
});

test('normalizeError: status 404는 GEMINI_MODEL_UNAVAILABLE', () => {
  const adapter = require('./geminiAdapter');
  const result = adapter.normalizeError({ status: 404, message: 'model not found' }, 'secret');
  assert.strictEqual(result.error_code, 'GEMINI_MODEL_UNAVAILABLE');
});

test('normalizeError: 인식 못하는 오류는 GEMINI_SDK_ERROR로 안전하게 떨어진다', () => {
  const adapter = require('./geminiAdapter');
  const result = adapter.normalizeError(new Error('something weird'), 'secret');
  assert.strictEqual(result.error_code, 'GEMINI_SDK_ERROR');
});

test('maskSecret: 에러 메시지에 API 키 값이 섞여 있어도 마스킹된다', () => {
  const adapter = require('./geminiAdapter');
  const masked = adapter.maskSecret('request failed with key sk-secret-123 in header', 'sk-secret-123');
  assert.ok(!masked.includes('sk-secret-123'));
  assert.ok(masked.includes('***'));
});

console.log(`\n🎉 ${passed}개 테스트 통과`);
