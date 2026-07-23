const crypto = require('crypto');
const { pool } = require('../../config/database');

// agent_chat_history / agent_tool_runs 조회 + 트랜잭션 저장만 담당한다.
// role 매핑: HTTP의 role:"assistant" 는 DB에는 role='model' 로 저장한다
// (agent_chat_history.role enum에 'assistant' 값이 없음, 'model'만 존재).

class AgentChatConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentChatConflictError';
    this.code = 'CLIENT_MESSAGE_ID_CONFLICT';
  }
}

class AgentChatSaveError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AgentChatSaveError';
    this.code = 'AGENT_MESSAGE_SAVE_FAILED';
    this.cause = cause;
  }
}

/**
 * 최근 메시지를 seq_no 오름차순(과거→최신)으로 반환한다.
 * 정렬 기준: DB에서는 seq_no DESC LIMIT N 으로 가장 최근 N개만 가져온 뒤,
 * 애플리케이션에서 reverse 해 시간순으로 되돌린다.
 */
async function findRecentMessages(sessionId, limit) {
  const [rows] = await pool.query(
    `SELECT id, seq_no, role, message_type, content_json, created_at
     FROM agent_chat_history
     WHERE session_id = ?
     ORDER BY seq_no DESC
     LIMIT ?`,
    [sessionId, limit]
  );
  return rows.reverse();
}

/**
 * client_message_id 사전 조회(트랜잭션 밖, Gemini 호출 전 최적화용).
 * 실제 race 안전성은 saveTurn 내부의 잠금 후 재조회가 담당한다.
 */
async function findByClientMessageId(sessionId, clientMessageId) {
  const [rows] = await pool.query(
    `SELECT id, seq_no, role, message_type, content_json, created_at
     FROM agent_chat_history
     WHERE session_id = ? AND client_message_id = ?`,
    [sessionId, clientMessageId]
  );
  return rows[0] || null;
}

async function findMessageBySeqNoOn(connectionOrPool, sessionId, seqNo) {
  const [rows] = await connectionOrPool.query(
    `SELECT id, seq_no, role, message_type, content_json, created_at
     FROM agent_chat_history
     WHERE session_id = ? AND seq_no = ?`,
    [sessionId, seqNo]
  );
  return rows[0] || null;
}

/**
 * client_message_id 사전 조회로 replay가 확정된 경우, 트랜잭션을 열지 않고
 * (Gemini 재호출도 없이) 짝이 되는 assistant 행을 바로 읽기 위한 공개 함수.
 */
async function findMessageBySeqNo(sessionId, seqNo) {
  return findMessageBySeqNoOn(pool, sessionId, seqNo);
}

async function findExistingToolRun(connection, sessionId, toolName, idempotencyKey) {
  const [rows] = await connection.query(
    `SELECT id, result_json, status FROM agent_tool_runs
     WHERE session_id = ? AND tool_name = ? AND idempotency_key = ?`,
    [sessionId, toolName, idempotencyKey]
  );
  return rows[0] || null;
}

/**
 * 사용자 메시지 + Assistant 메시지 + Tool 실행 기록을 하나의 트랜잭션으로 저장한다.
 *
 * 흐름:
 *   1) agent_sessions 행을 FOR UPDATE 로 잠가 동일 세션 동시요청을 직렬화한다.
 *   2) client_message_id 가 있으면 잠금 이후 다시 조회한다(사전 조회와 이 호출
 *      사이의 race 를 여기서 최종적으로 잡는다). 이미 존재 + 동일 내용 → replay.
 *      이미 존재 + 다른 내용 → CLIENT_MESSAGE_ID_CONFLICT.
 *   3) seq_no 를 계산해 user/assistant 행을 넣는다.
 *   4) toolExecutions 각각을 agent_tool_runs 에 넣되(message_id는 우선 NULL),
 *      idempotency_key 충돌 시 새로 넣지 않고 기존 행의 실제 id 를 재사용한다
 *      (사전 생성한 UUID 는 폐기 — assistant content_json/HTTP 응답에는
 *      실제 DB id 만 들어가야 하므로).
 *   5) assistant content_json 의 used_tool_results 를 위에서 확정된 실제
 *      tool_run id 로 채워 넣은 뒤에야 assistant 행을 insert 한다.
 *   6) 새로 insert 된 tool_run 행들만 message_id 를 assistant 행 id 로 backfill.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.userId
 * @param {string} params.userMessageText
 * @param {string|null} params.clientMessageId
 * @param {object} params.assistantContentWithoutToolIds - { content, evidence,
 *   needs_professional_review, disclaimer, used_tool_results: [{tool_name,
 *   tool_execution_ref}], response_mode, model_name, prompt_version, fallback_reason }
 * @param {Array} params.toolExecutions - [{ ref, candidateToolRunId, toolName,
 *   input, output, idempotencyKey, status, errorCode }]
 */
async function saveTurn({
  sessionId,
  userId,
  userMessageText,
  clientMessageId,
  assistantContentWithoutToolIds,
  toolExecutions,
}) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1) 세션 행 잠금 — 동일 세션에 대한 동시 요청을 여기서 직렬화한다.
    await connection.query('SELECT id FROM agent_sessions WHERE id = ? AND user_id = ? FOR UPDATE', [
      sessionId,
      userId,
    ]);

    // 2) 잠금 이후 client_message_id 재조회(race 최종 방어선).
    if (clientMessageId) {
      const [existingRows] = await connection.query(
        `SELECT id, seq_no, content_json FROM agent_chat_history
         WHERE session_id = ? AND client_message_id = ? FOR UPDATE`,
        [sessionId, clientMessageId]
      );
      const existing = existingRows[0];
      if (existing) {
        const sameContent = existing.content_json?.text === userMessageText;
        if (!sameContent) {
          await connection.rollback();
          throw new AgentChatConflictError('동일한 client_message_id가 다른 메시지 내용으로 이미 사용되었습니다.');
        }
        const assistantRow = await findMessageBySeqNoOn(connection, sessionId, existing.seq_no + 1);
        await connection.rollback();
        return {
          replay: true,
          userMessage: { id: String(existing.id), seq_no: existing.seq_no, content_json: existing.content_json },
          assistantMessage: assistantRow
            ? { id: String(assistantRow.id), seq_no: assistantRow.seq_no, content_json: assistantRow.content_json }
            : null,
        };
      }
    }

    // 3) seq_no 계산
    const [seqRows] = await connection.query(
      'SELECT COALESCE(MAX(seq_no), 0) + 1 AS nextSeq FROM agent_chat_history WHERE session_id = ?',
      [sessionId]
    );
    const userSeqNo = seqRows[0].nextSeq;
    const assistantSeqNo = userSeqNo + 1;

    // 4) Tool 실행 기록 저장(message_id 는 아직 NULL) — idempotency 충돌 시 재사용.
    const resolvedRefToToolRunId = new Map();
    const newlyInsertedToolRunIds = [];

    for (const exec of toolExecutions || []) {
      const existingToolRun = await findExistingToolRun(connection, sessionId, exec.toolName, exec.idempotencyKey);
      if (existingToolRun) {
        // 사전 생성한 candidateToolRunId 는 버리고 기존 행의 실제 id 를 사용한다.
        resolvedRefToToolRunId.set(exec.ref, existingToolRun.id);
        continue;
      }

      await connection.query(
        `INSERT INTO agent_tool_runs
           (id, session_id, message_id, tool_name, status, arguments_json, result_json,
            idempotency_key, attempt_count, error_code, retryable, completed_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP(6))`,
        [
          exec.candidateToolRunId,
          sessionId,
          exec.toolName,
          exec.status,
          JSON.stringify(exec.input),
          exec.output ? JSON.stringify(exec.output) : null,
          exec.idempotencyKey,
          exec.errorCode || null,
          exec.status === 'failed',
        ]
      );
      resolvedRefToToolRunId.set(exec.ref, exec.candidateToolRunId);
      newlyInsertedToolRunIds.push(exec.candidateToolRunId);
    }

    // 5) assistant content_json 의 tool_execution_ref 를 실제 tool_run id 로 치환.
    const finalUsedToolResults = (assistantContentWithoutToolIds.used_tool_results || []).map((item) => {
      const toolRunId = resolvedRefToToolRunId.get(item.tool_execution_ref);
      if (!toolRunId) {
        throw new AgentChatSaveError(`tool_execution_ref를 실제 tool_run id로 해석하지 못했습니다: ${item.tool_execution_ref}`);
      }
      return { tool_name: item.tool_name, tool_run_id: toolRunId };
    });

    const userContentJson = { text: userMessageText };
    const assistantContentJson = {
      ...assistantContentWithoutToolIds,
      used_tool_results: finalUsedToolResults,
    };
    delete assistantContentJson.tool_execution_ref; // 안전망: 남아있으면 제거

    const [userInsert] = await connection.query(
      `INSERT INTO agent_chat_history (session_id, seq_no, role, message_type, content_json, client_message_id)
       VALUES (?, ?, 'user', 'text', ?, ?)`,
      [sessionId, userSeqNo, JSON.stringify(userContentJson), clientMessageId || null]
    );

    const [assistantInsert] = await connection.query(
      `INSERT INTO agent_chat_history (session_id, seq_no, role, message_type, content_json, client_message_id)
       VALUES (?, ?, 'model', 'text', ?, NULL)`,
      [sessionId, assistantSeqNo, JSON.stringify(assistantContentJson)]
    );

    // 6) 새로 insert 된 tool_run 행만 message_id 를 assistant 행으로 backfill.
    if (newlyInsertedToolRunIds.length > 0) {
      await connection.query('UPDATE agent_tool_runs SET message_id = ? WHERE id IN (?)', [
        assistantInsert.insertId,
        newlyInsertedToolRunIds,
      ]);
    }

    await connection.commit();

    return {
      replay: false,
      userMessage: { id: String(userInsert.insertId), seq_no: userSeqNo, content_json: userContentJson },
      assistantMessage: { id: String(assistantInsert.insertId), seq_no: assistantSeqNo, content_json: assistantContentJson },
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // rollback 자체 실패는 무시하고 원본 에러를 전파한다.
    }
    if (error instanceof AgentChatConflictError || error instanceof AgentChatSaveError) {
      throw error;
    }
    throw new AgentChatSaveError('Agent 메시지 저장 중 오류가 발생했습니다.', error);
  } finally {
    connection.release();
  }
}

module.exports = {
  findRecentMessages,
  findByClientMessageId,
  findMessageBySeqNo,
  saveTurn,
  AgentChatConflictError,
  AgentChatSaveError,
  // 테스트용 노출(순수 헬퍼)
  _generateToolRunId: () => crypto.randomUUID(),
};
