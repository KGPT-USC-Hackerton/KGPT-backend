-- ============================================================================
-- BloomDent Agentic Copilot — Agent 전용 테이블 (비파괴적 Migration)
-- ----------------------------------------------------------------------------
-- 설계 근거: docs/BloomDent_Agentic_Copilot_Architecture_Revised_Updated.md §6
--
-- 안전 원칙 (CLAUDE.md "Database safety"):
--   * 이 파일은 신규 Agent 테이블만 추가한다.
--   * DROP TABLE / TRUNCATE / 기존 Core 테이블 구조 변경(ALTER)을 포함하지 않는다.
--   * 모든 문장은 CREATE TABLE IF NOT EXISTS 기반이며 여러 번 실행해도 안전하다.
--   * 기존 Core 데이터(users, dental_images, image_analysis, survey/score 등)를
--     읽기만 하며, FK는 Core 테이블(users)을 "참조"할 뿐 변경하지 않는다.
-- ============================================================================

-- 1. Agent Session ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
    id CHAR(36) PRIMARY KEY,
    user_id INT NOT NULL,
    history_id VARCHAR(100) NOT NULL,
    survey_session_id VARCHAR(50) NULL,

    status ENUM(
        'initializing',
        'waiting_for_analysis',
        'ready',
        'running',
        'partial',
        'completed',
        'failed',
        'expired'
    ) NOT NULL DEFAULT 'initializing',

    context_snapshot JSON NULL,
    context_hash CHAR(64) NULL,
    rolling_summary MEDIUMTEXT NULL,

    model_name VARCHAR(100) NOT NULL,
    prompt_version VARCHAR(30) NOT NULL,
    session_version INT NOT NULL DEFAULT 1,
    idempotency_key VARCHAR(100) NOT NULL,

    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6)
        DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    UNIQUE KEY uq_agent_session_idempotency
        (user_id, idempotency_key),

    INDEX idx_agent_user_created
        (user_id, created_at),

    INDEX idx_agent_context_ref
        (user_id, history_id, survey_session_id)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COMMENT='Agent 세션 및 불변 Context Snapshot';


-- 2. Agent Chat History -------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_chat_history (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    session_id CHAR(36) NOT NULL,
    seq_no INT NOT NULL,

    role ENUM('user', 'model', 'system', 'tool') NOT NULL,
    message_type ENUM(
        'text',
        'tool_call',
        'tool_result',
        'action_proposal',
        'summary',
        'error'
    ) NOT NULL DEFAULT 'text',

    content_json JSON NOT NULL,
    token_count INT NULL,
    client_message_id VARCHAR(100) NULL,
    trace_id VARCHAR(64) NULL,

    created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),

    FOREIGN KEY (session_id)
        REFERENCES agent_sessions(id)
        ON DELETE CASCADE,

    UNIQUE KEY uq_agent_message_sequence
        (session_id, seq_no),

    UNIQUE KEY uq_agent_client_message
        (session_id, client_message_id),

    INDEX idx_agent_recent_messages
        (session_id, seq_no)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COMMENT='Agent 메시지, Tool Call, 요약 이력';


-- 3. Tool Execution Ledger ----------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tool_runs (
    id CHAR(36) PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    message_id BIGINT NULL,

    tool_name VARCHAR(80) NOT NULL,
    status ENUM(
        'queued',
        'running',
        'succeeded',
        'failed',
        'timed_out',
        'cancelled'
    ) NOT NULL,

    arguments_json JSON NOT NULL,
    result_json JSON NULL,

    idempotency_key VARCHAR(100) NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    latency_ms INT NULL,
    error_code VARCHAR(80) NULL,
    retryable BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
    completed_at TIMESTAMP(6) NULL,

    FOREIGN KEY (session_id)
        REFERENCES agent_sessions(id)
        ON DELETE CASCADE,

    FOREIGN KEY (message_id)
        REFERENCES agent_chat_history(id)
        ON DELETE SET NULL,

    UNIQUE KEY uq_agent_tool_idempotency
        (session_id, tool_name, idempotency_key),

    INDEX idx_agent_tool_status
        (session_id, status)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COMMENT='Agent Tool 실행·오류·지연 추적';


-- 4. Dental Pass --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dental_passes (
    id CHAR(36) PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    user_id INT NOT NULL,

    insurance_snapshot JSON NULL,
    chief_complaint TEXT NULL,
    findings_json JSON NOT NULL,
    candidate_cdt_codes JSON NULL,
    cost_estimate_json JSON NULL,

    disclaimer TEXT NOT NULL,

    share_token_hash CHAR(64) NOT NULL,
    status ENUM(
        'draft',
        'active',
        'revoked',
        'expired'
    ) NOT NULL DEFAULT 'draft',

    consent_at TIMESTAMP(6) NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    generated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
    last_accessed_at TIMESTAMP(6) NULL,
    access_count INT NOT NULL DEFAULT 0,

    FOREIGN KEY (session_id)
        REFERENCES agent_sessions(id)
        ON DELETE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    UNIQUE KEY uq_dental_pass_token
        (share_token_hash),

    INDEX idx_dental_pass_session
        (session_id),

    INDEX idx_dental_pass_expiry
        (status, expires_at)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COMMENT='만료·철회 가능한 VOB-ready Dental Pass';
