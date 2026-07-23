const crypto = require('crypto');

const defaultAgentRepository = require('../repositories/agentRepository');
const defaultDentalPassRepository = require('../repositories/dentalPassRepository');
const { computeContextHash } = require('./contextSnapshotService');
const { buildDentalPassPublicSnapshot, DENTAL_PASS_DISCLAIMER } = require('../shared/dentalPassPublicSnapshot');
const { generateShareToken, hashShareToken, isValidTokenFormat } = require('../shared/dentalPassToken');
const { ActiveDentalPassLimitError, DentalPassTokenCollisionError } = require('../repositories/dentalPassRepository');

const MAX_ACTIVE_DENTAL_PASSES = 3;
const MAX_TOKEN_GENERATION_ATTEMPTS = 5;

class DentalPassError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'DentalPassError';
    this.code = code;
    this.extra = extra || null;
  }
}

// ---------------------------------------------------------------------------
// Session 검증
// ---------------------------------------------------------------------------
// 참고: agent/services/agentMessageService.js 의 loadAndValidateSession 과 검증
// 항목이 거의 동일하다. 155개 기존 테스트가 통과 중인 Foundation 4 코드
// (agentMessageService.js)를 이번 단계에서 건드리지 않기 위해 의도적으로
// 별도 구현했다 — 추후 두 서비스가 공유할 공통 세션 가드 모듈로 통합할 후보다.
async function loadReadySessionForOwner(sessionRepository, sessionId, userId, now) {
  const session = await sessionRepository.findByIdAndUser(sessionId, userId);
  if (!session) {
    throw new DentalPassError('AGENT_SESSION_NOT_FOUND', '해당 세션을 찾을 수 없습니다.');
  }
  if (session.status !== 'ready') {
    throw new DentalPassError('AGENT_SESSION_NOT_READY', '세션이 ready 상태가 아닙니다.');
  }
  if (session.expires_at && new Date(session.expires_at).getTime() <= now().getTime()) {
    throw new DentalPassError('AGENT_SESSION_EXPIRED', '세션이 만료되었습니다.');
  }
  if (!session.context_snapshot || !session.context_hash) {
    throw new DentalPassError('AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot이 존재하지 않습니다.');
  }
  const recomputedHash = computeContextHash(session.context_snapshot);
  if (recomputedHash !== session.context_hash) {
    throw new DentalPassError('AGENT_CONTEXT_INTEGRITY_ERROR', 'Context Snapshot 무결성 검증에 실패했습니다.');
  }
  return session;
}

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------
async function createDentalPass({ sessionId, userId, expiresInHours }, deps = {}) {
  const sessionRepository = deps.sessionRepository || defaultAgentRepository;
  const dentalPassRepository = deps.dentalPassRepository || defaultDentalPassRepository;
  const now = deps.now || (() => new Date());
  const generateToken = deps.generateShareToken || generateShareToken;
  const hashToken = deps.hashShareToken || hashShareToken;
  const generateId = deps.generateId || (() => crypto.randomUUID());

  const session = await loadReadySessionForOwner(sessionRepository, sessionId, userId, now);

  const nowDate = now();
  const consentAt = nowDate;
  const expiresAt = new Date(nowDate.getTime() + expiresInHours * 60 * 60 * 1000);
  const findingsJson = buildDentalPassPublicSnapshot(session.context_snapshot);

  let lastError = null;
  for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
    const rawToken = generateToken();
    const shareTokenHash = hashToken(rawToken);
    const passId = generateId();

    try {
      await dentalPassRepository.insertActivePassWithLimit({
        id: passId,
        sessionId,
        userId,
        findingsJson,
        disclaimer: DENTAL_PASS_DISCLAIMER,
        shareTokenHash,
        consentAt,
        expiresAt,
        nowForLimitCheck: nowDate,
        maxActivePasses: MAX_ACTIVE_DENTAL_PASSES,
      });

      return {
        pass_id: passId,
        share_token: rawToken,
        share_path: `/api/dental-pass/${rawToken}`,
        expires_at: expiresAt.toISOString(),
        status: 'active',
      };
    } catch (error) {
      if (error instanceof ActiveDentalPassLimitError) {
        throw new DentalPassError('ACTIVE_DENTAL_PASS_LIMIT_REACHED', error.message);
      }
      if (error instanceof DentalPassTokenCollisionError) {
        lastError = error;
        continue; // 새 토큰으로 재시도
      }
      throw error;
    }
  }

  throw new DentalPassError(
    'DENTAL_PASS_CREATE_FAILED',
    'Share Token 생성에 반복적으로 실패했습니다.',
    lastError ? { cause: lastError.message } : null
  );
}

// ---------------------------------------------------------------------------
// 철회
// ---------------------------------------------------------------------------
async function revokeDentalPass({ passId, userId }, deps = {}) {
  const dentalPassRepository = deps.dentalPassRepository || defaultDentalPassRepository;

  const result = await dentalPassRepository.revokeOwnedPass(passId, userId);
  if (!result) {
    throw new DentalPassError('DENTAL_PASS_NOT_FOUND', '해당 Dental Pass를 찾을 수 없습니다.');
  }
  return { pass_id: result.id, status: result.status };
}

// ---------------------------------------------------------------------------
// 공개 조회
// ---------------------------------------------------------------------------
async function getPublicDentalPass({ shareToken }, deps = {}) {
  const dentalPassRepository = deps.dentalPassRepository || defaultDentalPassRepository;
  const now = deps.now || (() => new Date());
  const validateFormat = deps.isValidTokenFormat || isValidTokenFormat;
  const hashToken = deps.hashShareToken || hashShareToken;

  // 형식 검증은 DB 조회를 막기 위한 내부 방어이며, 응답 코드는 미존재와 동일하게 통일한다.
  if (!validateFormat(shareToken)) {
    throw new DentalPassError('DENTAL_PASS_NOT_FOUND', '해당 Dental Pass를 찾을 수 없습니다.');
  }

  const tokenHash = hashToken(shareToken);
  const pass = await dentalPassRepository.findByTokenHash(tokenHash);

  if (!pass || pass.status === 'draft') {
    throw new DentalPassError('DENTAL_PASS_NOT_FOUND', '해당 Dental Pass를 찾을 수 없습니다.');
  }
  if (pass.status === 'revoked') {
    throw new DentalPassError('DENTAL_PASS_REVOKED', '철회된 Dental Pass입니다.');
  }

  const expiresAtMs = new Date(pass.expires_at).getTime();
  if (pass.status === 'expired' || expiresAtMs <= now().getTime()) {
    throw new DentalPassError('DENTAL_PASS_EXPIRED', '만료된 Dental Pass입니다.');
  }

  return {
    status: 'active',
    expires_at: new Date(pass.expires_at).toISOString(),
    summary: pass.findings_json,
  };
}

module.exports = {
  createDentalPass,
  revokeDentalPass,
  getPublicDentalPass,
  DentalPassError,
  MAX_ACTIVE_DENTAL_PASSES,
  MAX_TOKEN_GENERATION_ATTEMPTS,
  // 테스트 노출
  loadReadySessionForOwner,
};
