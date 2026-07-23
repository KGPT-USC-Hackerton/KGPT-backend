const { pool } = require('../../config/database');

// shopify_cart_requests 에 대한 SQL 전담.
//
// 원칙:
//   * 모든 시각 값은 호출자가 주입한 JS Clock 이 계산해 bind 한다. 이 파일의
//     어떤 문장도 NOW()/CURRENT_TIMESTAMP() 를 쓰지 않는다.
//   * 상태 전이는 전부 조건부 UPDATE(WHERE status='pending')이며 affectedRows 로
//     성공 여부를 판정한다. 터미널 상태의 행은 다시 바뀌지 않는다.
//   * 외부 HTTP 호출 중에는 Transaction/row lock 을 잡지 않는다(각 함수는
//     짧은 단발 쿼리만 수행한다).

const SELECT_COLUMNS = `
  id, user_id, session_id, idempotency_key_hash, request_hash, proposal_hash,
  shopify_config_fingerprint, selected_items_json, status, attempt_count,
  shopify_cart_id, checkout_url,
  estimated_total_amount, estimated_total_currency_code, estimated_total_is_estimated,
  warning_codes_json, normalized_error_code, normalized_http_status, safe_error_details_json,
  external_call_started_at, completed_at, created_at, updated_at
`;

class ShopifyCartClaimConflictError extends Error {
  constructor(existingRow) {
    super('동일한 Idempotency-Key 로 이미 생성된 요청이 있습니다.');
    this.name = 'ShopifyCartClaimConflictError';
    this.code = 'SHOPIFY_CART_CLAIM_CONFLICT';
    this.existingRow = existingRow;
  }
}

/**
 * pending 상태로 Idempotency claim 을 시도한다.
 * UNIQUE(user_id, idempotency_key_hash) 가 동시성 직렬화 지점이다.
 * 이미 존재하면 ShopifyCartClaimConflictError(기존 행 포함)를 던진다.
 */
async function insertPendingClaim({
  id,
  userId,
  sessionId,
  idempotencyKeyHash,
  requestHash,
  proposalHash,
  shopifyConfigFingerprint,
  selectedItems,
  now,
}) {
  try {
    await pool.query(
      `INSERT INTO shopify_cart_requests
         (id, user_id, session_id, idempotency_key_hash, request_hash, proposal_hash,
          shopify_config_fingerprint, selected_items_json, status, attempt_count,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [
        id,
        userId,
        sessionId,
        idempotencyKeyHash,
        requestHash,
        proposalHash,
        shopifyConfigFingerprint,
        JSON.stringify(selectedItems),
        now,
        now,
      ]
    );
    return { claimed: true, id };
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      const existing = await findByIdempotency(userId, idempotencyKeyHash);
      throw new ShopifyCartClaimConflictError(existing);
    }
    throw error;
  }
}

async function findByIdempotency(userId, idempotencyKeyHash) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM shopify_cart_requests
      WHERE user_id = ? AND idempotency_key_hash = ?`,
    [userId, idempotencyKeyHash]
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.query(`SELECT ${SELECT_COLUMNS} FROM shopify_cart_requests WHERE id = ?`, [id]);
  return rows[0] || null;
}

/**
 * Shopify fetch 직전에 호출한다. affectedRows === 1 인 경우에만 실제 호출을
 * 진행해야 한다. 동시에 stale 처리기가 같은 행을 터미널 상태로 바꿨다면
 * status 가 더 이상 'pending' 이 아니므로 여기서 0 이 반환된다.
 */
async function markExternalCallStarted({ id, now }) {
  const [result] = await pool.query(
    `UPDATE shopify_cart_requests
        SET external_call_started_at = ?, attempt_count = 1, updated_at = ?
      WHERE id = ?
        AND status = 'pending'
        AND external_call_started_at IS NULL
        AND attempt_count = 0`,
    [now, now, id]
  );
  return result.affectedRows;
}

/**
 * 성공 전이. 불변조건상 succeeded 는 cart/url/금액 3종/completed_at 이 모두
 * 채워지고 오류 컬럼은 전부 NULL 이어야 한다.
 */
async function markSucceeded({
  id,
  shopifyCartId,
  checkoutUrl,
  estimatedTotalAmount,
  estimatedTotalCurrencyCode,
  estimatedTotalIsEstimated,
  warningCodes,
  now,
}) {
  const [result] = await pool.query(
    `UPDATE shopify_cart_requests
        SET status = 'succeeded',
            shopify_cart_id = ?,
            checkout_url = ?,
            estimated_total_amount = ?,
            estimated_total_currency_code = ?,
            estimated_total_is_estimated = ?,
            warning_codes_json = ?,
            normalized_error_code = NULL,
            normalized_http_status = NULL,
            safe_error_details_json = NULL,
            completed_at = ?,
            updated_at = ?
      WHERE id = ? AND status = 'pending'`,
    [
      shopifyCartId,
      checkoutUrl,
      estimatedTotalAmount,
      estimatedTotalCurrencyCode,
      estimatedTotalIsEstimated ? 1 : 0,
      JSON.stringify(warningCodes || []),
      now,
      now,
      id,
    ]
  );
  return result.affectedRows;
}

/**
 * 실패/불확실 전이. 두 상태 모두 금액 컬럼을 채우지 않는다(임의 생성 금지).
 */
async function markTerminalError({ id, status, normalizedErrorCode, normalizedHttpStatus, safeErrorDetails, now }) {
  const [result] = await pool.query(
    `UPDATE shopify_cart_requests
        SET status = ?,
            normalized_error_code = ?,
            normalized_http_status = ?,
            safe_error_details_json = ?,
            shopify_cart_id = NULL,
            checkout_url = NULL,
            estimated_total_amount = NULL,
            estimated_total_currency_code = NULL,
            estimated_total_is_estimated = NULL,
            warning_codes_json = NULL,
            completed_at = ?,
            updated_at = ?
      WHERE id = ? AND status = 'pending'`,
    [
      status,
      normalizedErrorCode,
      normalizedHttpStatus,
      safeErrorDetails ? JSON.stringify(safeErrorDetails) : null,
      now,
      now,
      id,
    ]
  );
  return result.affectedRows;
}

/**
 * A. 호출 전 stale: external_call_started_at IS NULL 이고 created_at 기준으로
 * lease 가 만료된 행을 failed 로 전이한다(Shopify 호출 없음).
 */
async function expireStaleBeforeDispatch({ id, beforeDispatchCutoff, now }) {
  const [result] = await pool.query(
    `UPDATE shopify_cart_requests
        SET status = 'failed',
            normalized_error_code = 'SHOPIFY_CART_ABORTED_BEFORE_DISPATCH',
            normalized_http_status = 503,
            completed_at = ?,
            updated_at = ?
      WHERE id = ?
        AND status = 'pending'
        AND external_call_started_at IS NULL
        AND created_at < ?`,
    [now, now, id, beforeDispatchCutoff]
  );
  return result.affectedRows;
}

/**
 * B. 호출 후 stale: external_call_started_at IS NOT NULL 이고 그 시각 기준으로
 * lease 가 만료된 행을 outcome_unknown 으로 전이한다. Mutation 재호출은 없다.
 * (created_at 이 아니라 external_call_started_at 이 기준인 것이 중요하다 —
 *  요청 생성 후 늦게 dispatch 된 정상 호출을 조기에 뒤집지 않기 위함.)
 */
async function expireStaleAfterDispatch({ id, afterDispatchCutoff, now }) {
  const [result] = await pool.query(
    `UPDATE shopify_cart_requests
        SET status = 'outcome_unknown',
            normalized_error_code = 'SHOPIFY_CART_OUTCOME_UNKNOWN',
            normalized_http_status = 502,
            completed_at = ?,
            updated_at = ?
      WHERE id = ?
        AND status = 'pending'
        AND external_call_started_at IS NOT NULL
        AND external_call_started_at < ?`,
    [now, now, id, afterDispatchCutoff]
  );
  return result.affectedRows;
}

module.exports = {
  ShopifyCartClaimConflictError,
  insertPendingClaim,
  findByIdempotency,
  findById,
  markExternalCallStarted,
  markSucceeded,
  markTerminalError,
  expireStaleBeforeDispatch,
  expireStaleAfterDispatch,
};
