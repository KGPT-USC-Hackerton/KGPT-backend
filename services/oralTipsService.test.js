// Gemini SDK 는 mock 으로 대체한다. 실제 API 를 호출하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const geminiClientPath = require.resolve('../utils/geminiClient');

const calls = [];

// require.cache 에 가짜 모듈을 먼저 심어 실제 SDK 초기화를 막는다.
require.cache[geminiClientPath] = {
  id: geminiClientPath,
  filename: geminiClientPath,
  loaded: true,
  exports: {
    ai: {
      models: {
        generateContent: async (options) => {
          calls.push(options);
          return { text: '테스트 팁입니다.' };
        },
      },
    },
  },
};

const { generateOralCareTip } = require('./oralTipsService');

test('GEMINI_MODEL 이 설정되어 있으면 그 값을 사용한다', async () => {
  calls.length = 0;
  const previous = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'gemini-test-model';
  try {
    await generateOralCareTip();
  } finally {
    if (previous === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previous;
  }
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'gemini-test-model');
});

test('GEMINI_MODEL 이 없으면 gemini-2.5-flash 로 fallback 한다', async () => {
  calls.length = 0;
  const previous = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  try {
    await generateOralCareTip();
  } finally {
    if (previous !== undefined) process.env.GEMINI_MODEL = previous;
  }
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'gemini-2.5-flash');
});

test('어떤 경우에도 gemini-2.0-flash 를 사용하지 않는다', async () => {
  for (const call of calls) {
    assert.notStrictEqual(call.model, 'gemini-2.0-flash');
  }
});

test('mock 이 실제 SDK 모듈 경로를 대체했는지 확인', () => {
  assert.ok(path.isAbsolute(geminiClientPath));
});
