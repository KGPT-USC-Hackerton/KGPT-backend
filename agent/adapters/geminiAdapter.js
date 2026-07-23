// ============================================================================
// BloomDent Agent — Gemini Adapter
// ----------------------------------------------------------------------------
// @google/genai import는 이 파일에만 존재한다. 다른 controller/service/
// repository는 이 파일이 반환하는 정규화된 결과만 다루고, SDK 고유 객체나
// raw error를 절대 직접 만지지 않는다.
//
// API 키는 실제 호출 시점에만 확인한다(import/모듈 로드 시점에 throw하지 않음
// → API 키 없이도 서버와 기존 API는 정상 기동). 키/시크릿은 어떤 로그·에러
// 메시지에도 그대로 노출하지 않는다(maskSecret).
// ============================================================================

const { GoogleGenAI, ApiError } = require('@google/genai');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000;
const HARD_MAX_TOOL_CALLS = 3;
const DEFAULT_MAX_TOOL_CALLS = 3;

let cachedClient = null;
let cachedClientApiKey = null;

function getConfiguredModel() {
  const raw = process.env.GEMINI_MODEL;
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_MODEL;
  return raw.trim();
}

function getConfiguredTimeoutMs() {
  const raw = Number(process.env.GEMINI_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function getConfiguredMaxToolCalls() {
  const raw = Number(process.env.GEMINI_MAX_TOOL_CALLS);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_TOOL_CALLS;
  return Math.min(raw, HARD_MAX_TOOL_CALLS);
}

// GOOGLE_API_KEY가 설정돼 있어도 무시한다 — 이 프로젝트는 GEMINI_API_KEY만
// 공식적으로 사용한다(SDK의 암묵적 env 자동감지에 기대지 않고 apiKey를 항상
// 명시적으로 전달해 GOOGLE_API_KEY 자동 픽업을 우회한다).
function getClient(apiKey) {
  if (!cachedClient || cachedClientApiKey !== apiKey) {
    cachedClient = new GoogleGenAI({ apiKey });
    cachedClientApiKey = apiKey;
  }
  return cachedClient;
}

function maskSecret(text, secret) {
  if (!secret || typeof text !== 'string') return text;
  return text.split(secret).join('***');
}

function normalizeError(error, apiKey) {
  const message = maskSecret(error && error.message, apiKey);

  if (error && (error.name === 'AbortError' || /aborted/i.test(String(message)))) {
    return { ok: false, error_code: 'GEMINI_TIMEOUT', retryable: true };
  }
  if (error instanceof ApiError || typeof error?.status === 'number') {
    const status = error.status;
    if (status === 401 || status === 403) return { ok: false, error_code: 'GEMINI_AUTH_FAILED', retryable: false };
    if (status === 429) return { ok: false, error_code: 'GEMINI_RATE_LIMITED', retryable: true };
    if (status === 404) return { ok: false, error_code: 'GEMINI_MODEL_UNAVAILABLE', retryable: false };
    if (status >= 500) return { ok: false, error_code: 'GEMINI_SDK_ERROR', retryable: true };
  }
  return { ok: false, error_code: 'GEMINI_SDK_ERROR', retryable: false };
}

/**
 * SDK 응답의 model Content 전체(role/parts/thoughtSignature 등)를 가공 없이
 * JSON-safe plain object로 clone한다. Service는 이 값을 그대로 다음 contents에
 * push해 원래 순서·필드를 보존한다.
 */
function cloneModelTurn(content) {
  if (!content) return null;
  return JSON.parse(JSON.stringify(content));
}

/**
 * 하나의 Gemini generateContent 호출을 감싼다. 대화 상태(contents 배열)는
 * 호출부(agentMessageService)가 구성/보존한다 — 이 함수는 상태를 갖지 않는다.
 */
async function generateAgentReply({ systemInstruction, contents, tools, responseJsonSchema, timeoutMs }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error_code: 'GEMINI_NOT_CONFIGURED', retryable: false };
  }

  const model = getConfiguredModel();
  const effectiveTimeoutMs = Math.min(
    Math.max(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS
  );

  const config = {
    systemInstruction,
    abortSignal: AbortSignal.timeout(effectiveTimeoutMs),
  };
  if (tools) {
    config.tools = tools;
  }
  if (responseJsonSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = responseJsonSchema;
  }

  let response;
  try {
    const client = getClient(apiKey);
    response = await client.models.generateContent({ model, contents, config });
  } catch (error) {
    if (process.env.DEBUG_GEMINI_ADAPTER) {
      console.error('DEBUG_GEMINI_ADAPTER raw error:', maskSecret(error?.stack || error?.message || String(error), apiKey));
    }
    return normalizeError(error, apiKey);
  }

  const candidate = response?.candidates?.[0];
  if (!candidate) {
    return { ok: false, error_code: 'GEMINI_INVALID_RESPONSE', retryable: false };
  }

  const functionCalls = (response.functionCalls || []).map((fc) => ({
    id: fc.id || null,
    name: fc.name,
    args: fc.args || {},
  }));

  return {
    ok: true,
    response: {
      content: typeof response.text === 'string' ? response.text : null,
      functionCalls,
      modelTurnRaw: cloneModelTurn(candidate.content),
    },
    usage: {
      input_tokens: response.usageMetadata?.promptTokenCount ?? null,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? null,
    },
    model,
    finish_reason: candidate.finishReason || null,
  };
}

module.exports = {
  generateAgentReply,
  getConfiguredModel,
  getConfiguredTimeoutMs,
  getConfiguredMaxToolCalls,
  normalizeError,
  maskSecret,
  DEFAULT_MODEL,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_TOOL_CALLS,
};
