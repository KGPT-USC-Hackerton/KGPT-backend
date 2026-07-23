// express.json()이 malformed JSON body를 만나면 body-parser가
// { type: 'entity.parse.failed', status: 400, message: <원본 SyntaxError 메시지>,
//   body: <원문 body 문자열> } 형태의 에러로 next(err)를 호출한다.
// 이 미들웨어는 그 에러만 골라 안전한 400 응답으로 정규화한다 — 원본
// error.message/stack/요청 body는 응답에 절대 포함하지 않는다.
function isJsonParseError(err) {
  if (!err) return false;
  if (err.type === 'entity.parse.failed') return true;
  return err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400) && 'body' in err;
}

function jsonParseErrorHandler(err, req, res, next) {
  if (!isJsonParseError(err)) {
    return next(err);
  }
  return res.status(400).json({
    success: false,
    error_code: 'VALIDATION_ERROR',
    message: '올바른 JSON 요청 본문이 필요합니다.',
  });
}

module.exports = jsonParseErrorHandler;
module.exports.isJsonParseError = isJsonParseError;
