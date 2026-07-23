const { pool } = require('../../config/database');

// dental_passes 에 대한 조회/삽입/철회만 담당한다.

class ActiveDentalPassLimitError extends Error {
  constructor() {
    super('세션당 활성 Dental Pass 개수 제한을 초과했습니다.');
    this.name = 'ActiveDentalPassLimitError';
    this.code = 'ACTIVE_DENTAL_PASS_LIMIT_REACHED';
  }
}

class DentalPassTokenCollisionError extends Error {
  constructor() {
    super('Share Token 해시가 이미 사용 중입니다.');
    this.name = 'DentalPassTokenCollisionError';
    this.code = 'DENTAL_PASS_TOKEN_COLLISION';
  }
}

/**
 * Pass 생성을 트랜잭션 안에서 처리한다.
 *   1) agent_sessions 행을 FOR UPDATE 로 잠가 동일 세션 동시 생성 요청을 직렬화한다.
 *   2) 활성(status='active' AND expires_at > nowForLimitCheck) Pass 개수를
 *      같은 잠금 하에서 재확인한다. nowForLimitCheck 는 서비스가 주입한 clock
 *      값을 그대로 SQL 파라미터로 전달한다(DB NOW()와 애플리케이션 시각 혼용 방지).
 *   3) 제한 초과 시 ActiveDentalPassLimitError, share_token_hash 중복 시
 *      DentalPassTokenCollisionError 를 던진다(서비스가 새 토큰으로 재시도).
 *   4) status/consent_at/expires_at 은 DB 기본값에 의존하지 않고 항상 명시적으로 저장한다.
 */
async function insertActivePassWithLimit({
  id,
  sessionId,
  userId,
  findingsJson,
  disclaimer,
  shareTokenHash,
  consentAt,
  expiresAt,
  nowForLimitCheck,
  maxActivePasses,
}) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query('SELECT id FROM agent_sessions WHERE id = ? AND user_id = ? FOR UPDATE', [
      sessionId,
      userId,
    ]);

    const [activeRows] = await connection.query(
      `SELECT id FROM dental_passes
       WHERE session_id = ? AND status = 'active' AND expires_at > ?
       FOR UPDATE`,
      [sessionId, nowForLimitCheck]
    );
    if (activeRows.length >= maxActivePasses) {
      throw new ActiveDentalPassLimitError();
    }

    await connection.query(
      `INSERT INTO dental_passes
         (id, session_id, user_id, findings_json, disclaimer, share_token_hash, status, consent_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, sessionId, userId, JSON.stringify(findingsJson), disclaimer, shareTokenHash, consentAt, expiresAt]
    );

    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // rollback 자체 실패는 무시하고 원본 에러를 전파한다.
    }
    if (error instanceof ActiveDentalPassLimitError) throw error;
    if (error && error.code === 'ER_DUP_ENTRY') throw new DentalPassTokenCollisionError();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 공개 조회 전용 — 최소 컬럼만 SELECT 한다(id/session_id/user_id/consent_at 등은
 * 애초에 쿼리에 넣지 않아 애플리케이션 메모리에도 올라오지 않는다).
 */
async function findByTokenHash(tokenHash) {
  const [rows] = await pool.query(
    `SELECT status, expires_at, findings_json
     FROM dental_passes
     WHERE share_token_hash = ?`,
    [tokenHash]
  );
  return rows[0] || null;
}

/**
 * 소유권 확인 후 idempotent 철회.
 * 반환값: null(미존재/비소유) | { id, status: 'revoked' }
 */
async function revokeOwnedPass(passId, userId) {
  const [rows] = await pool.query('SELECT id, status FROM dental_passes WHERE id = ? AND user_id = ?', [
    passId,
    userId,
  ]);
  const existing = rows[0];
  if (!existing) return null;

  if (existing.status !== 'revoked') {
    await pool.query("UPDATE dental_passes SET status = 'revoked' WHERE id = ?", [passId]);
  }
  return { id: existing.id, status: 'revoked' };
}

module.exports = {
  insertActivePassWithLimit,
  findByTokenHash,
  revokeOwnedPass,
  ActiveDentalPassLimitError,
  DentalPassTokenCollisionError,
};
