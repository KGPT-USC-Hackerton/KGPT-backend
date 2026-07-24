// image_analysis.cavity_locations 를 항상 배열로 정규화한다.
//
// 드라이버가 돌려주는 타입이 환경에 따라 다르다:
//   - MariaDB LONGTEXT + JSON check 제약이면 mysql2 가 이미 파싱된 Array 로 돌려준다.
//     (이 경우 JSON.parse(value) 는 JSON.parse(String([])) === JSON.parse("") 가 되어
//      "Unexpected end of JSON input" 으로 매번 실패했다.)
//   - 순수 TEXT 로 저장된 경우 JSON 문자열
//   - 드라이버 설정에 따라 Buffer
//   - 값이 없으면 null / undefined / 빈 문자열
//
// 어떤 입력이 와도 예외를 밖으로 던지지 않고 배열을 돌려준다.
// 실패해도 원본 값 전체는 로그에 남기지 않는다(민감 정보 보호).
function parseCavityLocations(value) {
  if (value === null || value === undefined) return [];

  // 드라이버가 이미 파싱해 준 경우
  if (Array.isArray(value)) return value;

  let text = null;
  if (Buffer.isBuffer(value)) {
    text = value.toString('utf8');
  } else if (typeof value === 'string') {
    text = value;
  } else {
    // 배열이 아닌 객체 등 예상 밖 타입은 빈 배열로 처리한다.
    return [];
  }

  if (text.trim() === '') return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    // 원본 값은 남기지 않고 실패 사실만 남긴다.
    console.warn('cavity_locations 파싱 실패 - 빈 배열로 대체합니다.');
    return [];
  }
}

module.exports = { parseCavityLocations };
