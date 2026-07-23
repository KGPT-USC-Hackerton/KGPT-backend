const crypto = require('crypto');
const { canonicalStringify } = require('../shared/canonicalJson');
const { CATALOG_VERSION, PRODUCTS } = require('../catalog/hygieneProductCatalog');

// 개별 응답 기반 Product Recommendation Service. Context Snapshot v2의
// survey.answers(Allowlist question_code)와 images[].cavity_detected만 입력으로
// 쓰는 로컬 결정론적 순수 함수다. Gemini/Shopify Adapter를 전혀 호출하지 않는다
// (이 파일에는 그런 import 자체가 없다). 팀 문진표의 총합 점수는 사용하지 않고
// 개별 응답만 해석한다.
//
// 안전 정책(팀 결정):
//   - Q5(치아 통증: 쑤심/욱신/아픔)는 상품 reason/evidence로 절대 쓰지 않는다.
//     TOOTHPASTE_SENSITIVE도 자동 추천하지 않는다. Q5 단독으로는 어떤 상품도
//     생성하지 않으며, 대신 비진단적 안전 안내(safety_notices)만 만든다.
//   - 병력 문항(Q2 당뇨, Q3 심혈관)은 애초에 Snapshot Allowlist에서 제외되어
//     여기 answers에 들어오지 않는다(상품 추천 근거로 쓰지 않음).
//   - Q15(흡연)은 위험 맥락일 뿐 상품 트리거로 쓰지 않는다.
const RULESET_VERSION = 'oral-health-recommendation-v1';

const DISCLAIMER =
  '이 추천은 일반적인 구강 위생 관리를 돕기 위한 참고 정보이며, 특정 질환의 치료나 완치를 보장하지 않습니다. ' +
  '통증이나 출혈 등 증상이 계속되면 반드시 치과에서 진료를 받으세요.';

// Q5(치아 통증) 안전 안내 문구. 특정 질환(충치/치수염/감염 등)을 진단하지 않고
// 응급 여부를 판단하지 않는다. 팀이 지정한 정확한 문구를 그대로 사용한다.
const DENTAL_CONSULTATION_NOTICE_MESSAGE = '치아 통증의 원인 확인을 위해 치과 상담을 권장합니다';

function getAnswerCode(answers, questionCode) {
  const found = (answers || []).find((a) => a.question_code === questionCode);
  return found ? found.answer_code : null;
}

function buildItem(productKey, reasonCode, rationale, evidence) {
  const product = PRODUCTS[productKey];
  return {
    product_key: productKey,
    display_name: product.display_name,
    quantity: product.default_quantity,
    reason_code: reasonCode,
    rationale,
    evidence,
  };
}

function computeProposalHash({ sessionId, contextHash, items }) {
  const sortedItems = [...items]
    .map((item) => ({ product_key: item.product_key, quantity: item.quantity }))
    .sort((a, b) => (a.product_key < b.product_key ? -1 : a.product_key > b.product_key ? 1 : 0));

  const hashInput = {
    session_id: sessionId,
    context_hash: contextHash,
    catalog_version: CATALOG_VERSION,
    ruleset_version: RULESET_VERSION,
    items: sortedItems,
  };
  return crypto.createHash('sha256').update(canonicalStringify(hashInput)).digest('hex');
}

/**
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.contextHash - session.context_hash(재검증 완료된 값)
 * @param {object} params.contextSnapshot - session.context_snapshot(불변)
 * @returns {{ catalog_version, ruleset_version, proposal_hash, items, safety_notices, disclaimer }}
 */
function recommendProducts({ sessionId, contextHash, contextSnapshot }) {
  const answers = contextSnapshot?.survey?.answers || [];
  const images = contextSnapshot?.images || [];
  const cavityPositions = images.filter((image) => image.cavity_detected === true).map((image) => image.position);
  const cavityDetected = cavityPositions.length > 0;

  const items = [];

  // ── 칫솔 (정확히 1개, baseline) ─────────────────────────────────────────
  // 잇몸 통증/출혈(Q6=YES)이면 초미세모, 아니면 일반 부드러운 칫솔.
  const gumPain = getAnswerCode(answers, 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS');
  if (gumPain === 'YES') {
    items.push(
      buildItem(
        'TOOTHBRUSH_ULTRA_SOFT',
        'GENTLE_BRUSHING_SUPPORT',
        '최근 잇몸 통증·출혈이 있었다는 응답에 따라 더 부드러운 칫솔질에 도움이 되는 상품을 제안드립니다. 증상이 계속되면 치과 진료를 받아보세요.',
        [{ source: 'survey_answer', question_code: 'GUM_PAIN_OR_BLEEDING_LAST_3_MONTHS', answer_code: 'YES' }]
      )
    );
  } else {
    items.push(
      buildItem('TOOTHBRUSH_SOFT', 'GENERAL_DAILY_HYGIENE', '일상적인 구강 위생 관리를 위한 기본 칫솔입니다.', [])
    );
  }

  // ── 불소 치약 (최대 1개) ────────────────────────────────────────────────
  // 아래 우식 위험/불소 상태 신호를 결합해 근거를 만든다. Q5(통증)는 절대
  // 근거로 넣지 않는다. cavity/우식 위험/양치 부족 중 하나라도 있으면
  // CAVITY_PREVENTION_SUPPORT, 그런 신호 없이 불소 미사용/모름만 있으면
  // FLUORIDE_HYGIENE_SUPPORT로 추천한다.
  const fluorideEvidence = [];
  let cavityRiskPresent = false;

  if (cavityDetected) {
    cavityRiskPresent = true;
    for (const position of cavityPositions) {
      fluorideEvidence.push({ source: 'image_analysis', position });
    }
  }

  // 우식성 간식/음료를 하루 4번 이상(FOUR_OR_MORE) → 우식 위험
  const sugarySnacks = getAnswerCode(answers, 'SUGARY_STICKY_SNACKS_PER_DAY');
  if (sugarySnacks === 'FOUR_OR_MORE') {
    cavityRiskPresent = true;
    fluorideEvidence.push({ source: 'survey_answer', question_code: 'SUGARY_STICKY_SNACKS_PER_DAY', answer_code: sugarySnacks });
  }
  const sugaryDrinks = getAnswerCode(answers, 'SUGARY_DRINKS_PER_DAY');
  if (sugaryDrinks === 'FOUR_OR_MORE') {
    cavityRiskPresent = true;
    fluorideEvidence.push({ source: 'survey_answer', question_code: 'SUGARY_DRINKS_PER_DAY', answer_code: sugaryDrinks });
  }

  // 양치 부족: 어제 1회(ONE) 또는 취침 전 칫솔질 전혀 안 함(NEVER) → 우식 위험
  const brushingCount = getAnswerCode(answers, 'BRUSHING_COUNT_YESTERDAY');
  if (brushingCount === 'ONE') {
    cavityRiskPresent = true;
    fluorideEvidence.push({ source: 'survey_answer', question_code: 'BRUSHING_COUNT_YESTERDAY', answer_code: brushingCount });
  }
  const bedtimeBrushing = getAnswerCode(answers, 'BEDTIME_BRUSHING_LAST_WEEK');
  if (bedtimeBrushing === 'NEVER') {
    cavityRiskPresent = true;
    fluorideEvidence.push({ source: 'survey_answer', question_code: 'BEDTIME_BRUSHING_LAST_WEEK', answer_code: bedtimeBrushing });
  }

  // 불소 미사용/모름 (Q12)
  const fluorideStatus = getAnswerCode(answers, 'FLUORIDE_TOOTHPASTE_STATUS');
  const fluorideMissing = fluorideStatus === 'NO' || fluorideStatus === 'UNKNOWN';
  if (fluorideMissing) {
    fluorideEvidence.push({ source: 'survey_answer', question_code: 'FLUORIDE_TOOTHPASTE_STATUS', answer_code: fluorideStatus });
  }

  if (cavityRiskPresent || fluorideMissing) {
    const reasonCode = cavityRiskPresent ? 'CAVITY_PREVENTION_SUPPORT' : 'FLUORIDE_HYGIENE_SUPPORT';
    const rationale = cavityRiskPresent
      ? '충치 예방을 위한 일반적인 위생 관리 차원에서 불소 치약을 제안드립니다. 정확한 진단과 치료는 치과에서 확인하세요.'
      : '현재 사용 중인 치약에 불소가 없거나 확실하지 않다는 응답에 따라 불소 치약을 제안드립니다.';
    items.push(buildItem('TOOTHPASTE_FLUORIDE', reasonCode, rationale, fluorideEvidence));
  }

  // ── 치실 (최대 1개) ─────────────────────────────────────────────────────
  const interdental = getAnswerCode(answers, 'INTERDENTAL_CLEANING_LAST_WEEK');
  if (interdental === 'NEVER' || interdental === 'DOES_NOT_KNOW_TOOL') {
    items.push(
      buildItem(
        'FLOSS_TAPE',
        'INTERDENTAL_CLEANING_SUPPORT',
        '최근 일주일간 치실·치간솔 사용이 거의 없었다는 응답에 따라 치간 관리를 시작하기 좋은 치실을 제안드립니다.',
        [{ source: 'survey_answer', question_code: 'INTERDENTAL_CLEANING_LAST_WEEK', answer_code: interdental }]
      )
    );
  }

  items.sort((a, b) => (a.product_key < b.product_key ? -1 : a.product_key > b.product_key ? 1 : 0));

  // ── 안전 안내 (상품과 분리, Shopify로 전달되지 않음) ────────────────────
  // Q5(치아 통증)=YES → 비진단적 치과 상담 권유. 상품 추천에는 전혀 관여하지
  // 않는다. 이 신호와 문구는 Shopify Cart payload에 포함되지 않는다.
  const safetyNotices = [];
  const toothPain = getAnswerCode(answers, 'TOOTH_PAIN_LAST_3_MONTHS');
  if (toothPain === 'YES') {
    safetyNotices.push({
      code: 'DENTAL_CONSULTATION_RECOMMENDED',
      message: DENTAL_CONSULTATION_NOTICE_MESSAGE,
      evidence: [{ source: 'survey_answer', question_code: 'TOOTH_PAIN_LAST_3_MONTHS', answer_code: 'YES' }],
    });
  }

  return {
    catalog_version: CATALOG_VERSION,
    ruleset_version: RULESET_VERSION,
    proposal_hash: computeProposalHash({ sessionId, contextHash, items }),
    items,
    safety_notices: safetyNotices,
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  RULESET_VERSION,
  DISCLAIMER,
  DENTAL_CONSULTATION_NOTICE_MESSAGE,
  recommendProducts,
  computeProposalHash,
  // 테스트 노출(순수 헬퍼)
  getAnswerCode,
};
