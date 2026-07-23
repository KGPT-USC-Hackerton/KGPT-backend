const { pool } = require('../../config/database');

// Core 테이블(dental_images, image_analysis, user_survey_responses)에 대한 읽기 전용 쿼리만 모은다.
// Agent는 Core 테이블에 절대 쓰지 않는다 (CLAUDE.md "Data rules").

async function findImagesByHistoryId(historyId) {
  const [rows] = await pool.query(
    `SELECT position, analysis_status, user_id
     FROM dental_images
     WHERE history_id = ? AND position IN ('upper', 'lower', 'front')`,
    [historyId]
  );
  return rows;
}

async function findImageAnalysisByHistoryId(userId, historyId) {
  const [rows] = await pool.query(
    `SELECT id, image_type, analyzed_at, occlusion_status, occlusion_comment, cavity_detected,
            cavity_locations, overall_score, recommendations, ai_confidence, llm_summary
     FROM image_analysis
     WHERE user_id = ? AND history_id = ?`,
    [userId, historyId]
  );
  return rows;
}

async function findSurveyResponsesBySessionId(userId, surveySessionId) {
  const [rows] = await pool.query(
    `SELECT question_number, option_number, category, score
     FROM user_survey_responses
     WHERE user_id = ? AND survey_session_id = ?`,
    [userId, surveySessionId]
  );
  return rows;
}

module.exports = {
  findImagesByHistoryId,
  findImageAnalysisByHistoryId,
  findSurveyResponsesBySessionId,
};
