-- ================================================================
-- 사전 자가진단 문진표 (15문항) 시드
--   대상 테이블: survey_questions / survey_question_options
--   동적설문 API(/api/survey/start|questions/:n|submit)와 SurveyComponent가 사용.
--
-- 점수 규칙:
--   - 옵션 score 는 0~5 척도 (5 = 가장 양호, 1 = 가장 나쁨)
--   - 카테고리별 점수 = (획득 합 / (응답한 점수문항수 × 5)) × 100  (survey.js 로직)
--   - 병력(당뇨/심혈관) 문항은 정보 수집용 → 모든 옵션 score 0 (점수 계산에서 제외)
--   - 문항은 분기 없이 순차 진행: 각 옵션 next_question_number = 다음 문항, 마지막(15)은 NULL(종료)
--
-- 카테고리(enum) 매핑:
--   구강관리/양치습관, 구치/구강건조, 흡연/음주, 우식성 식품 섭취, 지각과민/불소, 구강악습관
-- ================================================================

-- 재실행 대비 초기화
DELETE FROM survey_question_options;
DELETE FROM survey_questions;

-- ---------- 문항 (survey_questions) ----------
INSERT INTO survey_questions (question_number, question_text, max_score, is_active) VALUES
(1,  '최근 1년간 구강병 치료나 관리를 목적으로 치과병(의)원에 가신 적이 있습니까?', 5, 1),
(2,  '현재 당뇨병을 앓고 계십니까?', 5, 1),
(3,  '현재 심혈관질환을 앓고 계십니까?', 5, 1),
(4,  '최근 3개월 동안, 치아나 잇몸 문제 혹은 틀니 때문에 음식을 씹는 데에 불편감을 느끼신 적이 있습니까?', 5, 1),
(5,  '최근 3개월 동안, 치아가 쑤시거나 욱신거리거나 아픈 적 있습니까?', 5, 1),
(6,  '최근 3개월 동안, 잇몸이 아프거나 피가 난 적이 있습니까?', 5, 1),
(7,  '스스로 생각하실 때에 치아와 잇몸 등 귀하의 구강건강이 어떤 편이라고 생각하십니까?', 5, 1),
(8,  '치아 닦는 방법을 치과나 보건소에서 배운 적이 있습니까?', 5, 1),
(9,  '어제 하루 동안 치아를 몇 번 닦으셨습니까?', 5, 1),
(10, '최근 일주일 동안, 잠자기 직전에 칫솔질을 얼마나 자주 하였습니까?', 5, 1),
(11, '최근 일주일 동안, 치아를 닦을 때 치실 혹은 치간솔을 얼마나 자주 이용하였습니까?', 5, 1),
(12, '현재 사용 중인 치약에 불소가 들어있습니까?', 5, 1),
(13, '하루에 과자, 사탕, 케이크 등 달거나 치아에 끈끈하게 달라붙는 간식을 얼마나 먹습니까?', 5, 1),
(14, '하루에 탄산 및 청량음료(스포츠 음료, 이온 음료, 과일 주스 포함)을 얼마나 마십니까?', 5, 1),
(15, '담배를 피우십니까?', 5, 1);

-- ---------- 선택지 (survey_question_options) ----------
-- (question_number, option_number, option_text, next_question_number, score, category)

-- Q1 최근 1년 치과 방문 [구강관리/양치습관]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(1, 1, '예',    2, 5, '구강관리/양치습관'),
(1, 2, '아니오', 2, 2, '구강관리/양치습관');

-- Q2 당뇨병 (정보수집, 점수 0) [구치/구강건조]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(2, 1, '예',      3, 0, '구치/구강건조'),
(2, 2, '아니오',   3, 0, '구치/구강건조'),
(2, 3, '모르겠다', 3, 0, '구치/구강건조');

-- Q3 심혈관질환 (정보수집, 점수 0) [구치/구강건조]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(3, 1, '예',      4, 0, '구치/구강건조'),
(3, 2, '아니오',   4, 0, '구치/구강건조'),
(3, 3, '모르겠다', 4, 0, '구치/구강건조');

-- Q4 씹기 불편감 [구치/구강건조]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(4, 1, '예',    5, 1, '구치/구강건조'),
(4, 2, '아니오', 5, 5, '구치/구강건조');

-- Q5 치아 쑤심/욱신/통증 [지각과민/불소]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(5, 1, '예',    6, 1, '지각과민/불소'),
(5, 2, '아니오', 6, 5, '지각과민/불소');

-- Q6 잇몸 통증/출혈 [구치/구강건조]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(6, 1, '예',    7, 1, '구치/구강건조'),
(6, 2, '아니오', 7, 5, '구치/구강건조');

-- Q7 주관적 구강건강 인식 [구강관리/양치습관]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(7, 1, '매우 좋음',  8, 5, '구강관리/양치습관'),
(7, 2, '좋음',      8, 4, '구강관리/양치습관'),
(7, 3, '보통',      8, 3, '구강관리/양치습관'),
(7, 4, '나쁨',      8, 2, '구강관리/양치습관'),
(7, 5, '매우 나쁨',  8, 1, '구강관리/양치습관');

-- Q8 양치법 교육 경험 [구강관리/양치습관]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(8, 1, '예',    9, 5, '구강관리/양치습관'),
(8, 2, '아니오', 9, 2, '구강관리/양치습관');

-- Q9 어제 양치 횟수 [구강관리/양치습관]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(9, 1, '1회', 10, 1, '구강관리/양치습관'),
(9, 2, '2회', 10, 3, '구강관리/양치습관'),
(9, 3, '3회', 10, 5, '구강관리/양치습관'),
(9, 4, '4회', 10, 5, '구강관리/양치습관'),
(9, 5, '5회', 10, 5, '구강관리/양치습관');

-- Q10 취침 전 칫솔질 빈도 [구강관리/양치습관]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(10, 1, '항상 했다(7회)',       11, 5, '구강관리/양치습관'),
(10, 2, '대부분 했다(4~6회)',   11, 4, '구강관리/양치습관'),
(10, 3, '가끔 했다(1~3회)',     11, 2, '구강관리/양치습관'),
(10, 4, '전혀 하지 않았다(0회)', 11, 1, '구강관리/양치습관');

-- Q11 치실/치간솔 사용 빈도 [구강관리/양치습관]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(11, 1, '항상 했다',                   12, 5, '구강관리/양치습관'),
(11, 2, '대부분 했다',                 12, 4, '구강관리/양치습관'),
(11, 3, '가끔 했다',                   12, 3, '구강관리/양치습관'),
(11, 4, '전혀 하지 않았다',             12, 1, '구강관리/양치습관'),
(11, 5, '치실 혹은 치간솔이 무엇인지 모른다', 12, 1, '구강관리/양치습관');

-- Q12 치약 불소 함유 [지각과민/불소]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(12, 1, '예',      13, 5, '지각과민/불소'),
(12, 2, '아니오',   13, 2, '지각과민/불소'),
(12, 3, '모르겠다', 13, 3, '지각과민/불소');

-- Q13 우식성 간식 빈도 [우식성 식품 섭취]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(13, 1, '먹지 않음',  14, 5, '우식성 식품 섭취'),
(13, 2, '1번',       14, 4, '우식성 식품 섭취'),
(13, 3, '2~3번',     14, 2, '우식성 식품 섭취'),
(13, 4, '4번 이상',   14, 1, '우식성 식품 섭취'),
(13, 5, '모르겠다',   14, 3, '우식성 식품 섭취');

-- Q14 탄산/청량음료 빈도 [우식성 식품 섭취]
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(14, 1, '먹지 않음',  15, 5, '우식성 식품 섭취'),
(14, 2, '1번',       15, 4, '우식성 식품 섭취'),
(14, 3, '2~3번',     15, 2, '우식성 식품 섭취'),
(14, 4, '4번 이상',   15, 1, '우식성 식품 섭취'),
(14, 5, '모르겠다',   15, 3, '우식성 식품 섭취');

-- Q15 흡연 [흡연/음주] (마지막 문항 → next NULL 로 종료)
INSERT INTO survey_question_options (question_number, option_number, option_text, next_question_number, score, category) VALUES
(15, 1, '전혀 피운 적이 없다',      NULL, 5, '흡연/음주'),
(15, 2, '현재 피우고 있다',         NULL, 1, '흡연/음주'),
(15, 3, '이전에 피웠으나 끊었다',    NULL, 3, '흡연/음주');
