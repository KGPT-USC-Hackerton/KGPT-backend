const { validate: isUuid } = require('uuid');
const { agentError } = require('../shared/agentResponse');
const dentalPassService = require('../services/dentalPassService');

const CREATE_ALLOWED_KEYS = ['consent', 'expires_in_hours'];
const MIN_EXPIRES_IN_HOURS = 1;
const MAX_EXPIRES_IN_HOURS = 168;
const DEFAULT_EXPIRES_IN_HOURS = 24;

// DentalPassError.code 를 HTTP 상태로 매핑한다(messageController.js 와 동일한 패턴).
const CREATE_ERROR_STATUS_MAP = {
  AGENT_SESSION_NOT_FOUND: 404,
  AGENT_SESSION_NOT_READY: 409,
  AGENT_SESSION_EXPIRED: 410,
  AGENT_CONTEXT_INTEGRITY_ERROR: 500,
  ACTIVE_DENTAL_PASS_LIMIT_REACHED: 409,
  DENTAL_PASS_CREATE_FAILED: 500,
};
const REVOKE_ERROR_STATUS_MAP = {
  DENTAL_PASS_NOT_FOUND: 404,
  DENTAL_PASS_REVOKE_FAILED: 500,
};
const PUBLIC_ERROR_STATUS_MAP = {
  DENTAL_PASS_NOT_FOUND: 404,
  DENTAL_PASS_REVOKED: 410,
  DENTAL_PASS_EXPIRED: 410,
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createDentalPass(req, res) {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId)) {
      return agentError(res, 400, 'VALIDATION_ERROR', 'sessionId는 유효한 UUID 형식이어야 합니다.');
    }

    const body = req.body;
    if (!isPlainObject(body)) {
      return agentError(res, 400, 'VALIDATION_ERROR', '요청 본문은 object여야 합니다.');
    }
    for (const key of Object.keys(body)) {
      if (!CREATE_ALLOWED_KEYS.includes(key)) {
        return agentError(res, 400, 'UNKNOWN_FIELD', `허용되지 않은 필드입니다: ${key}`);
      }
    }

    if (body.consent !== true) {
      return agentError(res, 400, 'DENTAL_PASS_CONSENT_REQUIRED', 'Dental Pass 생성에는 명시적 승인(consent: true)이 필요합니다.');
    }

    let expiresInHours = DEFAULT_EXPIRES_IN_HOURS;
    if (body.expires_in_hours !== undefined) {
      if (
        !Number.isInteger(body.expires_in_hours) ||
        body.expires_in_hours < MIN_EXPIRES_IN_HOURS ||
        body.expires_in_hours > MAX_EXPIRES_IN_HOURS
      ) {
        return agentError(
          res,
          400,
          'VALIDATION_ERROR',
          `expires_in_hours는 ${MIN_EXPIRES_IN_HOURS}~${MAX_EXPIRES_IN_HOURS} 사이의 정수여야 합니다.`
        );
      }
      expiresInHours = body.expires_in_hours;
    }

    const userId = req.agentUser.id;
    const result = await dentalPassService.createDentalPass({ sessionId, userId, expiresInHours });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = CREATE_ERROR_STATUS_MAP[error.code];
    if (status) {
      return agentError(res, status, error.code, error.message);
    }
    console.error('Agent createDentalPass Error:', error.message);
    return agentError(res, 500, 'DENTAL_PASS_CREATE_FAILED', 'Dental Pass 생성 중 오류가 발생했습니다.');
  }
}

async function revokeDentalPass(req, res) {
  try {
    const { passId } = req.params;
    if (!isUuid(passId)) {
      return agentError(res, 400, 'VALIDATION_ERROR', 'passId는 유효한 UUID 형식이어야 합니다.');
    }

    const userId = req.agentUser.id;
    const result = await dentalPassService.revokeDentalPass({ passId, userId });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = REVOKE_ERROR_STATUS_MAP[error.code];
    if (status) {
      return agentError(res, status, error.code, error.message);
    }
    console.error('Agent revokeDentalPass Error:', error.message);
    return agentError(res, 500, 'DENTAL_PASS_REVOKE_FAILED', 'Dental Pass 철회 중 오류가 발생했습니다.');
  }
}

// 공개 조회 — Demo Auth 없음. req.agentUser 를 참조하지 않는다.
async function getPublicDentalPass(req, res) {
  try {
    const { shareToken } = req.params;
    const result = await dentalPassService.getPublicDentalPass({ shareToken });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = PUBLIC_ERROR_STATUS_MAP[error.code];
    if (status) {
      return agentError(res, status, error.code, error.message);
    }
    console.error('Public getDentalPass Error:', error.message);
    return agentError(res, 500, 'DENTAL_PASS_INTERNAL_ERROR', 'Dental Pass 조회 중 오류가 발생했습니다.');
  }
}

module.exports = { createDentalPass, revokeDentalPass, getPublicDentalPass };
