// Dental Pass 생성/철회/공개조회 응답은 성공·실패 모두 캐시되면 안 되므로
// 라우트 핸들러 실행 전에 헤더를 세팅한다(에러로 일찍 return해도 항상 적용됨).
function noStoreCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

module.exports = noStoreCache;
