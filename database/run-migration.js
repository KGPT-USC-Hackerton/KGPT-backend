/**
 * database/run-migration.js
 * ----------------------------------------------------------------------------
 * BloomDent Agent 전용 비파괴 Migration 실행기.
 *
 * 설계 근거: docs/BloomDent_Agentic_Copilot_Architecture_Revised_Updated.md §6.1
 * 안전 원칙 (CLAUDE.md "Database safety"):
 *   - setup-database.js(파괴적 전체 초기화)를 절대 사용하지 않는다.
 *   - database/migrations/*.sql 을 파일명 오름차순으로 실행한다.
 *   - 각 파일에 DROP / TRUNCATE / DELETE FROM 등 파괴적 구문이나 Core 테이블
 *     ALTER 가 있으면 실행 자체를 거부한다(Fail-safe). 단 image_analysis 는
 *     schema.sql과 실제 코드가 어긋나 있던 기존 드리프트를 보정하기 위해
 *     nullable 컬럼 추가 / 인덱스 추가 / image_id NULL 완화라는 아주 좁은
 *     패턴에 한해서만 예외적으로 허용한다(isSafeImageAnalysisAlterStatement).
 *   - 실행 후 기대 Agent 테이블 존재 여부와, image_analysis 가 002 가 기대하는
 *     컬럼/인덱스를 실제로 갖췄는지를 information_schema 로 검증해 출력한다.
 *
 * 사용법:
 *   node database/run-migration.js            # 실행
 *   node database/run-migration.js --dry-run  # 검증만(실행 안 함)
 *   npm run migrate:agent                     # package.json script
 *
 * 필수 환경 변수(config/database.js 와 동일): DB_HOST, DB_PORT, DB_USER,
 *   DB_PASSWORD, DB_NAME
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// 이 Migration 실행기가 존재를 보장하려는 Agent 테이블 목록
const EXPECTED_AGENT_TABLES = [
  'agent_sessions',
  'agent_chat_history',
  'agent_tool_runs',
  'dental_passes',
  'shopify_cart_requests',
];

// 절대 허용하지 않는 파괴적 구문 패턴 (대소문자 무시, 주석 제거 후 검사)
const FORBIDDEN_PATTERNS = [
  { re: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { re: /\bDROP\s+DATABASE\b/i, label: 'DROP DATABASE' },
  { re: /\bDROP\s+SCHEMA\b/i, label: 'DROP SCHEMA' },
  { re: /\bTRUNCATE\b/i, label: 'TRUNCATE' },
  { re: /\bDELETE\s+FROM\b/i, label: 'DELETE FROM' },
  { re: /\bSET\s+FOREIGN_KEY_CHECKS\b/i, label: 'SET FOREIGN_KEY_CHECKS' },
];

// 기존 Core 테이블: 이 파일들은 새 Agent 테이블만 만들어야 하므로,
// 아래 Core 테이블에 대한 CREATE/ALTER/DROP 은 모두 차단한다.
const CORE_TABLES = [
  'users',
  'dental_clinics',
  'appointment_slots',
  'reservation_survey_questions',
  'appointments',
  'appointment_surveys',
  'dental_images',
  'image_analysis',
  'survey_questions',
  'survey_question_options',
  'user_survey_responses',
  'user_health_scores',
  'score_history',
  'detail_survey',
];

/**
 * SQL 문자열에서 줄/블록 주석을 제거해 구문 검사 오탐을 줄인다.
 */
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* ... */
    .replace(/--.*$/gm, ' '); // -- ...
}

/**
 * 세미콜론 기준으로 개별 SQL 문장을 분리한다.
 * (이 프로젝트의 migration 파일은 문자열 리터럴에 세미콜론을 쓰지 않는다는 전제)
 */
function splitStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// image_analysis 는 schema.sql(DDL)과 실제 실행 코드(routes/images.js, routes/ai.js)가
// 오래전부터 어긋나 있던 유일한 Core 테이블이다(002_align_image_analysis_schema.sql 참고).
// 이건 Agent가 Core 스키마를 새로 설계하는 게 아니라 이미 존재하던 드리프트를 복구하는
// 호환성 Migration이므로, 여기서 허용하는 ALTER 도 "임의의 nullable 컬럼/인덱스 추가"가
// 아니라 002가 실제로 필요로 하는 정확한 컬럼명·타입·인덱스명 9개 + image_id 완화 1개,
// 딱 그만큼만 하드코딩된 allowlist로 허용한다. 그 외 모든 Core 테이블은 ALTER 자체가
// 전면 차단되고, image_analysis 라도 이 목록에 없는 컬럼/인덱스명은 전부 차단된다.
const IMAGE_ANALYSIS_ALLOWED_ADD_COLUMN_STATEMENTS = [
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?user_id`?\s+INT\s+NULL\s+AFTER\s+`?image_id`?$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?history_id`?\s+VARCHAR\(100\)\s+NULL\s+AFTER\s+`?user_id`?$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?cloudinary_url`?\s+TEXT\s+NULL\s+AFTER\s+`?history_id`?$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?image_type`?\s+VARCHAR\(50\)\s+NULL\s+AFTER\s+`?cloudinary_url`?$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?uploaded_at`?\s+TIMESTAMP\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP\s+AFTER\s+`?image_type`?$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?analysis_status`?\s+ENUM\('pending','processing','completed','failed'\)\s+NULL\s+DEFAULT\s+'pending'\s+AFTER\s+`?uploaded_at`?$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?llm_summary`?\s+TEXT\s+NULL$/i,
];

const IMAGE_ANALYSIS_ALLOWED_ADD_INDEX_STATEMENTS = [
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+INDEX\s+IF\s+NOT\s+EXISTS\s+`?idx_image_analysis_history`?\s*\(\s*history_id\s*,\s*image_type\s*\)$/i,
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+ADD\s+INDEX\s+IF\s+NOT\s+EXISTS\s+`?idx_image_analysis_user`?\s*\(\s*user_id\s*,\s*history_id\s*\)$/i,
];

const IMAGE_ANALYSIS_WIDEN_IMAGE_ID_STATEMENT =
  /^ALTER\s+TABLE\s+`?image_analysis`?\s+MODIFY\s+COLUMN\s+`?image_id`?\s+INT(?:\(\d+\))?\s+NULL$/i;

// 003_extend_survey_for_agent_codebook.sql 전용 좁은 allowlist. image_analysis와
// 동일한 원칙: "임의의 ALTER"가 아니라 정확히 이 문장 하나만(공백/개행은 유연하게)
// 통과시킨다. 팀 정본 문진표는 category ENUM을 그대로 쓰므로 003은 ENUM을
// 건드리지 않는다 — user_survey_responses의 UNIQUE INDEX 추가 한 문장만 허용하고,
// survey_question_options를 포함한 그 외 모든 Core 테이블 ALTER는 계속 차단된다.
const USER_SURVEY_RESPONSES_ALLOWED_ALTER_STATEMENT =
  /^ALTER\s+TABLE\s+`?user_survey_responses`?\s+ADD\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+`?uq_user_survey_response_question`?\s*\(\s*user_id\s*,\s*survey_session_id\s*,\s*question_number\s*\)$/i;

// 003 적용 후 검증용으로도 재사용하는 상수(테스트에서 실제 003 파일 텍스트와 대조)
// 004 적용 후 shopify_cart_requests 가 정확히 기대한 스키마인지 검증하기 위한
// 명세. 이름만 확인하는 게 아니라 컬럼 타입/ENUM 순서/기본값/인덱스 구성/FK
// CASCADE 까지 대조한다(verifyShopifyCartRequestsSchema).
const SHOPIFY_CART_EXPECTED_COLUMNS = {
  id: { type: 'char(36)', nullable: 'NO' },
  user_id: { type: 'int', nullable: 'NO' },
  session_id: { type: 'char(36)', nullable: 'NO' },
  idempotency_key_hash: { type: 'char(64)', nullable: 'NO' },
  request_hash: { type: 'char(64)', nullable: 'NO' },
  proposal_hash: { type: 'char(64)', nullable: 'NO' },
  shopify_config_fingerprint: { type: 'char(64)', nullable: 'NO' },
  selected_items_json: { type: 'json', nullable: 'NO' },
  status: { type: 'enum', nullable: 'NO' },
  attempt_count: { type: 'tinyint', nullable: 'NO' },
  shopify_cart_id: { type: 'varchar(255)', nullable: 'YES' },
  checkout_url: { type: 'text', nullable: 'YES' },
  estimated_total_amount: { type: 'varchar(64)', nullable: 'YES' },
  estimated_total_currency_code: { type: 'varchar(16)', nullable: 'YES' },
  estimated_total_is_estimated: { type: 'tinyint', nullable: 'YES' },
  warning_codes_json: { type: 'json', nullable: 'YES' },
  normalized_error_code: { type: 'varchar(80)', nullable: 'YES' },
  normalized_http_status: { type: 'smallint', nullable: 'YES' },
  safe_error_details_json: { type: 'json', nullable: 'YES' },
  external_call_started_at: { type: 'timestamp(6)', nullable: 'YES' },
  completed_at: { type: 'timestamp(6)', nullable: 'YES' },
  created_at: { type: 'timestamp(6)', nullable: 'NO' },
  updated_at: { type: 'timestamp(6)', nullable: 'NO' },
};

const SHOPIFY_CART_EXPECTED_STATUS_ENUM = ['pending', 'succeeded', 'failed', 'outcome_unknown'];

// created_at/updated_at 은 반드시 애플리케이션 Clock 이 bind 해야 하므로
// DB 자동 기본값/ON UPDATE 가 붙어 있으면 안 된다.
const SHOPIFY_CART_APP_MANAGED_TIME_COLUMNS = ['created_at', 'updated_at'];

const SHOPIFY_CART_EXPECTED_INDEXES = {
  uq_shopify_cart_idempotency: { unique: true, columns: ['user_id', 'idempotency_key_hash'] },
  idx_shopify_cart_session: { unique: false, columns: ['session_id'] },
  idx_shopify_cart_status: { unique: false, columns: ['status'] },
  idx_shopify_cart_pending: { unique: false, columns: ['status', 'external_call_started_at', 'created_at'] },
};

const SHOPIFY_CART_EXPECTED_FK_TABLES = ['users', 'agent_sessions'];

const USER_SURVEY_RESPONSE_EXPECTED_UNIQUE_INDEX = 'uq_user_survey_response_question';

// 002 실행 후 information_schema 로 실제 반영됐는지 검증할 때도 동일하게 재사용하는
// "정확히 이것만 있어야 한다" 목록 — allowlist 정규식과 이 상수들이 서로 어긋나지 않도록
// run-migration.test.js 에서 실제 002 파일 텍스트와 대조하는 회귀 테스트를 둔다.
const IMAGE_ANALYSIS_EXPECTED_COLUMNS = [
  'image_id',
  'user_id',
  'history_id',
  'cloudinary_url',
  'image_type',
  'uploaded_at',
  'analysis_status',
  'llm_summary',
];
const IMAGE_ANALYSIS_NULLABLE_COLUMN = 'image_id';
const IMAGE_ANALYSIS_EXPECTED_INDEXES = ['idx_image_analysis_history', 'idx_image_analysis_user'];

function isSafeImageAnalysisAlterStatement(statement) {
  const normalized = statement.trim();
  return (
    IMAGE_ANALYSIS_ALLOWED_ADD_COLUMN_STATEMENTS.some((re) => re.test(normalized)) ||
    IMAGE_ANALYSIS_ALLOWED_ADD_INDEX_STATEMENTS.some((re) => re.test(normalized)) ||
    IMAGE_ANALYSIS_WIDEN_IMAGE_ID_STATEMENT.test(normalized)
  );
}

/**
 * 002 적용 후 image_analysis 가 실제로 기대한 컬럼/인덱스를 갖췄는지
 * information_schema 로 검증한다. DB 접근이 필요해 오프라인 유닛 테스트 대상은 아니다.
 */
async function verifyImageAnalysisSchema(connection, dbName) {
  const [columnRows] = await connection.query(
    `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'image_analysis' AND COLUMN_NAME IN (?)`,
    [dbName, IMAGE_ANALYSIS_EXPECTED_COLUMNS]
  );
  const columnNullability = new Map(columnRows.map((r) => [r.COLUMN_NAME, r.IS_NULLABLE]));
  const missingColumns = IMAGE_ANALYSIS_EXPECTED_COLUMNS.filter((c) => !columnNullability.has(c));
  const imageIdNullable = columnNullability.get(IMAGE_ANALYSIS_NULLABLE_COLUMN) === 'YES';

  const [indexRows] = await connection.query(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'image_analysis' AND INDEX_NAME IN (?)`,
    [dbName, IMAGE_ANALYSIS_EXPECTED_INDEXES]
  );
  const presentIndexes = new Set(indexRows.map((r) => r.INDEX_NAME));
  const missingIndexes = IMAGE_ANALYSIS_EXPECTED_INDEXES.filter((i) => !presentIndexes.has(i));

  return {
    missingColumns,
    imageIdNullable,
    missingIndexes,
    ok: missingColumns.length === 0 && imageIdNullable && missingIndexes.length === 0,
  };
}

/**
 * 003 적용(UNIQUE INDEX 추가) 전, (user_id, survey_session_id, question_number)
 * 중복이 이미 있는지 애플리케이션 레벨에서 먼저 확인한다. 중복이 있으면
 * migration을 아예 실행하지 않는다(삭제·자동 병합 없음).
 */
async function checkNoDuplicateSurveyResponses(connection) {
  const [rows] = await connection.query(
    `SELECT user_id, survey_session_id, question_number, COUNT(*) AS c
     FROM user_survey_responses
     GROUP BY user_id, survey_session_id, question_number
     HAVING COUNT(*) > 1`
  );
  return { duplicates: rows, ok: rows.length === 0 };
}

/**
 * 003 적용 후 user_survey_responses에 (user_id, survey_session_id,
 * question_number) UNIQUE INDEX가 실제로 생성됐는지 information_schema 로
 * 검증한다. 003은 category ENUM을 건드리지 않으므로 ENUM은 검증 대상이 아니다.
 */
async function verifySurveyCodebookSchema(connection, dbName) {
  const [indexRows] = await connection.query(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user_survey_responses' AND INDEX_NAME = ?`,
    [dbName, USER_SURVEY_RESPONSE_EXPECTED_UNIQUE_INDEX]
  );
  const indexOk = indexRows.length > 0;

  return { indexOk, ok: indexOk };
}

/**
 * 004 적용 후 shopify_cart_requests 의 컬럼/타입/ENUM/기본값/인덱스/FK 를
 * information_schema 로 정확히 검증한다. 이름 존재만 확인하지 않는다.
 */
async function verifyShopifyCartRequestsSchema(connection, dbName) {
  const problems = [];

  // 1) 컬럼 존재 + 타입 + nullable
  const [columnRows] = await connection.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shopify_cart_requests'`,
    [dbName]
  );
  const columnsByName = new Map(columnRows.map((r) => [r.COLUMN_NAME, r]));

  for (const [name, expected] of Object.entries(SHOPIFY_CART_EXPECTED_COLUMNS)) {
    const actual = columnsByName.get(name);
    if (!actual) {
      problems.push(`컬럼 누락: ${name}`);
      continue;
    }
    // COLUMN_TYPE 은 'varchar(64)' / 'char(36)' / 'enum(...)' 처럼 길이까지 포함한다.
    const actualType = String(actual.COLUMN_TYPE).toLowerCase();
    const expectedType = expected.type.toLowerCase();
    // MariaDB 는 JSON 을 LONGTEXT 별칭으로 저장하므로 둘 다 허용한다
    // (기존 agent_sessions.context_snapshot 도 longtext 로 보고된다).
    const typeOk =
      expectedType === 'json'
        ? actualType.startsWith('json') || actualType.startsWith('longtext')
        : actualType.startsWith(expectedType);
    if (!typeOk) {
      problems.push(`컬럼 타입 불일치: ${name} (기대 ${expected.type}, 실제 ${actual.COLUMN_TYPE})`);
    }
    if (actual.IS_NULLABLE !== expected.nullable) {
      problems.push(`컬럼 nullable 불일치: ${name} (기대 ${expected.nullable}, 실제 ${actual.IS_NULLABLE})`);
    }
  }

  // 2) status ENUM 값과 순서
  const statusColumn = columnsByName.get('status');
  if (statusColumn) {
    const enumValues = String(statusColumn.COLUMN_TYPE)
      .replace(/^enum\(/i, '')
      .replace(/\)$/, '')
      .split(',')
      .map((v) => v.trim().replace(/^'/, '').replace(/'$/, ''));
    if (enumValues.join('|') !== SHOPIFY_CART_EXPECTED_STATUS_ENUM.join('|')) {
      problems.push(`status ENUM 값/순서 불일치: 실제 [${enumValues.join(', ')}]`);
    }
  }

  // 3) attempt_count 기본값 0
  const attemptColumn = columnsByName.get('attempt_count');
  if (attemptColumn && String(attemptColumn.COLUMN_DEFAULT) !== '0') {
    problems.push(`attempt_count 기본값이 0이 아닙니다: ${attemptColumn.COLUMN_DEFAULT}`);
  }

  // 4) created_at/updated_at 에 DB 자동 기본값/ON UPDATE 가 없어야 한다
  for (const name of SHOPIFY_CART_APP_MANAGED_TIME_COLUMNS) {
    const column = columnsByName.get(name);
    if (!column) continue;
    if (column.COLUMN_DEFAULT !== null) {
      problems.push(`${name} 에 DB 기본값이 설정돼 있습니다(애플리케이션 Clock 이 bind 해야 함): ${column.COLUMN_DEFAULT}`);
    }
    const extra = String(column.EXTRA || '').toLowerCase();
    if (extra.includes('on update')) {
      problems.push(`${name} 에 ON UPDATE 가 설정돼 있습니다(애플리케이션 Clock 이 bind 해야 함)`);
    }
  }

  // 5) 인덱스 이름 + UNIQUE 여부 + 컬럼 구성/순서
  const [indexRows] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shopify_cart_requests'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [dbName]
  );
  const indexesByName = new Map();
  for (const row of indexRows) {
    if (!indexesByName.has(row.INDEX_NAME)) {
      indexesByName.set(row.INDEX_NAME, { unique: row.NON_UNIQUE === 0, columns: [] });
    }
    indexesByName.get(row.INDEX_NAME).columns.push(row.COLUMN_NAME);
  }

  for (const [name, expected] of Object.entries(SHOPIFY_CART_EXPECTED_INDEXES)) {
    const actual = indexesByName.get(name);
    if (!actual) {
      problems.push(`인덱스 누락: ${name}`);
      continue;
    }
    if (actual.unique !== expected.unique) {
      problems.push(`인덱스 UNIQUE 여부 불일치: ${name}`);
    }
    if (actual.columns.join('|') !== expected.columns.join('|')) {
      problems.push(`인덱스 컬럼 구성 불일치: ${name} (실제 [${actual.columns.join(', ')}])`);
    }
  }

  // 6) FK 2개 존재 + 둘 다 ON DELETE CASCADE
  const [fkRows] = await connection.query(
    `SELECT rc.CONSTRAINT_NAME, rc.DELETE_RULE, kcu.REFERENCED_TABLE_NAME
       FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      WHERE rc.CONSTRAINT_SCHEMA = ? AND rc.TABLE_NAME = 'shopify_cart_requests'`,
    [dbName]
  );
  const fkByReferencedTable = new Map(fkRows.map((r) => [r.REFERENCED_TABLE_NAME, r]));
  for (const table of SHOPIFY_CART_EXPECTED_FK_TABLES) {
    const fk = fkByReferencedTable.get(table);
    if (!fk) {
      problems.push(`FK 누락: ${table} 참조`);
      continue;
    }
    if (String(fk.DELETE_RULE).toUpperCase() !== 'CASCADE') {
      problems.push(`FK ON DELETE 규칙 불일치: ${table} (실제 ${fk.DELETE_RULE})`);
    }
  }

  return { problems, ok: problems.length === 0 };
}

/**
 * EXPECTED_AGENT_TABLES 가 실제로 생성됐는지 information_schema 로 검증한다.
 */
async function verifyAgentTablesExist(connection, dbName) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)`,
    [dbName, EXPECTED_AGENT_TABLES]
  );
  const present = new Set(rows.map((r) => r.TABLE_NAME));
  const missing = EXPECTED_AGENT_TABLES.filter((t) => !present.has(t));
  return { present, missing, ok: missing.length === 0 };
}

/**
 * 하나의 Migration SQL 이 안전한지 검사한다.
 * 위반 시 사유 배열을 반환(빈 배열이면 안전).
 */
function findSafetyViolations(rawSql) {
  const sql = stripSqlComments(rawSql);
  const violations = [];

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(sql)) {
      violations.push(`금지된 구문 발견: ${label}`);
    }
  }

  // DROP / CREATE 는 예외 없이 모든 Core 테이블에서 차단
  for (const table of CORE_TABLES) {
    const drop = new RegExp(`\\bDROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?\`?${table}\`?\\b`, 'i');
    const create = new RegExp(`\\bCREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?\`?${table}\`?\\b`, 'i');
    if (drop.test(sql)) violations.push(`Core 테이블 삭제 시도(DROP): ${table}`);
    if (create.test(sql)) violations.push(`Core 테이블 재정의 시도(CREATE): ${table}`);
  }

  // ALTER 는 문장 단위로 검사한다: image_analysis 에 한해서만 좁은 allowlist를 통과하면
  // 허용하고, 그 외 Core 테이블에 대한 ALTER 는 여전히 전부 차단한다.
  for (const statement of splitStatements(sql)) {
    const alterMatch = statement.match(/^ALTER\s+TABLE\s+`?(\w+)`?\b/i);
    if (!alterMatch) continue;

    const tableName = alterMatch[1].toLowerCase();
    if (!CORE_TABLES.includes(tableName)) continue;

    if (tableName === 'image_analysis' && isSafeImageAnalysisAlterStatement(statement)) {
      continue;
    }
    if (
      tableName === 'user_survey_responses' &&
      USER_SURVEY_RESPONSES_ALLOWED_ALTER_STATEMENT.test(statement.trim())
    ) {
      continue;
    }

    violations.push(`Core 테이블 변경 시도(ALTER): ${tableName}`);
  }

  return violations;
}

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migration 디렉터리를 찾을 수 없습니다: ${MIGRATIONS_DIR}`);
  }
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort(); // 001_, 002_ ... 오름차순

  if (files.length === 0) {
    throw new Error('실행할 .sql Migration 파일이 없습니다.');
  }
  return files;
}

async function main(argv = process.argv) {
  const dryRun = argv.includes('--dry-run');

  console.log('🦷 BloomDent Agent Migration 실행기');
  console.log(dryRun ? '   모드: --dry-run (검증만 수행)\n' : '   모드: 실제 적용\n');

  // 1) Migration 파일 로드 + 안전성 검사 (DB 연결 없이 오프라인 검증)
  const files = loadMigrationFiles();
  const loaded = [];
  let hasViolation = false;

  for (const file of files) {
    const full = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(full, 'utf8');
    const violations = findSafetyViolations(sql);
    loaded.push({ file, sql, violations });

    if (violations.length > 0) {
      hasViolation = true;
      console.error(`🚫 ${file} — 안전성 위반:`);
      violations.forEach((v) => console.error(`     - ${v}`));
    } else {
      console.log(`✅ ${file} — 안전성 통과`);
    }
  }
  console.log('');

  if (hasViolation) {
    console.error('❌ 파괴적/Core 변경 구문이 감지되어 Migration을 중단합니다.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('🔎 --dry-run: SQL을 실행하지 않고 검증만 완료했습니다.');
    return;
  }

  // 2) 실제 적용 전 환경 변수 확인
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    console.error('❌ .env 확인 필요: DB_HOST, DB_USER, DB_NAME 가 필요합니다.');
    process.exit(1);
  }
  console.log('📊 대상 DB:');
  console.log(`   Host: ${process.env.DB_HOST}`);
  console.log(`   Port: ${process.env.DB_PORT || 3306}`);
  console.log(`   Database: ${process.env.DB_NAME}`);
  console.log(`   User: ${process.env.DB_USER}\n`);

  // 3) 실제 적용
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      multipleStatements: true, // 한 파일에 여러 CREATE 문
    });
    console.log('✅ DB 연결 성공\n');

    // 003 적용 전 (user_id, survey_session_id, question_number) 중복 여부를
    // 먼저 확인한다. 중복이 있으면 어떤 SQL도 실행하지 않고 중단한다.
    console.log('🔎 user_survey_responses 중복 응답 사전 검사:');
    const dupCheck = await checkNoDuplicateSurveyResponses(connection);
    if (!dupCheck.ok) {
      console.error(`❌ (user_id, survey_session_id, question_number) 중복 ${dupCheck.duplicates.length}건 발견 — Migration을 중단합니다.`);
      dupCheck.duplicates.forEach((d) =>
        console.error(`     - user_id=${d.user_id}, survey_session_id=${d.survey_session_id}, question_number=${d.question_number} (${d.c}건)`)
      );
      process.exit(1);
    }
    console.log('   ✅ 중복 없음\n');

    for (const { file, sql } of loaded) {
      console.log(`🔧 적용 중: ${file}`);
      await connection.query(sql);
      console.log(`   완료: ${file}\n`);
    }

    // 4) 검증: 기대 Agent 테이블 존재 확인
    console.log('📋 Agent 테이블 검증:');
    const tableCheck = await verifyAgentTablesExist(connection, process.env.DB_NAME);
    for (const t of EXPECTED_AGENT_TABLES) {
      console.log(`   ${tableCheck.missing.includes(t) ? '❌' : '✅'} ${t}`);
    }
    console.log('');

    if (!tableCheck.ok) {
      console.error('❌ 일부 Agent 테이블이 생성되지 않았습니다.');
      process.exit(1);
    }

    // 5) 검증: image_analysis 가 002 가 기대하는 컬럼/인덱스를 실제로 갖췄는지 확인
    console.log('📋 image_analysis 스키마 정합성 검증 (002):');
    const schemaCheck = await verifyImageAnalysisSchema(connection, process.env.DB_NAME);
    for (const c of IMAGE_ANALYSIS_EXPECTED_COLUMNS) {
      console.log(`   ${schemaCheck.missingColumns.includes(c) ? '❌' : '✅'} 컬럼 ${c}`);
    }
    console.log(`   ${schemaCheck.imageIdNullable ? '✅' : '❌'} image_id nullable`);
    for (const idx of IMAGE_ANALYSIS_EXPECTED_INDEXES) {
      console.log(`   ${schemaCheck.missingIndexes.includes(idx) ? '❌' : '✅'} 인덱스 ${idx}`);
    }
    console.log('');

    if (!schemaCheck.ok) {
      console.error('❌ image_analysis 스키마가 002 기대값과 일치하지 않습니다.');
      process.exit(1);
    }

    // 6) 검증: 003이 기대하는 UNIQUE INDEX가 실제로 반영됐는지 확인
    console.log('📋 설문 응답 무결성 제약 검증 (003):');
    const surveySchemaCheck = await verifySurveyCodebookSchema(connection, process.env.DB_NAME);
    console.log(`   ${surveySchemaCheck.indexOk ? '✅' : '❌'} user_survey_responses.${USER_SURVEY_RESPONSE_EXPECTED_UNIQUE_INDEX}`);
    console.log('');

    if (!surveySchemaCheck.ok) {
      console.error('❌ 설문 응답 무결성 제약이 003 기대값과 일치하지 않습니다.');
      process.exit(1);
    }

    // 7) 검증: 004 shopify_cart_requests 의 정확한 스키마(컬럼/타입/ENUM/기본값/인덱스/FK)
    console.log('📋 shopify_cart_requests 스키마 정합성 검증 (004):');
    const shopifyCartSchemaCheck = await verifyShopifyCartRequestsSchema(connection, process.env.DB_NAME);
    if (shopifyCartSchemaCheck.ok) {
      console.log('   ✅ 컬럼/타입/ENUM 순서/기본값/인덱스/FK CASCADE 모두 일치');
    } else {
      shopifyCartSchemaCheck.problems.forEach((p) => console.error(`   ❌ ${p}`));
    }
    console.log('');

    if (!shopifyCartSchemaCheck.ok) {
      console.error('❌ shopify_cart_requests 스키마가 004 기대값과 일치하지 않습니다.');
      process.exit(1);
    }

    console.log('🎉 Agent Migration 적용 및 검증 완료.');
  } catch (error) {
    console.error('\n❌ Migration 실행 중 오류:');
    console.error(error.message);
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('💡 DB_USER / DB_PASSWORD 를 확인하세요.');
    } else if (error.code === 'ENOTFOUND') {
      console.error('💡 DB_HOST 를 확인하세요.');
    }
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

// 직접 실행할 때만 main() 을 호출한다. (require 시에는 순수 함수만 노출)
if (require.main === module) {
  main();
}

module.exports = {
  stripSqlComments,
  splitStatements,
  isSafeImageAnalysisAlterStatement,
  findSafetyViolations,
  loadMigrationFiles,
  verifyImageAnalysisSchema,
  verifyAgentTablesExist,
  checkNoDuplicateSurveyResponses,
  verifySurveyCodebookSchema,
  verifyShopifyCartRequestsSchema,
  SHOPIFY_CART_EXPECTED_COLUMNS,
  SHOPIFY_CART_EXPECTED_STATUS_ENUM,
  SHOPIFY_CART_EXPECTED_INDEXES,
  SHOPIFY_CART_EXPECTED_FK_TABLES,
  SHOPIFY_CART_APP_MANAGED_TIME_COLUMNS,
  EXPECTED_AGENT_TABLES,
  IMAGE_ANALYSIS_EXPECTED_COLUMNS,
  IMAGE_ANALYSIS_EXPECTED_INDEXES,
  IMAGE_ANALYSIS_NULLABLE_COLUMN,
  USER_SURVEY_RESPONSES_ALLOWED_ALTER_STATEMENT,
  USER_SURVEY_RESPONSE_EXPECTED_UNIQUE_INDEX,
  CORE_TABLES,
  MIGRATIONS_DIR,
};
