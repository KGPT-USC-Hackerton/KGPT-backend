const crypto = require('crypto');
const { agentError } = require('../agent/shared/agentResponse');

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// 해커톤 전용 고정 데모 토큰 검증. Body/Query/Path의 user_id는 절대 읽지 않는다.
function agentDemoAuth(req, res, next) {
  const authMode = process.env.AGENT_AUTH_MODE;
  const demoToken = process.env.AGENT_DEMO_TOKEN;
  const demoUserId = process.env.AGENT_DEMO_USER_ID;

  if (authMode !== 'demo-token' || !demoToken || !demoUserId) {
    return agentError(res, 500, 'AGENT_AUTH_MISCONFIGURED', 'Agent 인증 설정이 올바르지 않습니다.');
  }

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return agentError(res, 401, 'AGENT_AUTH_MISSING_TOKEN', '인증 토큰이 필요합니다.');
  }

  if (!safeEqual(token, demoToken)) {
    return agentError(res, 401, 'AGENT_AUTH_INVALID_TOKEN', '유효하지 않은 인증 토큰입니다.');
  }

  req.agentUser = { id: Number(demoUserId) };
  next();
}

module.exports = agentDemoAuth;
