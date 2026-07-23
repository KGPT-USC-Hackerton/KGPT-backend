-- ============================================================================
-- BloomDent — image_analysis 스키마 정합성 보정 (비파괴적 Migration)
-- ----------------------------------------------------------------------------
-- 배경:
--   database/schema.sql(= setup-database.js가 매번 재생성하는 상태)의
--   image_analysis 정의는 image_id(dental_images FK) 기반의 옛 구조다.
--   그러나 실제 실행 코드(routes/images.js:656-724, routes/ai.js)는
--   image_id를 전혀 채우지 않고 대신 user_id/history_id/image_type/uploaded_at/
--   analysis_status/llm_summary 컬럼을 읽고 쓴다. 즉 새로 `npm run setup-db`를
--   실행한 모든 환경에서 사진 분석 저장(INSERT)이 image_id NOT NULL 위반으로
--   항상 실패하는 기존(= Agent 이전부터 존재하던) 스키마 드리프트다.
--
--   이 migration은 그 드리프트를 실제 코드가 이미 기대하는 상태로 맞출 뿐,
--   Core 라우트의 비즈니스 로직이나 기존 데이터는 전혀 바꾸지 않는다.
--
-- ⚠️ 이것은 Agent가 Core 스키마를 새로 설계하거나 확장하는 작업이 아니다.
--   Agent 기능을 위한 컬럼은 단 하나도 여기 없다(user_id/history_id/image_type/
--   uploaded_at/analysis_status/llm_summary는 전부 이미 존재하던 Core 코드
--   routes/images.js, routes/ai.js가 필요로 하던 컬럼이다). 이 migration의 유일한
--   목적은 database/schema.sql(DDL)과 실제 실행 코드 사이의 오래된 스키마 드리프트를
--   원래 Core 코드가 기대하던 상태로 복구하는 "호환성(compatibility) Migration"이다.
--
-- 안전 원칙 (CLAUDE.md "Database safety"):
--   * DROP TABLE / TRUNCATE / DELETE 없음. 기존 데이터는 그대로 보존된다.
--   * 컬럼은 전부 nullable 로만 추가한다(NOT NULL 강제 없음).
--   * image_id는 삭제하지 않고 NOT NULL 제약만 완화한다(신규 INSERT가
--     채우지 않으므로). 기존에 image_id가 채워진 행의 값은 그대로 남는다.
--   * 모든 문장은 IF NOT EXISTS(MariaDB 확장 문법)를 사용해 여러 번 실행해도,
--     혹은 이미 수동으로 동일하게 맞춰둔 DB에서 다시 실행해도 안전하다.
--   * database/run-migration.js의 안전 가드는 image_analysis에 한해, 바로 아래
--     10개 문장과 문자 그대로 일치하는(컬럼명·타입·인덱스명까지 정확히 같은)
--     경우만 허용하는 하드코딩된 allowlist를 쓴다("아무 nullable 컬럼/인덱스
--     추가"를 허용하는 게 아니다 — IMAGE_ANALYSIS_ALLOWED_ADD_COLUMN_STATEMENTS/
--     IMAGE_ANALYSIS_ALLOWED_ADD_INDEX_STATEMENTS 참고). 그 외 모든 Core 테이블
--     ALTER, 그리고 image_analysis라도 이 목록 밖의 문장은 전부 차단된다.
--   * 적용 후 database/run-migration.js가 information_schema로 아래 컬럼 8개
--     (image_id 포함, nullable 여부까지) 와 인덱스 2개가 실제로 생성됐는지 자동
--     검증한다(verifyImageAnalysisSchema).
-- ============================================================================

ALTER TABLE image_analysis MODIFY COLUMN image_id INT NULL;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS user_id INT NULL AFTER image_id;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS history_id VARCHAR(100) NULL AFTER user_id;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS cloudinary_url TEXT NULL AFTER history_id;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS image_type VARCHAR(50) NULL AFTER cloudinary_url;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP AFTER image_type;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS analysis_status ENUM('pending','processing','completed','failed') NULL DEFAULT 'pending' AFTER uploaded_at;

ALTER TABLE image_analysis ADD COLUMN IF NOT EXISTS llm_summary TEXT NULL;

ALTER TABLE image_analysis ADD INDEX IF NOT EXISTS idx_image_analysis_history (history_id, image_type);

ALTER TABLE image_analysis ADD INDEX IF NOT EXISTS idx_image_analysis_user (user_id, history_id);
