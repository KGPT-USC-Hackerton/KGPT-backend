// 객체 키를 재귀적으로 정렬해 삽입 순서에 무관한 canonical 표현을 만드는
// 순수 함수. contextSnapshotService.js와 agent/catalog/surveyCodebook.js가
// 공통으로 사용하며(순환 require를 피하기 위해 별도 모듈로 분리됨), 다른
// 의존성이 없다.
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const result = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

module.exports = { canonicalize, canonicalStringify };
