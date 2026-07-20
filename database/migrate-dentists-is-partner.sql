-- dentists 테이블에 협약(파트너) 병원 관리용 is_partner 컬럼 추가.
-- 컬럼 추가 + 인덱스 생성 후, 짝수 id를 파트너로 지정하여 약 절반을 파트너로 표시한다.

-- 1) 컬럼 추가 (기본값 0 = 비파트너)
ALTER TABLE dentists
  ADD COLUMN is_partner TINYINT(1) NOT NULL DEFAULT 0 COMMENT '협약 병원 여부' AFTER phone;

-- 2) 조회 성능용 인덱스
ALTER TABLE dentists
  ADD INDEX idx_dentists_is_partner (is_partner);

-- 3) 약 절반을 파트너로 지정 (짝수 id)
UPDATE dentists SET is_partner = 1 WHERE id % 2 = 0;
