// 6A-1 Product Recommendation Service 전용 최소 카탈로그. product_key,
// 표시용 메타데이터, 추천 수량 한도, 허용된 reason_code만 담는다.
//
// Shopify merchandise_id/SKU/실 재고 연동은 6A-2(Shopify Cart 백엔드) 범위이며
// 이 파일에는 포함하지 않는다 — 이 서비스는 Shopify를 전혀 호출하지 않는다.
const { deepFreeze } = require('../shared/deepFreeze');

const CATALOG_VERSION = 'bloomdent-hygiene-catalog-2026-07';

const PRODUCTS = {
  TOOTHBRUSH_ULTRA_SOFT: {
    display_name: '초미세모 칫솔',
    generic_description: '잇몸에 자극이 적은 초미세모 칫솔로, 부드러운 칫솔질을 돕는 일반 위생 보조 상품입니다.',
    default_quantity: 1,
    max_quantity: 3,
    allowed_reason_codes: ['GENTLE_BRUSHING_SUPPORT'],
  },
  TOOTHBRUSH_SOFT: {
    display_name: '부드러운 칫솔',
    generic_description: '일상적인 구강 위생 관리를 위한 일반 부드러운 칫솔입니다.',
    default_quantity: 1,
    max_quantity: 3,
    allowed_reason_codes: ['GENERAL_DAILY_HYGIENE'],
  },
  TOOTHPASTE_FLUORIDE: {
    display_name: '불소 치약',
    generic_description: '불소가 포함된 일반 위생 관리용 치약입니다.',
    default_quantity: 1,
    max_quantity: 3,
    allowed_reason_codes: ['FLUORIDE_HYGIENE_SUPPORT', 'CAVITY_PREVENTION_SUPPORT'],
  },
  TOOTHPASTE_SENSITIVE: {
    display_name: '시린이 치약',
    generic_description: '시림 완화를 돕는 일반 위생 관리용 치약입니다.',
    default_quantity: 1,
    max_quantity: 3,
    // V1 룰 엔진에서 도달 불가 — 시림 여부를 명시적으로 확인하는 후속 문항이
    // 도입되기 전까지 자동 추천하지 않는다(안전 규칙, 사용자 승인 항목).
    allowed_reason_codes: [],
  },
  FLOSS_TAPE: {
    display_name: '치실',
    generic_description: '치아 사이 관리를 시작하기 좋은 일반적인 치실입니다.',
    default_quantity: 1,
    max_quantity: 3,
    allowed_reason_codes: ['INTERDENTAL_CLEANING_SUPPORT'],
  },
  INTERDENTAL_STARTER: {
    display_name: '치간칫솔 스타터 세트',
    generic_description: '치간 공간 크기를 확인해가며 사용할 수 있는 여러 사이즈 구성 세트입니다.',
    default_quantity: 1,
    max_quantity: 3,
    // V1에서는 특정 사이즈를 자동 선택할 근거가 없어 자동 추천하지 않는다.
    allowed_reason_codes: [],
  },
  TONGUE_CLEANER: {
    display_name: '혀 클리너',
    generic_description: '일반적인 구강 위생 관리를 돕는 혀 클리너입니다.',
    default_quantity: 1,
    max_quantity: 3,
    // V1 문진표에는 매핑되는 근거 문항이 없어 자동 추천하지 않는다.
    allowed_reason_codes: [],
  },
};

deepFreeze(PRODUCTS);

module.exports = { CATALOG_VERSION, PRODUCTS };
