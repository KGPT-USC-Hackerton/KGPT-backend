-- 예약 관련 테이블의 clinic_id 외래키를 dental_clinics → dentists 로 재지정한다.
--
-- 배경: 치과(clinic) 정보를 NPI 기반 dentists 테이블로 이전하면서
--   appointment_slots.clinic_id, appointments.clinic_id 가 dentists.id 를 참조하도록 변경.
--   dentists.id 는 BIGINT UNSIGNED 이므로 clinic_id 컬럼 타입도 함께 변경한다.
--
-- 주의: 세 테이블(dental_clinics/appointment_slots/appointments)이 비어 있는 상태에서 실행하는 것을 전제로 한다.
--   기존 데이터가 있다면 clinic_id 값이 dentists.id 와 매핑되는지 먼저 확인/이전해야 한다.

-- 1) 기존 외래키 제거
ALTER TABLE appointment_slots DROP FOREIGN KEY appointment_slots_ibfk_1;
ALTER TABLE appointments      DROP FOREIGN KEY appointments_ibfk_2;

-- 2) clinic_id 타입을 dentists.id(BIGINT UNSIGNED)에 맞춤
ALTER TABLE appointment_slots MODIFY clinic_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE appointments      MODIFY clinic_id BIGINT UNSIGNED NOT NULL;

-- 3) dentists 를 참조하는 외래키 재생성 (기존 제약명 유지)
ALTER TABLE appointment_slots
  ADD CONSTRAINT appointment_slots_ibfk_1
  FOREIGN KEY (clinic_id) REFERENCES dentists(id) ON DELETE CASCADE;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_ibfk_2
  FOREIGN KEY (clinic_id) REFERENCES dentists(id) ON DELETE CASCADE;
