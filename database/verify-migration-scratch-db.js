/**
 * database/verify-migration-scratch-db.js
 * ----------------------------------------------------------------------------
 * "완전히 빈 DB에서 setup-db → migrate:agent → Agent Session ready 경로"가
 * 재현되는지 확인하는 검증 스크립트. 반드시 하드코딩된 스크래치 DB 이름
 * (ALLOWED_SCRATCH_DB_NAMES)만 대상으로 하며, .env의 실 개발 DB(DB_NAME)는
 * 이 스크립트의 어떤 단계(생성/시드/마이그레이션/조회/삭제)에서도 절대
 * 건드리지 않는다 — DB_HOST/PORT/USER/PASSWORD 접속 정보만 .env에서 재사용하고,
 * DB 이름 자체는 .env 값을 전혀 참조하지 않는다.
 *
 * 안전 장치:
 *   1) 스크래치 DB 이름은 ALLOWED_SCRATCH_DB_NAMES 에 정확히 나열된 것만 허용
 *      (패턴 매칭이 아닌 완전 일치). assertScratchDbNameAllowed() 가 이를 강제한다.
 *   2) DROP DATABASE 실행 직전에 다시 한 번 assertScratchDbNameAllowed() 를
 *      호출해 재검증한다. 허용되지 않은 이름이면 삭제 자체를 거부한다.
 *   3) SCRATCH_DB_NAME 이 혹시라도 .env DB_NAME 과 같아지면(설정 실수) 즉시 중단한다.
 *
 * 사용법:
 *   node database/verify-migration-scratch-db.js
 *   npm run verify:migration-scratch-db
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const {
  loadMigrationFiles,
  findSafetyViolations,
  verifyAgentTablesExist,
  verifyImageAnalysisSchema,
  MIGRATIONS_DIR,
} = require('./run-migration');

// 스크래치 DB로 허용하는 이름의 유일한 출처. 패턴이 아니라 정확한 문자열만 허용한다.
const ALLOWED_SCRATCH_DB_NAMES = ['bloomdent_migration_verify'];
const SCRATCH_DB_NAME = 'bloomdent_migration_verify';

function assertScratchDbNameAllowed(name) {
  if (!ALLOWED_SCRATCH_DB_NAMES.includes(name)) {
    throw new Error(
      `허용되지 않은 스크래치 DB 이름: "${name}". 허용 목록: [${ALLOWED_SCRATCH_DB_NAMES.join(', ')}]`
    );
  }
}

async function applySqlFile(connection, filePath, label) {
  console.log(`🔧 ${label} 적용 중...`);
  const sql = fs.readFileSync(filePath, 'utf8');
  await connection.query(sql);
  console.log(`   완료: ${label}`);
}

async function runAgentSessionSmokeCheck(scratchDbName) {
  // 이 프로세스 안에서만 유효한 트릭: config/database.js 의 pool 은 require 시점의
  // process.env.DB_NAME 을 그대로 캡처하므로, 실제 Agent 리포지토리/서비스 코드를
  // 여기서 처음 require 하기 전에 DB_NAME 을 스크래치 DB로 바꿔치기하면
  // 별도 서버 프로세스 없이도 진짜 Agent 코드 경로를 스크래치 DB에 대해 실행할 수 있다.
  // 이 스크립트는 단독 실행 전용이라 다른 모듈이 이미 config/database.js 를
  // 실 DB_NAME 으로 require 해둔 상태일 위험이 없다.
  process.env.DB_NAME = scratchDbName;

  const coreReadRepository = require('../agent/repositories/coreReadRepository');
  const agentRepository = require('../agent/repositories/agentRepository');
  const {
    decideReadiness,
    buildSurveyAnswersOrError,
    buildContextSnapshot,
    computeContextHash,
    MODEL_NAME_PLACEHOLDER,
    PROMPT_VERSION_PLACEHOLDER,
  } = require('../agent/services/contextSnapshotService');
  const { pool } = require('../config/database');
  const crypto = require('crypto');

  const userId = 1;
  const historyId = 'agent-fixture-history-scratch-verify';

  await pool.query(
    `INSERT INTO dental_images (user_id, cloudinary_id, cloudinary_url, original_filename, position, image_type, analysis_status, history_id)
     VALUES (?, 'v/upper', 'https://example.com/v-upper.jpg', 'v-upper.jpg', 'upper', 'other', 'completed', ?),
            (?, 'v/lower', 'https://example.com/v-lower.jpg', 'v-lower.jpg', 'lower', 'other', 'completed', ?),
            (?, 'v/front', 'https://example.com/v-front.jpg', 'v-front.jpg', 'front', 'other', 'completed', ?)`,
    [userId, historyId, userId, historyId, userId, historyId]
  );
  await pool.query(
    `INSERT INTO image_analysis (user_id, history_id, cloudinary_url, image_type, uploaded_at, analysis_status, occlusion_status, occlusion_comment, cavity_detected, cavity_locations, cavity_comment, overall_score, recommendations, ai_confidence)
     VALUES (?, ?, 'u', 'upper', CURRENT_TIMESTAMP, 'completed', 'normal', 'ok', FALSE, NULL, NULL, 8.5, 'rec', 0.82),
            (?, ?, 'l', 'lower', CURRENT_TIMESTAMP, 'completed', 'normal', 'ok', FALSE, NULL, NULL, 8.2, 'rec', 0.80),
            (?, ?, 'f', 'front', CURRENT_TIMESTAMP, 'completed', 'normal', 'ok', FALSE, NULL, NULL, 8.0, 'rec', 0.78)`,
    [userId, historyId, userId, historyId, userId, historyId]
  );

  const imageRows = await coreReadRepository.findImagesByHistoryId(historyId);
  const imageAnalysisRows = await coreReadRepository.findImageAnalysisByHistoryId(userId, historyId);
  const readiness = decideReadiness({
    authUserId: userId,
    imageRows,
    imageAnalysisRows,
    requestedSurveySessionId: null,
    surveyResponseRows: [],
  });

  if (readiness.status !== 'ready') {
    throw new Error(`Agent Session smoke check 실패: 기대 status=ready, 실제=${readiness.status}`);
  }

  const contextSnapshot = buildContextSnapshot({
    historyId,
    surveySessionId: null,
    imagesByPosition: readiness.imagesByPosition,
    surveyInfo: buildSurveyAnswersOrError([]),
  });
  const contextHash = computeContextHash(contextSnapshot);
  const sessionId = crypto.randomUUID();
  const idempotencyKey = 'scratch-verify-key';

  await agentRepository.insertReadySession({
    id: sessionId,
    userId,
    historyId,
    surveySessionId: null,
    contextSnapshot,
    contextHash,
    modelName: MODEL_NAME_PLACEHOLDER,
    promptVersion: PROMPT_VERSION_PLACEHOLDER,
    idempotencyKey,
  });

  const reproduced = await agentRepository.findByIdempotencyKey(userId, idempotencyKey);
  if (!reproduced || reproduced.id !== sessionId) {
    throw new Error('Agent Session smoke check 실패: Idempotency-Key 재현이 기대한 session_id를 반환하지 않음');
  }

  await pool.end();
  return { sessionId, contextHash };
}

async function main() {
  assertScratchDbNameAllowed(SCRATCH_DB_NAME);

  if (process.env.DB_NAME && process.env.DB_NAME === SCRATCH_DB_NAME) {
    throw new Error(
      `.env 의 DB_NAME 이 스크래치 DB 이름과 동일합니다("${SCRATCH_DB_NAME}"). 실 개발 DB를 건드리지 않도록 중단합니다.`
    );
  }
  if (!process.env.DB_HOST || !process.env.DB_USER) {
    throw new Error('.env 확인 필요: DB_HOST, DB_USER 가 필요합니다.');
  }

  console.log('🦷 BloomDent Agent Migration — 스크래치 DB 재현성 검증\n');
  console.log(`   대상 스크래치 DB: ${SCRATCH_DB_NAME} (허용 목록 검증 통과)`);
  console.log(`   실 개발 DB(.env DB_NAME=${process.env.DB_NAME || '(미설정)'}) 는 이 스크립트가 건드리지 않습니다.\n`);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  try {
    console.log(`🧪 스크래치 DB 생성: ${SCRATCH_DB_NAME}`);
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${SCRATCH_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${SCRATCH_DB_NAME}\``);

    // npm run setup-db 재현 (schema.sql + seed_data.sql + seed_survey_data.sql)
    await applySqlFile(connection, path.join(__dirname, 'schema.sql'), 'schema.sql');
    await applySqlFile(connection, path.join(__dirname, 'seed_data.sql'), 'seed_data.sql');
    await applySqlFile(connection, path.join(__dirname, 'seed_survey_data.sql'), 'seed_survey_data.sql');

    // npm run migrate:agent 재현 (001 + 002, 순서대로)
    console.log('\n🔧 Agent Migration 적용 (001, 002)...');
    const files = loadMigrationFiles();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const violations = findSafetyViolations(sql);
      if (violations.length > 0) {
        throw new Error(`${file} 안전성 위반: ${violations.join(', ')}`);
      }
      await connection.query(sql);
      console.log(`   완료: ${file}`);
    }

    console.log('\n📋 Agent 테이블 검증:');
    const tableCheck = await verifyAgentTablesExist(connection, SCRATCH_DB_NAME);
    for (const t of tableCheck.missing.length ? tableCheck.missing : []) {
      console.log(`   ❌ ${t}`);
    }
    if (!tableCheck.ok) {
      throw new Error(`Agent 테이블 누락: ${tableCheck.missing.join(', ')}`);
    }
    console.log('   ✅ 4개 Agent 테이블 모두 존재');

    console.log('\n📋 image_analysis 스키마 검증 (002):');
    const schemaCheck = await verifyImageAnalysisSchema(connection, SCRATCH_DB_NAME);
    if (!schemaCheck.ok) {
      throw new Error(
        `image_analysis 스키마 불일치: missingColumns=${schemaCheck.missingColumns.join(',')}, ` +
          `imageIdNullable=${schemaCheck.imageIdNullable}, missingIndexes=${schemaCheck.missingIndexes.join(',')}`
      );
    }
    console.log('   ✅ 컬럼 8개, image_id nullable, 인덱스 2개 모두 확인');

    await connection.end();

    console.log('\n🧪 Agent Session 스모크 체크 (실제 repository/service 코드로 ready → idempotency 재현)...');
    const smoke = await runAgentSessionSmokeCheck(SCRATCH_DB_NAME);
    console.log(`   ✅ ready 세션 생성 및 재현 확인 (session_id=${smoke.sessionId})`);

    console.log('\n🎉 스크래치 DB 재현성 검증 완료: setup-db → migrate:agent → Agent Session ready 경로 정상.');
  } finally {
    const cleanupConnection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
    });
    try {
      // 삭제 직전 재검증: 이름이 바뀌었거나 잘못 전달됐다면 여기서 반드시 걸러진다.
      assertScratchDbNameAllowed(SCRATCH_DB_NAME);
      console.log(`\n🧹 스크래치 DB 정리: DROP DATABASE ${SCRATCH_DB_NAME}`);
      await cleanupConnection.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB_NAME}\``);
      console.log('   완료.');
    } finally {
      await cleanupConnection.end();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ 스크래치 DB 검증 실패:');
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  ALLOWED_SCRATCH_DB_NAMES,
  SCRATCH_DB_NAME,
  assertScratchDbNameAllowed,
};
