/**
 * database/verify-survey-seed-scratch-db.js
 * ----------------------------------------------------------------------------
 * "완전히 빈 DB에서 팀 공식 setup-db → 팀 정본 설문 Seed(seed_survey_questionnaire.sql)
 * → migrate:agent(001~004) → run-seed 검증 → 무결성/하위호환" 경로가 재현되는지
 * 확인하는 검증 스크립트.
 *
 * 통합 정책(팀 결정):
 *   - 팀 설문이 source of truth다. Agent는 설문을 Seed하지 않는다.
 *   - 이 스크립트는 스크래치 DB에서만 팀 공식 setup 순서(schema.sql →
 *     seed_survey_questionnaire.sql)를 재현한 뒤, run-seed(검증 전용)가 팀 정본과
 *     Agent Codebook checksum이 일치한다고 판정하는지 확인한다.
 *   - 팀 설문 Seed 파일은 재실행용 DELETE를 포함하므로, migration/E2E 준비 과정에서
 *     자동 재실행하지 않는다. 여기서는 "빈 스크래치 DB 최초 구축"에서만 1회 적용한다.
 *
 * 안전 원칙(verify-migration-scratch-db.js와 동일):
 *   - 하드코딩된 스크래치 DB 이름(ALLOWED_SCRATCH_DB_NAMES)만 대상으로 한다.
 *   - .env의 실 개발 DB(DB_NAME)는 이 스크립트의 어떤 단계에서도 건드리지 않는다.
 *   - DROP DATABASE 직전에 이름을 재검증한다.
 *
 * 사용법: node database/verify-survey-seed-scratch-db.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const {
  loadMigrationFiles,
  findSafetyViolations,
  verifySurveyCodebookSchema,
  checkNoDuplicateSurveyResponses,
  MIGRATIONS_DIR,
} = require('./run-migration');
const runSeed = require('./run-seed');
const {
  QUESTIONS,
  CODEBOOK_CHECKSUM,
  validateAndMapResponses,
} = require('../agent/catalog/surveyCodebook');

const ALLOWED_SCRATCH_DB_NAMES = ['bloomdent_survey_seed_verify'];
const SCRATCH_DB_NAME = 'bloomdent_survey_seed_verify';

function assertScratchDbNameAllowed(name) {
  if (!ALLOWED_SCRATCH_DB_NAMES.includes(name)) {
    throw new Error(`허용되지 않은 스크래치 DB 이름: "${name}". 허용 목록: [${ALLOWED_SCRATCH_DB_NAMES.join(', ')}]`);
  }
}

let passed = 0;
function check(name, ok, detail) {
  if (!ok) {
    throw new Error(`❌ [${name}] 실패${detail ? `: ${detail}` : ''}`);
  }
  passed += 1;
  console.log(`  ✅ ${name}`);
}

async function applySqlFile(connection, filePath, label) {
  console.log(`🔧 ${label} 적용 중...`);
  const sql = fs.readFileSync(filePath, 'utf8');
  await connection.query(sql);
  console.log(`   완료: ${label}`);
}

async function main() {
  assertScratchDbNameAllowed(SCRATCH_DB_NAME);
  const realDbName = process.env.DB_NAME;
  if (realDbName && realDbName === SCRATCH_DB_NAME) {
    throw new Error('.env DB_NAME이 스크래치 DB 이름과 동일합니다. 중단합니다.');
  }
  if (!process.env.DB_HOST || !process.env.DB_USER) {
    throw new Error('.env 확인 필요: DB_HOST, DB_USER');
  }

  console.log('🦷 BloomDent 팀 정본 설문 — 스크래치 DB 재현성 검증\n');
  console.log(`   대상 스크래치 DB: ${SCRATCH_DB_NAME}`);
  console.log(`   실 개발 DB(.env DB_NAME=${realDbName || '(미설정)'})는 건드리지 않습니다.\n`);

  const adminConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  try {
    // 1) 팀 공식 setup-db 재현 (schema + users seed)
    console.log(`🧪 스크래치 DB 생성: ${SCRATCH_DB_NAME}`);
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${SCRATCH_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await adminConn.query(`USE \`${SCRATCH_DB_NAME}\``);
    await applySqlFile(adminConn, path.join(__dirname, 'schema.sql'), 'schema.sql');
    await applySqlFile(adminConn, path.join(__dirname, 'seed_data.sql'), 'seed_data.sql');
    check('1. 팀 setup-db(schema + users/치과 seed) 적용', true);

    // 2) 팀 정본 설문 Seed 적용 (seed_survey_questionnaire.sql, 15문항)
    //    최초 빈 스크래치 DB 구축에서만 1회 적용한다.
    await applySqlFile(adminConn, path.join(__dirname, 'seed_survey_questionnaire.sql'), 'seed_survey_questionnaire.sql (팀 정본 15문항)');
    check('2. 팀 정본 설문 Seed 적용', true);

    // 3) migrate:agent 재현 (001~004, 비파괴 가드 통과 확인)
    console.log('\n🔧 Agent Migration 적용 (001~004)...');
    const files = loadMigrationFiles();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const violations = findSafetyViolations(sql);
      if (violations.length > 0) throw new Error(`${file} 안전성 위반: ${violations.join(', ')}`);
      const dupCheck = file.startsWith('003') ? await checkNoDuplicateSurveyResponses(adminConn) : { ok: true };
      if (!dupCheck.ok) throw new Error('003 적용 전 중복 응답 발견(예상치 못함)');
      await adminConn.query(sql);
      console.log(`   완료: ${file}`);
    }
    check('3. Agent Migration(001~004) 적용', true);

    // 4) 003 UNIQUE INDEX 정합 확인 (category ENUM은 003이 건드리지 않는다)
    const surveySchemaCheck = await verifySurveyCodebookSchema(adminConn, SCRATCH_DB_NAME);
    check('4. user_survey_responses UNIQUE INDEX(003) 정합', surveySchemaCheck.ok);

    // 5) run-seed(검증 전용): 팀 정본 15문항이 Agent Codebook과 구조+checksum 일치
    const verification = await runSeed.verifySeed(adminConn);
    check('5. 문항 15개 일치', verification.questionCount === 15, `실제 ${verification.questionCount}`);
    check('5. 문항별 옵션 개수 일치', verification.mismatchedOptionCounts.length === 0, verification.mismatchedOptionCounts.join(','));
    check('5. Codebook checksum 일치(팀 정본 category/score 포함)', verification.actualChecksum === CODEBOOK_CHECKSUM,
      `expected ${CODEBOOK_CHECKSUM.slice(0, 12)}… actual ${(verification.actualChecksum || 'null').slice(0, 12)}…`);

    // 6) run-seed 재실행 멱등성(쓰기 0, 동일 판정)
    const verification2 = await runSeed.verifySeed(adminConn);
    check('6. run-seed 재실행 멱등(동일 checksum 판정)', verification2.actualChecksum === CODEBOOK_CHECKSUM);

    // 7) 하위호환: 팀 배점 설문 응답(실제 category/score) + Agent 개별응답 해석 공존
    //    임의 사용자 1명으로 3개 문항 응답을 팀 정본 값 그대로 삽입한다.
    const [userRow] = await adminConn.query('SELECT id FROM users ORDER BY id LIMIT 1');
    let userId = userRow[0] && userRow[0].id;
    if (!userId) {
      const [ins] = await adminConn.query(
        "INSERT INTO users (username, password, name) VALUES ('scratch_user', 'x', 'scratch')"
      );
      userId = ins.insertId;
    }
    const sessionId = 'scratch-session-0001';
    // 팀 seed의 실제 (score, category)를 조회해 그대로 사용한다(임의값 아님).
    async function optionOf(qn, on) {
      const [rows] = await adminConn.query(
        'SELECT score, category FROM survey_question_options WHERE question_number = ? AND option_number = ?',
        [qn, on]
      );
      return rows[0];
    }
    const picks = [
      { qn: 12, on: 2 }, // FLUORIDE_TOOTHPASTE_STATUS = NO
      { qn: 11, on: 4 }, // INTERDENTAL_CLEANING_LAST_WEEK = NEVER
      { qn: 5, on: 1 }, // TOOTH_PAIN_LAST_3_MONTHS = YES
    ];
    const insertedRows = [];
    for (const p of picks) {
      const opt = await optionOf(p.qn, p.on);
      await adminConn.query(
        'INSERT INTO user_survey_responses (user_id, survey_session_id, question_number, option_number, score, category) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, sessionId, p.qn, p.on, opt.score, opt.category]
      );
      insertedRows.push({ question_number: p.qn, option_number: p.on, score: Number(opt.score), category: opt.category });
    }
    check('7. 팀 배점 설문 응답(실제 score/category) 삽입 성공', insertedRows.length === 3);

    // Agent 개별응답 해석: 팀 실제 category/score를 그대로 넘겨도 mismatch 없이 매핑된다.
    const mapped = validateAndMapResponses(insertedRows);
    check('7. Agent validateAndMapResponses가 팀 scored 응답을 mismatch 없이 매핑', mapped.ok, mapped.code);
    const codes = (mapped.answers || []).map((a) => a.question_code).sort();
    check('7. 매핑된 question_code가 정확', JSON.stringify(codes) === JSON.stringify(['FLUORIDE_TOOTHPASTE_STATUS', 'INTERDENTAL_CLEANING_LAST_WEEK', 'TOOTH_PAIN_LAST_3_MONTHS']));

    // 8) 무결성: 같은 (user, session, question)에 중복 응답은 UNIQUE INDEX(003)가 거부한다.
    let duplicateRejected = false;
    try {
      await adminConn.query(
        'INSERT INTO user_survey_responses (user_id, survey_session_id, question_number, option_number, score, category) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, sessionId, 12, 1, 5, '지각과민/불소']
      );
    } catch (e) {
      duplicateRejected = e && e.code === 'ER_DUP_ENTRY';
    }
    check('8. 문항당 응답 1건 UNIQUE 제약이 중복 응답을 거부(ER_DUP_ENTRY)', duplicateRejected);

    // 9) 다른 (session)에 대한 응답은 정상 허용(제약이 세션 단위임을 확인)
    await adminConn.query(
      'INSERT INTO user_survey_responses (user_id, survey_session_id, question_number, option_number, score, category) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, 'scratch-session-0002', 12, 1, 5, '지각과민/불소']
    );
    check('9. 다른 세션의 동일 문항 응답은 정상 허용', true);

    console.log(`\n🎉 팀 정본 설문 스크래치 재현성 검증 완료 (${passed} checks 통과).`);
  } finally {
    // 정리: 스크래치 DB만 드롭한다(이름 재검증 후).
    assertScratchDbNameAllowed(SCRATCH_DB_NAME);
    console.log(`\n🧹 스크래치 DB 정리: DROP DATABASE ${SCRATCH_DB_NAME}`);
    await adminConn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB_NAME}\``);
    console.log('   완료.');
    await adminConn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}

module.exports = { ALLOWED_SCRATCH_DB_NAMES, SCRATCH_DB_NAME, assertScratchDbNameAllowed };
