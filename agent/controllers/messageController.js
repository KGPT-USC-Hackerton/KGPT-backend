const { validate: isUuid } = require('uuid');
const { agentError } = require('../shared/agentResponse');
const agentMessageService = require('../services/agentMessageService');

const ALLOWED_BODY_KEYS = ['message', 'client_message_id'];
const MESSAGE_MIN_LENGTH = 1;
const MESSAGE_MAX_LENGTH = 2000;
const CLIENT_MESSAGE_ID_MAX_LENGTH = 100;

// AgentMessageError / AgentChatConflictError / AgentChatSaveError 는 전부 .code
// 를 갖고 있어 여기서 통일된 테이블로 HTTP 상태를 매핑한다.
const ERROR_STATUS_MAP = {
  VALIDATION_ERROR: 400,
  UNKNOWN_FIELD: 400,
  AGENT_SESSION_NOT_FOUND: 404,
  AGENT_SESSION_NOT_READY: 409,
  AGENT_SESSION_EXPIRED: 410,
  AGENT_CONTEXT_INTEGRITY_ERROR: 500,
  CLIENT_MESSAGE_ID_CONFLICT: 409,
  AGENT_MESSAGE_SAVE_FAILED: 500,
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createMessage(req, res) {
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
      if (!ALLOWED_BODY_KEYS.includes(key)) {
        return agentError(res, 400, 'UNKNOWN_FIELD', `허용되지 않은 필드입니다: ${key}`);
      }
    }

    if (typeof body.message !== 'string') {
      return agentError(res, 400, 'VALIDATION_ERROR', 'message는 필수 문자열입니다.');
    }
    const trimmedMessage = body.message.trim();
    if (trimmedMessage.length < MESSAGE_MIN_LENGTH || trimmedMessage.length > MESSAGE_MAX_LENGTH) {
      return agentError(res, 400, 'VALIDATION_ERROR', `message는 trim 후 ${MESSAGE_MIN_LENGTH}~${MESSAGE_MAX_LENGTH}자여야 합니다.`);
    }

    let clientMessageId = null;
    if (body.client_message_id !== undefined) {
      if (
        typeof body.client_message_id !== 'string' ||
        body.client_message_id.length < 1 ||
        body.client_message_id.length > CLIENT_MESSAGE_ID_MAX_LENGTH
      ) {
        return agentError(
          res,
          400,
          'VALIDATION_ERROR',
          `client_message_id는 1~${CLIENT_MESSAGE_ID_MAX_LENGTH}자 문자열이어야 합니다.`
        );
      }
      clientMessageId = body.client_message_id;
    }

    const userId = req.agentUser.id;

    const result = await agentMessageService.processMessage({
      sessionId,
      userId,
      message: body.message,
      clientMessageId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = ERROR_STATUS_MAP[error.code];
    if (status) {
      return agentError(res, status, error.code, error.message);
    }
    console.error('Agent createMessage Error:', error.message);
    return agentError(res, 500, 'AGENT_INTERNAL_ERROR', '메시지 처리 중 오류가 발생했습니다.');
  }
}

module.exports = { createMessage };
