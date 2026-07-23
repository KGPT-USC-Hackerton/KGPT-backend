-- ============================================================================
-- BloomDent — Shopify Cart 요청 Idempotency 테이블 (비파괴적 Migration)
-- ----------------------------------------------------------------------------
-- 배경: Shopify Storefront cartCreate 는 BloomDent 의 Idempotency-Key 를
--   처리해주지 않으므로, 로컬 DB 를 idempotency 의 single source of truth 로
--   사용한다. 이 테이블은 "요청 1건 = 행 1개"이며 status 로 상태 전이를
--   추적한다(pending → succeeded | failed | outcome_unknown).
--
-- 안전 원칙 (CLAUDE.md "Database safety"):
--   * 신규 Agent 테이블만 추가한다. DROP / TRUNCATE / DELETE 없음.
--   * Core 테이블(users, agent_sessions 등)은 FK 로 "참조"만 하고 변경하지 않는다.
--   * CREATE TABLE IF NOT EXISTS 이므로 여러 번 실행해도 안전하다.
--
-- 시간 컬럼 정책 (중요):
--   created_at / updated_at 에는 DEFAULT 도 ON UPDATE CURRENT_TIMESTAMP 도
--   두지 않는다. 이 두 값은 pending Lease 만료 판정에 직접 쓰이므로, DB 서버
--   시각과 애플리케이션 시각을 섞으면 판정이 어긋난다. 반드시 주입 가능한
--   JavaScript Clock 이 계산한 값을 INSERT/UPDATE 마다 명시적으로 bind 한다
--   (agent/repositories/shopifyCartRepository.js 참고).
--
-- 금액 컬럼 정책:
--   estimated_total_amount 는 DECIMAL 이 아니라 VARCHAR(64) 다. Shopify 가
--   반환한 Decimal 문자열 원문을 그대로 보존해야 하며(드라이버 왕복에서 표현이
--   바뀌면 안 됨), 애플리케이션에서도 Number/parseFloat 로 변환하지 않는다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shopify_cart_requests (
    id CHAR(36) PRIMARY KEY,
    user_id INT NOT NULL,
    session_id CHAR(36) NOT NULL,

    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    proposal_hash CHAR(64) NOT NULL,
    shopify_config_fingerprint CHAR(64) NOT NULL,
    selected_items_json JSON NOT NULL,

    status ENUM(
      'pending',
      'succeeded',
      'failed',
      'outcome_unknown'
    ) NOT NULL DEFAULT 'pending',

    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,

    shopify_cart_id VARCHAR(255) NULL,
    checkout_url TEXT NULL,

    estimated_total_amount VARCHAR(64) NULL,
    estimated_total_currency_code VARCHAR(16) NULL,
    estimated_total_is_estimated BOOLEAN NULL,

    warning_codes_json JSON NULL,
    normalized_error_code VARCHAR(80) NULL,
    normalized_http_status SMALLINT NULL,
    safe_error_details_json JSON NULL,

    external_call_started_at TIMESTAMP(6) NULL,
    completed_at TIMESTAMP(6) NULL,

    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,

    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE,

    FOREIGN KEY (session_id)
      REFERENCES agent_sessions(id)
      ON DELETE CASCADE,

    UNIQUE KEY uq_shopify_cart_idempotency (
      user_id,
      idempotency_key_hash
    ),

    INDEX idx_shopify_cart_session (session_id),
    INDEX idx_shopify_cart_status (status),
    INDEX idx_shopify_cart_pending (
      status,
      external_call_started_at,
      created_at
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
