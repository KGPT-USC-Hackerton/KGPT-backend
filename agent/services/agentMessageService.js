const crypto = require('crypto');

const defaultAgentRepository = require('../repositories/agentRepository');
const defaultChatRepository = require('../repositories/agentChatRepository');
const defaultAdapter = require('../adapters/geminiAdapter');
const { computeContextHash, canonicalStringify } = require('./contextSnapshotService');
const { validateToolInputGrounding } = require('./toolInputGrounding');
const { AGENT_SYSTEM_INSTRUCTION, AGENT_SYSTEM_PROMPT_VERSION, buildTrustedContextText } = require('../prompts/agentSystemPrompt');
const {
  AGENT_MESSAGE_RESPONSE_JSON_SCHEMA,
  validateAgentMessageResponse,
  COST_LIKE_NUMBER_PATTERN,
} = require('../schemas/agentMessageResponseSchema');
const { CALCULATE_OOP_COST_TOOL_NAME, CALCULATE_OOP_COST_DECLARATION, executeTool } = require('../tools/toolRegistry');
const { validateCalculateOopCostInput, CalculateOopCostError } = require('../tools/calculateOopCost');
const { FEE_SCHEDULE_VERSION } = require('../data/demoFeeSchedule');

const HARD_MAX_TOOL_CALLS = 3;
const REQUEST_TIMEOUT_BUDGET_MS = 30000;
const MIN_CALL_BUDGET_MS = 2000;
const HISTORY_LIMIT = 20;
const HISTORY_CHAR_BUDGET = 8000;
const REPAIR_INSTRUCTION_TEXT =
  '이전 출력이 요구된 JSON 스키마와 맞지 않았습니다. 추가 설명 없이 스키마에 맞는 JSON만 다시 출력하세요.';
const FIXED_COST_NOTICE_TEXT = '데모 비용 추정 결과는 아래 구조화된 비용 항목을 확인해 주세요.';

class AgentMessageError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AgentMessageError';
    this.code = code;
    this.extra = extra || null;
  }
}

// ---------------------------------------------------------------------------
// Session 검증
// ---------------------------------------------------------------------------
async function loadAndValidateSession(sessionRepository, sessionId, userId) {
  const session = await sessionRepository.findByIdAndUser(sessionId, userId);
  if (!session) {
    throw new AgentMessageError('AGENT_SESSION_NOT_FOUND', '해당 세션을 찾을 수 없습니다.');
  }
  if (session.status !== 'ready') {
    throw new AgentMessageError('AGENT_SESSION_NOT_READY', '세션이 ready 상태가 아닙니다.');
  }
  if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
    throw new AgentMessageError('AGENT_SESSION_EXPIRED', '세션이 만료되었습니다.');
  }
  if (!session.context_snapshot || !session.context_hash) {
    throw new AgentMessageError('AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot이 존재하지 않습니다.');
  }
  const recomputedHash = computeContextHash(session.context_snapshot);
  if (recomputedHash !== session.context_hash) {
    throw new AgentMessageError('AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot 무결성 검증에 실패했습니다.');
  }
  return session;
}

// ---------------------------------------------------------------------------
// 대화 기록
// ---------------------------------------------------------------------------
function trimHistoryByCharBudget(rows, charBudget) {
  let total = 0;
  const kept = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const text = rows[i].content_json?.text || '';
    if (total + text.length > charBudget && kept.length > 0) break;
    total += text.length;
    kept.unshift(rows[i]);
  }
  return kept;
}

function historyRowsToContents(rows) {
  return rows
    .filter((row) => row.message_type === 'text' && (row.role === 'user' || row.role === 'model'))
    .map((row) => ({ role: row.role, parts: [{ text: row.content_json?.text || '' }] }));
}

// ---------------------------------------------------------------------------
// Function Calling 헬퍼 — functionCall.id가 없으면 넣지 않고 name 기반으로만 응답한다.
// ---------------------------------------------------------------------------
function buildFunctionResponsePart(functionCall, responsePayload) {
  const functionResponse = { name: functionCall.name, response: responsePayload };
  if (functionCall.id) {
    functionResponse.id = functionCall.id;
  }
  return { role: 'function', parts: [{ functionResponse }] };
}

function computeToolIdempotencyKey(toolName, feeScheduleVersion, input) {
  const hashInput = canonicalStringify({ tool_name: toolName, fee_schedule_version: feeScheduleVersion, input });
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

// ---------------------------------------------------------------------------
// Phase 2 출력 검증 + 비용 숫자 정규화
// ---------------------------------------------------------------------------
function buildAllowedEvidenceReferences(contextSnapshot, succeededToolExecutions) {
  const refs = new Set();
  for (const image of contextSnapshot?.images || []) {
    if (image.position) refs.add(image.position);
  }
  for (const response of contextSnapshot?.survey?.responses || []) {
    if (response.category) refs.add(response.category);
  }
  for (const exec of succeededToolExecutions) {
    refs.add(exec.ref);
  }
  return refs;
}

function finalizePhase2Output(parsed, toolExecutions, contextSnapshot) {
  const structural = validateAgentMessageResponse(parsed);
  if (!structural.valid) {
    return { ok: false, reason: 'GEMINI_SCHEMA_VALIDATION_FAILED' };
  }

  const succeeded = toolExecutions.filter((exec) => exec.status === 'succeeded');
  const succeededRefs = new Set(succeeded.map((exec) => exec.ref));
  for (const item of parsed.used_tool_results) {
    if (!succeededRefs.has(item.tool_execution_ref)) {
      return { ok: false, reason: 'GEMINI_SCHEMA_VALIDATION_FAILED' };
    }
  }

  const allowedEvidenceRefs = buildAllowedEvidenceReferences(contextSnapshot, succeeded);
  for (const item of parsed.evidence) {
    if (!allowedEvidenceRefs.has(item.reference)) {
      return { ok: false, reason: 'GEMINI_SCHEMA_VALIDATION_FAILED' };
    }
  }

  // 비용 숫자 정책: Tool을 사용했다면 content를 신뢰하지 않고 고정 문구로
  // 정규화한다(실제 금액은 tool_results로만 전달). Tool을 안 썼는데 비용류
  // 숫자가 있으면 hallucination으로 보고 거부(fallback)한다.
  let finalContent = parsed.content;
  if (parsed.used_tool_results.length > 0) {
    finalContent = FIXED_COST_NOTICE_TEXT;
  } else if (COST_LIKE_NUMBER_PATTERN.test(parsed.content)) {
    return { ok: false, reason: 'COST_OUTPUT_MISMATCH' };
  }

  return { ok: true, value: { ...parsed, content: finalContent } };
}

// ---------------------------------------------------------------------------
// HTTP 응답 조립
// ---------------------------------------------------------------------------
function buildHttpResult(sessionId, saveResult) {
  const userContent = saveResult.userMessage.content_json;
  const assistantContent = saveResult.assistantMessage.content_json;
  return {
    session_id: sessionId,
    user_message: {
      id: saveResult.userMessage.id,
      role: 'user',
      content: userContent.text,
    },
    assistant_message: {
      id: saveResult.assistantMessage?.id || null,
      role: 'assistant',
      response_mode: assistantContent?.response_mode || null,
      content: assistantContent?.content || null,
      evidence: assistantContent?.evidence || [],
      tool_results: (assistantContent?.used_tool_results || []).map((item) => ({
        tool_name: item.tool_name,
        tool_run_id: item.tool_run_id,
      })),
      needs_professional_review: assistantContent?.needs_professional_review ?? true,
      disclaimer: assistantContent?.disclaimer || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------
async function processMessage(
  { sessionId, userId, message, clientMessageId },
  deps = {}
) {
  const sessionRepository = deps.sessionRepository || defaultAgentRepository;
  const chatRepository = deps.chatRepository || defaultChatRepository;
  const adapter = deps.adapter || defaultAdapter;
  const buildTemplateFallbackContent =
    deps.buildTemplateFallbackContent || require('../shared/safeFallbackResponse').buildTemplateFallbackContent;

  const trimmedMessage = message.trim();

  const session = await loadAndValidateSession(sessionRepository, sessionId, userId);

  // client_message_id 사전 조회 — 이미 처리된 요청이면 Gemini를 다시 호출하지 않고 재현한다.
  // (race에 대한 최종 방어는 saveTurn 트랜잭션 내부에서 별도로 수행된다.)
  if (clientMessageId) {
    const existingUser = await chatRepository.findByClientMessageId(sessionId, clientMessageId);
    if (existingUser) {
      if (existingUser.content_json?.text !== trimmedMessage) {
        throw new AgentMessageError('CLIENT_MESSAGE_ID_CONFLICT', '동일한 client_message_id가 다른 메시지 내용으로 이미 사용되었습니다.');
      }
      const assistantRow = await chatRepository.findMessageBySeqNo(sessionId, existingUser.seq_no + 1);
      return buildHttpResult(sessionId, {
        userMessage: { id: String(existingUser.id), content_json: existingUser.content_json },
        assistantMessage: assistantRow ? { id: String(assistantRow.id), content_json: assistantRow.content_json } : null,
      });
    }
  }

  const historyRowsDesc = await chatRepository.findRecentMessages(sessionId, HISTORY_LIMIT);
  const trimmedHistoryRows = trimHistoryByCharBudget(historyRowsDesc, HISTORY_CHAR_BUDGET);
  const historyContents = historyRowsToContents(trimmedHistoryRows);
  const recentMessageTexts = trimmedHistoryRows.map((row) => row.content_json?.text).filter(Boolean);

  const trustedContextContent = { role: 'user', parts: [{ text: buildTrustedContextText(session.context_snapshot) }] };
  const userMessageContent = { role: 'user', parts: [{ text: `<user_message>\n${trimmedMessage}\n</user_message>` }] };

  let contents = [trustedContextContent, ...historyContents, userMessageContent];

  const requestDeadline = Date.now() + REQUEST_TIMEOUT_BUDGET_MS;
  const remaining = () => requestDeadline - Date.now();
  const configuredTimeoutMs = typeof adapter.getConfiguredTimeoutMs === 'function' ? adapter.getConfiguredTimeoutMs() : 15000;

  const toolExecutions = []; // { ref, candidateToolRunId, toolName, input, output, idempotencyKey, status, errorCode }
  let fallbackReason = null;
  let attemptedToolCalls = 0;
  let finalAnswer = null;
  let usedModel = null;

  // -------------------- Phase 1: Tool Loop --------------------
  for (let iteration = 0; iteration < HARD_MAX_TOOL_CALLS && !fallbackReason; iteration += 1) {
    if (remaining() < MIN_CALL_BUDGET_MS) {
      fallbackReason = 'REQUEST_TIMEOUT_BUDGET_EXCEEDED';
      break;
    }

    const result = await adapter.generateAgentReply({
      systemInstruction: AGENT_SYSTEM_INSTRUCTION,
      contents,
      tools: [{ functionDeclarations: [CALCULATE_OOP_COST_DECLARATION] }],
      responseJsonSchema: null,
      timeoutMs: Math.min(configuredTimeoutMs, remaining()),
    });

    if (!result.ok) {
      fallbackReason = result.error_code;
      break;
    }

    const { functionCalls, modelTurnRaw } = result.response;

    if (functionCalls.length >= 2) {
      fallbackReason = 'GEMINI_INVALID_RESPONSE';
      break;
    }
    if (functionCalls.length === 0) {
      // Gemini API는 contents가 model 턴으로 끝나는 요청을 거부한다
      // ("Requests ending with a model turn are not supported unless the last
      // part is a function response"). Tool을 안 쓰기로 한 이 turn의 자유 텍스트는
      // 어차피 Phase 2에서 스키마에 맞춰 다시 요청하므로 이어붙이지 않는다.
      break; // Phase 2로
    }

    attemptedToolCalls += 1;
    if (modelTurnRaw) contents.push(modelTurnRaw);

    const functionCall = functionCalls[0];

    if (functionCall.name !== CALCULATE_OOP_COST_TOOL_NAME) {
      contents.push(buildFunctionResponsePart(functionCall, { error: 'TOOL_NOT_ALLOWED' }));
    } else {
      let schemaOk = true;
      try {
        validateCalculateOopCostInput(functionCall.args);
      } catch (err) {
        if (!(err instanceof CalculateOopCostError)) throw err;
        schemaOk = false;
      }

      if (!schemaOk) {
        contents.push(buildFunctionResponsePart(functionCall, { error: 'TOOL_INPUT_INVALID' }));
      } else {
        const grounding = validateToolInputGrounding({
          toolInput: functionCall.args,
          contextSnapshot: session.context_snapshot,
          userMessage: trimmedMessage,
          recentMessageTexts,
        });

        if (!grounding.valid) {
          contents.push(buildFunctionResponsePart(functionCall, { error: 'TOOL_INPUT_UNGROUNDED' }));
        } else {
          const ref = `tool_call_${toolExecutions.length + 1}`;
          const candidateToolRunId = crypto.randomUUID();
          const idempotencyKey = computeToolIdempotencyKey(
            CALCULATE_OOP_COST_TOOL_NAME,
            FEE_SCHEDULE_VERSION,
            grounding.correctedInput
          );

          try {
            const output = executeTool(CALCULATE_OOP_COST_TOOL_NAME, grounding.correctedInput);
            toolExecutions.push({
              ref,
              candidateToolRunId,
              toolName: CALCULATE_OOP_COST_TOOL_NAME,
              input: grounding.correctedInput,
              output,
              idempotencyKey,
              status: 'succeeded',
              errorCode: null,
            });
            contents.push(buildFunctionResponsePart(functionCall, { tool_execution_ref: ref, ...output }));
          } catch (err) {
            const errorCode = err instanceof CalculateOopCostError ? err.code : 'TOOL_EXECUTION_FAILED';
            toolExecutions.push({
              ref,
              candidateToolRunId,
              toolName: CALCULATE_OOP_COST_TOOL_NAME,
              input: grounding.correctedInput,
              output: null,
              idempotencyKey,
              status: 'failed',
              errorCode,
            });
            contents.push(buildFunctionResponsePart(functionCall, { error: errorCode, tool_execution_ref: ref }));
          }
        }
      }
    }

    if (attemptedToolCalls >= HARD_MAX_TOOL_CALLS) break;
  }

  // -------------------- Phase 2: Final Structured Answer --------------------
  if (!fallbackReason) {
    if (remaining() < MIN_CALL_BUDGET_MS) {
      fallbackReason = 'REQUEST_TIMEOUT_BUDGET_EXCEEDED';
    } else {
      const result = await adapter.generateAgentReply({
        systemInstruction: AGENT_SYSTEM_INSTRUCTION,
        contents,
        tools: null,
        responseJsonSchema: AGENT_MESSAGE_RESPONSE_JSON_SCHEMA,
        timeoutMs: Math.min(configuredTimeoutMs, remaining()),
      });

      const evaluated = evaluateAdapterJsonResult(result, toolExecutions, session.context_snapshot);

      if (evaluated.ok) {
        finalAnswer = evaluated.value;
        usedModel = result.model;
      } else if (result.ok && remaining() >= MIN_CALL_BUDGET_MS) {
        // repair 1회 — tool 호출 한도와 별개, 요청 전체 예산 안에서만 시도.
        const repairContents = [...contents];
        if (result.response.modelTurnRaw) repairContents.push(result.response.modelTurnRaw);
        repairContents.push({ role: 'user', parts: [{ text: REPAIR_INSTRUCTION_TEXT }] });

        const repairResult = await adapter.generateAgentReply({
          systemInstruction: AGENT_SYSTEM_INSTRUCTION,
          contents: repairContents,
          tools: null,
          responseJsonSchema: AGENT_MESSAGE_RESPONSE_JSON_SCHEMA,
          timeoutMs: Math.min(configuredTimeoutMs, remaining()),
        });
        const repairEvaluated = evaluateAdapterJsonResult(repairResult, toolExecutions, session.context_snapshot);
        if (repairEvaluated.ok) {
          finalAnswer = repairEvaluated.value;
          usedModel = repairResult.model;
        } else {
          fallbackReason = repairEvaluated.reason;
        }
      } else {
        fallbackReason = evaluated.reason;
      }
    }
  }

  // -------------------- Assistant content 조립 --------------------
  let assistantContentWithoutToolIds;
  if (finalAnswer) {
    assistantContentWithoutToolIds = {
      content: finalAnswer.content,
      evidence: finalAnswer.evidence,
      used_tool_results: finalAnswer.used_tool_results,
      needs_professional_review: finalAnswer.needs_professional_review,
      disclaimer: finalAnswer.disclaimer,
      response_mode: 'gemini',
      fallback_reason: null,
      model_name: usedModel,
      prompt_version: AGENT_SYSTEM_PROMPT_VERSION,
    };
  } else {
    const fallbackContent = buildTemplateFallbackContent({
      contextSnapshot: session.context_snapshot,
      fallbackReason,
    });
    assistantContentWithoutToolIds = { ...fallbackContent, prompt_version: AGENT_SYSTEM_PROMPT_VERSION };
  }

  const saveResult = await chatRepository.saveTurn({
    sessionId,
    userId,
    userMessageText: trimmedMessage,
    clientMessageId: clientMessageId || null,
    assistantContentWithoutToolIds,
    toolExecutions,
  });

  return buildHttpResult(sessionId, saveResult);
}

function evaluateAdapterJsonResult(result, toolExecutions, contextSnapshot) {
  if (!result.ok) {
    return { ok: false, reason: result.error_code };
  }
  if (typeof result.response.content !== 'string') {
    return { ok: false, reason: 'GEMINI_INVALID_RESPONSE' };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.response.content);
  } catch (error) {
    return { ok: false, reason: 'GEMINI_INVALID_RESPONSE' };
  }
  return finalizePhase2Output(parsed, toolExecutions, contextSnapshot);
}

module.exports = {
  processMessage,
  AgentMessageError,
  HARD_MAX_TOOL_CALLS,
  REQUEST_TIMEOUT_BUDGET_MS,
  MIN_CALL_BUDGET_MS,
  HISTORY_LIMIT,
  HISTORY_CHAR_BUDGET,
  FIXED_COST_NOTICE_TEXT,
  // 테스트 노출(순수 헬퍼)
  trimHistoryByCharBudget,
  historyRowsToContents,
  buildFunctionResponsePart,
  computeToolIdempotencyKey,
  finalizePhase2Output,
  buildAllowedEvidenceReferences,
};
