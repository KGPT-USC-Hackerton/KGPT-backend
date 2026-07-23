const { pool } = require('../../config/database');

// agent_sessions에 대한 조회/삽입만 담당. Agent가 쓰는 유일한 신규 테이블 접근 지점 중 하나.

async function findByIdAndUser(sessionId, userId) {
  const [rows] = await pool.query(
    `SELECT id, user_id, history_id, survey_session_id, status, context_snapshot, context_hash,
            model_name, prompt_version, session_version, idempotency_key, expires_at, created_at
     FROM agent_sessions
     WHERE id = ? AND user_id = ?`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

async function findByIdempotencyKey(userId, idempotencyKey) {
  const [rows] = await pool.query(
    `SELECT id, user_id, history_id, survey_session_id, status, context_snapshot, context_hash,
            model_name, prompt_version, session_version, idempotency_key, expires_at, created_at
     FROM agent_sessions
     WHERE user_id = ? AND idempotency_key = ?`,
    [userId, idempotencyKey]
  );
  return rows[0] || null;
}

async function insertReadySession({
  id,
  userId,
  historyId,
  surveySessionId,
  contextSnapshot,
  contextHash,
  modelName,
  promptVersion,
  idempotencyKey,
}) {
  await pool.query(
    `INSERT INTO agent_sessions
       (id, user_id, history_id, survey_session_id, status, context_snapshot, context_hash,
        model_name, prompt_version, idempotency_key)
     VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      historyId,
      surveySessionId,
      JSON.stringify(contextSnapshot),
      contextHash,
      modelName,
      promptVersion,
      idempotencyKey,
    ]
  );
}

module.exports = { findByIdAndUser, findByIdempotencyKey, insertReadySession };
