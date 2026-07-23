-- ============================================================================
-- BloomDent — 문진표 응답 무결성 제약 추가 (비파괴적 Migration)
-- ----------------------------------------------------------------------------
-- 배경: Agent는 팀 KGPT-backend 정본 문진표(database/seed_survey_questionnaire.sql,
--   Codebook 버전 oral-health-questionnaire-v1) 1~15번을 그대로 사용한다. 팀
--   문진표는 이미 6개 category ENUM과 임상 배점(score 0~5)을 사용하므로 Agent가
--   category ENUM에 새 값을 추가할 필요가 없다(팀 정본에 Agent 전용 category는
--   도입하지 않는다). 이 Migration은 Agent Codebook 매핑이 전제하는 "문항당 응답
--   1건" 무결성만 user_survey_responses에 추가한다.
--
-- 안전 원칙 (CLAUDE.md "Database safety"):
--   * DROP / TRUNCATE / DELETE 없음. 기존 데이터는 그대로 보존된다.
--   * UNIQUE INDEX 추가는 IF NOT EXISTS로 재실행 안전하게 하며, 적용 전
--     database/run-migration.js가 (user_id, survey_session_id, question_number)
--     중복 여부를 애플리케이션 레벨에서 먼저 조회해 하나라도 있으면 이 문장을
--     실행하지 않고 전체 migration을 중단한다(checkNoDuplicateSurveyResponses).
--     삭제·자동 병합은 하지 않는다. 팀 routes/survey.js의 제출 로직은 재제출 시
--     같은 (user_id, survey_session_id) 응답을 먼저 DELETE 후 재삽입하므로 이
--     UNIQUE 제약과 호환된다.
--   * 이 파일이 건드리는 제약은 정확히 이 UNIQUE INDEX 하나뿐이며, 그 외 Core
--     테이블/컬럼/라우트는 전혀 변경하지 않는다. category ENUM은 건드리지 않는다.
--   * database/run-migration.js의 안전 가드는 이 문장과 문자 그대로 일치하는
--     경우만 허용하는 하드코딩된 allowlist를 쓴다(그 외 모든 user_survey_responses
--     ALTER는 계속 차단됨).
-- ============================================================================

ALTER TABLE user_survey_responses
  ADD UNIQUE INDEX IF NOT EXISTS uq_user_survey_response_question
    (user_id, survey_session_id, question_number);
