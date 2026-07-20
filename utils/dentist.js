// utils/dentist.js
// dentists 테이블(NPI 기반 provider 데이터)을 치과(clinic)로 매핑하기 위한 공용 SQL 조각.
//
// - 치과명(name): first_name + last_name 조합을 우선 사용하고,
//   비어 있으면(organization 유형 등) organization_name 으로 대체한다.
// - 주소(address): address_line1/2, city, state, postal_code 를 합쳐 한 줄로 구성한다.
//
// alias 인자로 테이블 별칭(예: 'd', 'dc')을 넘기면 해당 별칭 기준 컬럼 참조식을 만든다.
// 별칭 없이 단일 테이블 조회에서 쓰려면 alias 를 '' 로 넘긴다.

const col = (alias, name) => (alias ? `${alias}.${name}` : name);

// 치과명: NULLIF(TRIM(...)) 로 공백만 남는 경우도 NULL 취급 후 organization_name 으로 폴백
function nameExpr(alias = '') {
  const first = col(alias, 'first_name');
  const last = col(alias, 'last_name');
  const org = col(alias, 'organization_name');
  return `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', ${first}, ${last})), ''), ${org})`;
}

// 주소: 도로명 라인(line1 + line2) → city → state → postal_code 순으로 ', ' 결합
function addressExpr(alias = '') {
  const line1 = col(alias, 'address_line1');
  const line2 = col(alias, 'address_line2');
  const city = col(alias, 'city');
  const state = col(alias, 'state');
  const postal = col(alias, 'postal_code');
  return `NULLIF(TRIM(CONCAT_WS(', ', NULLIF(TRIM(CONCAT_WS(' ', ${line1}, ${line2})), ''), ${city}, ${state}, ${postal})), '')`;
}

module.exports = { nameExpr, addressExpr };
