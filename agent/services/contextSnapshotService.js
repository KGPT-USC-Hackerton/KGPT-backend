const crypto = require('crypto');
const { canonicalStringify } = require('../shared/canonicalJson');
const {
  CODEBOOK_VERSION,
  CODEBOOK_CHECKSUM,
  validateAndMapResponses,
  filterAllowlistedAnswers,
} = require('../catalog/surveyCodebook');

const POSITIONS = ['upper', 'lower', 'front'];
const PENDING_STATUSES = ['pending', 'processing'];

const MODEL_NAME_PLACEHOLDER = 'template-only';
const PROMPT_VERSION_PLACEHOLDER = 'v0';

const SNAPSHOT_SCHEMA_VERSION = 'agent-context-v2';

// question_code=YES(또는 POOR 계열) 응답을 임상 follow-up 권고로 변환하는
// 결정론적 규칙. 서버가 계산하며 Gemini는 관여하지 않는다. 순서는 고정
// (규칙 선언 순서)이라 입력 순서와 무관하게 항상 동일한 배열이 나온다.
const CLINICAL_FOLLOWUP_RULES = [
  { question_code: 'CHEWING_DISCOMFORT_LAST_3_MONTHS', matches: (a) => a === 'YES', reason_code: 'RECENT_CHEWING_DISCOMFORT' },
  { question_code: 'TOOTH_PAIN_LAST_3_MONTHS', matches: (a) => a === 'YES', reason_code: 'RECENT_TOOTH_PAIN' },
  { question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', matches: (a) => a === 'YES', reason_code: 'RECENT_GUM_PAIN_OR_BLEEDING' },
  { question_code: 'SELF_RATED_ORAL_HEALTH', matches: (a) => a === 'POOR' || a === 'VERY_POOR', reason_code: 'SELF_RATED_ORAL_HEALTH_POOR' },
];

const DIAGNOSIS_DISCLAIMER =
  '이 내용은 AI가 사진과 설문을 바탕으로 정리한 참고 정보이며 확정 진단이 아닙니다. 정확한 진단과 치료 계획은 반드시 치과에서 임상 검사를 받아 확인해야 합니다.';

// image_analysis에 같은 position(image_type)의 중복 행이 있을 때
// (analyzed_at, id) 오름차순으로 정렬한 뒤 마지막 값으로 덮어써 결정론적으로 최신 1건만 남긴다.
function pickLatestPerPosition(imageAnalysisRows) {
  const sorted = [...(imageAnalysisRows || [])].sort((a, b) => {
    const aTime = new Date(a.analyzed_at).getTime();
    const bTime = new Date(b.analyzed_at).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return a.id - b.id;
  });

  const byPosition = new Map();
  for (const row of sorted) {
    byPosition.set(row.image_type, row);
  }
  return byPosition;
}

// 3-position dental_images 조회 결과 + image_analysis 조회 결과를 바탕으로
// 이번 요청이 어떤 상태(ready/waiting/failed/not_found)인지 판정한다. DB 접근 없는 순수 함수.
function decideReadiness({
  authUserId,
  imageRows,
  imageAnalysisRows,
  requestedSurveySessionId,
  surveyResponseRows,
}) {
  if (!imageRows || imageRows.length === 0) {
    return { status: 'history_not_found' };
  }

  const ownedByOther = imageRows.some((row) => Number(row.user_id) !== Number(authUserId));
  if (ownedByOther) {
    // 존재하지만 다른 사용자 소유인 경우도 미존재와 동일하게 응답해 존재 여부를 숨긴다.
    return { status: 'history_not_found' };
  }

  const byPosition = new Map(imageRows.map((row) => [row.position, row]));

  const missingPosition = POSITIONS.some((position) => !byPosition.has(position));
  if (missingPosition) {
    return { status: 'waiting_for_analysis' };
  }

  const hasPending = POSITIONS.some((position) =>
    PENDING_STATUSES.includes(byPosition.get(position).analysis_status)
  );
  if (hasPending) {
    return { status: 'waiting_for_analysis' };
  }

  const hasFailed = POSITIONS.some((position) => byPosition.get(position).analysis_status === 'failed');
  if (hasFailed) {
    return { status: 'analysis_failed' };
  }

  const latestAnalysisByPosition = pickLatestPerPosition(imageAnalysisRows);
  const missingAnalysis = POSITIONS.some((position) => !latestAnalysisByPosition.has(position));
  if (missingAnalysis) {
    return { status: 'waiting_for_analysis' };
  }

  if (requestedSurveySessionId && (!surveyResponseRows || surveyResponseRows.length === 0)) {
    return { status: 'survey_session_not_found' };
  }

  return { status: 'ready', imagesByPosition: latestAnalysisByPosition };
}

function buildInitialMessage(images) {
  const flagged = images.filter(
    (image) => image.cavity_detected === true || (image.occlusion_status && image.occlusion_status !== 'normal')
  );

  if (flagged.length > 0) {
    return {
      text: `사진 분석 결과 추가 확인이 필요한 소견이 있어요. ${DIAGNOSIS_DISCLAIMER}`,
      evidence: flagged.map((image) => ({
        source_type: 'image_analysis',
        position: image.position,
        confidence: image.ai_confidence,
      })),
    };
  }

  return {
    text: `사진 분석 결과 특별한 소견은 발견되지 않았어요. 정기적인 검진은 계속 권장드립니다. ${DIAGNOSIS_DISCLAIMER}`,
    evidence: [],
  };
}

// question_code=YES/POOR 계열 응답으로부터 임상 follow-up reason_code
// 배열을 결정론적으로 계산한다(규칙 선언 순서 고정, 입력 순서 무관).
// DB/Express에 의존하지 않는 순수 함수.
function deriveClinicalFollowup(answers) {
  const byCode = new Map((answers || []).map((a) => [a.question_code, a.answer_code]));
  const reasonCodes = [];
  for (const rule of CLINICAL_FOLLOWUP_RULES) {
    const answerCode = byCode.get(rule.question_code);
    if (answerCode !== undefined && rule.matches(answerCode)) {
      reasonCodes.push(rule.reason_code);
    }
  }
  return reasonCodes;
}

/**
 * Core에서 읽은 원시 설문 응답 행을 Codebook으로 검증·매핑하고, Context
 * Snapshot v2에 들어갈 survey/needs_clinical_followup/followup_reason_codes를
 * 계산한다. DB를 다시 읽거나 쓰지 않는 순수 함수(surveyResponseRows만 입력).
 *
 * 반환: { ok: true, survey, needsClinicalFollowup, followupReasonCodes }
 *     | { ok: false, code: 'AGENT_SURVEY_RESPONSE_DUPLICATE' | 'AGENT_SURVEY_MAPPING_UNSUPPORTED' | 'AGENT_SURVEY_CODEBOOK_MISMATCH' }
 */
function buildSurveyAnswersOrError(surveyResponseRows) {
  if (!surveyResponseRows || surveyResponseRows.length === 0) {
    return { ok: true, survey: null, needsClinicalFollowup: false, followupReasonCodes: [] };
  }

  const mapped = validateAndMapResponses(surveyResponseRows);
  if (!mapped.ok) {
    return { ok: false, code: mapped.code };
  }

  const allowlistedAnswers = filterAllowlistedAnswers(mapped.answers);
  const followupReasonCodes = deriveClinicalFollowup(allowlistedAnswers);

  return {
    ok: true,
    survey: {
      codebook_version: CODEBOOK_VERSION,
      codebook_checksum: CODEBOOK_CHECKSUM,
      answers: allowlistedAnswers,
    },
    needsClinicalFollowup: followupReasonCodes.length > 0,
    followupReasonCodes,
  };
}

function buildContextSnapshot({
  historyId,
  surveySessionId,
  imagesByPosition,
  surveyInfo,
  generatedAt,
}) {
  const images = POSITIONS.map((position) => {
    const row = imagesByPosition.get(position);
    return {
      position,
      occlusion_status: row.occlusion_status,
      cavity_detected: !!row.cavity_detected,
      cavity_locations: row.cavity_locations ?? null,
      overall_score: row.overall_score,
      recommendations: row.recommendations,
      ai_confidence: row.ai_confidence,
      llm_summary: row.llm_summary ?? null,
    };
  });

  const resolvedSurveyInfo = surveyInfo || { survey: null, needsClinicalFollowup: false, followupReasonCodes: [] };

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    history_id: historyId,
    survey_session_id: surveySessionId || null,
    generated_at: generatedAt || new Date().toISOString(),
    images,
    survey: resolvedSurveyInfo.survey,
    needs_clinical_followup: resolvedSurveyInfo.needsClinicalFollowup,
    followup_reason_codes: resolvedSurveyInfo.followupReasonCodes,
    initial_message: buildInitialMessage(images),
  };
}

// generated_at을 제외한 근거 데이터만 해시해 동일한 근거 데이터는 생성 시각과 무관하게 동일 해시가 나오게 한다.
function computeContextHash(contextSnapshot) {
  const { generated_at, ...hashInput } = contextSnapshot;
  return crypto.createHash('sha256').update(canonicalStringify(hashInput)).digest('hex');
}

module.exports = {
  POSITIONS,
  MODEL_NAME_PLACEHOLDER,
  PROMPT_VERSION_PLACEHOLDER,
  SNAPSHOT_SCHEMA_VERSION,
  pickLatestPerPosition,
  decideReadiness,
  buildInitialMessage,
  buildSurveyAnswersOrError,
  deriveClinicalFollowup,
  buildContextSnapshot,
  canonicalStringify,
  computeContextHash,
};
