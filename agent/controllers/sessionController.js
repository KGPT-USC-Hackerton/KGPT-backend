const crypto = require('crypto');

const coreReadRepository = require('../repositories/coreReadRepository');
const agentRepository = require('../repositories/agentRepository');
const { agentError } = require('../shared/agentResponse');
const {
  decideReadiness,
  buildSurveyAnswersOrError,
  buildContextSnapshot,
  computeContextHash,
  MODEL_NAME_PLACEHOLDER,
  PROMPT_VERSION_PLACEHOLDER,
} = require('../services/contextSnapshotService');

// buildSurveyAnswersOrError()의 실패 code를 HTTP 상태로 매핑한다. DUPLICATE/
// MAPPING_UNSUPPORTED는 응답 데이터 자체의 문제(422), CODEBOOK_MISMATCH는
// Seed/코드북 정합성이 깨진 배포 문제로 본다(500).
const SURVEY_VALIDATION_ERROR_STATUS_MAP = {
  AGENT_SURVEY_RESPONSE_DUPLICATE: 422,
  AGENT_SURVEY_MAPPING_UNSUPPORTED: 422,
  AGENT_SURVEY_CODEBOOK_MISMATCH: 500,
};

function respondReady(res, statusCode, session) {
  return res.status(statusCode).json({
    success: true,
    data: {
      status: 'ready',
      session_id: session.id,
      history_id: session.history_id,
      survey_session_id: session.survey_session_id,
      context_hash: session.context_hash,
      context_snapshot: session.context_snapshot,
      model_name: session.model_name,
      prompt_version: session.prompt_version,
    },
  });
}

async function createSession(req, res) {
  try {
    const authUserId = req.agentUser.id;
    const { history_id: historyId, survey_session_id: surveySessionId } = req.body || {};
    const idempotencyKey = req.headers['idempotency-key'];

    if (!historyId || typeof historyId !== 'string') {
      return agentError(res, 400, 'VALIDATION_ERROR', 'history_id는 필수입니다.');
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return agentError(res, 400, 'VALIDATION_ERROR', 'Idempotency-Key 헤더는 필수입니다.');
    }

    const existing = await agentRepository.findByIdempotencyKey(authUserId, idempotencyKey);
    if (existing) {
      const sameParams =
        existing.history_id === historyId && (existing.survey_session_id || null) === (surveySessionId || null);
      if (!sameParams) {
        return agentError(res, 409, 'IDEMPOTENCY_KEY_CONFLICT', '동일한 Idempotency-Key가 다른 요청 파라미터로 이미 사용되었습니다.');
      }
      return respondReady(res, 200, existing);
    }

    const imageRows = await coreReadRepository.findImagesByHistoryId(historyId);
    const imageAnalysisRows = await coreReadRepository.findImageAnalysisByHistoryId(authUserId, historyId);
    const surveyResponseRows = surveySessionId
      ? await coreReadRepository.findSurveyResponsesBySessionId(authUserId, surveySessionId)
      : [];

    const readiness = decideReadiness({
      authUserId,
      imageRows,
      imageAnalysisRows,
      requestedSurveySessionId: surveySessionId || null,
      surveyResponseRows,
    });

    if (readiness.status === 'history_not_found') {
      return agentError(res, 404, 'HISTORY_NOT_FOUND', '해당 history_id를 찾을 수 없습니다.');
    }
    if (readiness.status === 'survey_session_not_found') {
      return agentError(res, 404, 'SURVEY_SESSION_NOT_FOUND', '해당 survey_session_id를 찾을 수 없습니다.');
    }
    if (readiness.status === 'waiting_for_analysis') {
      return res.status(202).json({
        success: true,
        data: { status: 'waiting_for_analysis', retry_after_seconds: 3 },
      });
    }
    if (readiness.status === 'analysis_failed') {
      return agentError(res, 422, 'ANALYSIS_FAILED', '사진 분석이 실패했습니다.', { retryable: true });
    }

    // Codebook 기준으로 개별 설문 응답을 검증·매핑한다(Snapshot을 만들기 전에
    // 반드시 통과해야 함 — 부분 Snapshot을 만들지 않는다).
    const surveyInfo = buildSurveyAnswersOrError(surveyResponseRows);
    if (!surveyInfo.ok) {
      const status = SURVEY_VALIDATION_ERROR_STATUS_MAP[surveyInfo.code] || 500;
      return agentError(res, status, surveyInfo.code, '설문 응답을 검증하는 중 문제가 발생했습니다.', {
        retryable: false,
      });
    }

    const contextSnapshot = buildContextSnapshot({
      historyId,
      surveySessionId: surveySessionId || null,
      imagesByPosition: readiness.imagesByPosition,
      surveyInfo,
    });
    const contextHash = computeContextHash(contextSnapshot);

    const session = {
      id: crypto.randomUUID(),
      userId: authUserId,
      historyId,
      surveySessionId: surveySessionId || null,
      contextSnapshot,
      contextHash,
      modelName: MODEL_NAME_PLACEHOLDER,
      promptVersion: PROMPT_VERSION_PLACEHOLDER,
      idempotencyKey,
    };

    try {
      await agentRepository.insertReadySession(session);
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        const raced = await agentRepository.findByIdempotencyKey(authUserId, idempotencyKey);
        if (raced) {
          return respondReady(res, 200, raced);
        }
      }
      throw err;
    }

    return respondReady(res, 200, {
      id: session.id,
      history_id: session.historyId,
      survey_session_id: session.surveySessionId,
      context_hash: session.contextHash,
      context_snapshot: session.contextSnapshot,
      model_name: session.modelName,
      prompt_version: session.promptVersion,
    });
  } catch (error) {
    console.error('Agent createSession Error:', error.message);
    return agentError(res, 500, 'AGENT_INTERNAL_ERROR', 'Agent 세션 생성 중 오류가 발생했습니다.');
  }
}

module.exports = { createSession };
