const crypto = require('crypto');

// DB/Express 에 의존하지 않는 순수 함수만 담는다. Dental Pass Share Token은
// 원문을 절대 저장하지 않고 SHA-256 hash(64자 hex)만 저장한다.

const TOKEN_BYTE_LENGTH = 32; // 256-bit entropy
const TOKEN_FORMAT_PATTERN = /^[A-Za-z0-9_-]{43}$/; // base64url(32 bytes), padding 없음

function generateShareToken() {
  return crypto.randomBytes(TOKEN_BYTE_LENGTH).toString('base64url');
}

function hashShareToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function isValidTokenFormat(token) {
  return typeof token === 'string' && TOKEN_FORMAT_PATTERN.test(token);
}

module.exports = {
  TOKEN_BYTE_LENGTH,
  TOKEN_FORMAT_PATTERN,
  generateShareToken,
  hashShareToken,
  isValidTokenFormat,
};
