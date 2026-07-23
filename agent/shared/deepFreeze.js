// Object.freeze는 shallow freeze라 중첩 객체/배열은 그대로 변경 가능하다.
// 이 헬퍼는 값 그래프를 재귀적으로 순회하며 모든 객체/배열을 freeze해
// 반환값 전체의 불변성을 실제로 보장한다.
function deepFreeze(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

module.exports = { deepFreeze };
