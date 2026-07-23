/**
 * database/verify-shopify-cart-scratch-db.js
 * ----------------------------------------------------------------------------
 * shopify_cart_requests(Migration 004) 스키마와 Repository 의 조건부 UPDATE
 * 의미를 실제 DB 로 검증한다. 실제 Shopify API 는 호출하지 않는다.
 *
 * verify-migration-scratch-db.js 와 동일한 안전 원칙:
 *   - 하드코딩된 스크래치 DB 이름만 대상으로 한다.
 *   - .env 의 실 개발 DB(DB_NAME)는 어떤 단계에서도 건드리지 않는다.
 *   - DROP DATABASE 직전에 이름을 재검증한다.
 *
 * 사용법: node database/verify-shopify-cart-scratch-db.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  loadMigrationFiles,
  findSafetyViolations,
  verifyAgentTablesExist,
  verifyShopifyCartRequestsSchema,
  MIGRATIONS_DIR,
} = require('./run-migration');

const ALLOWED_SCRATCH_DB_NAMES = ['bloomdent_shopify_cart_verify'];
const SCRATCH_DB_NAME = 'bloomdent_shopify_cart_verify';

function assertScratchDbNameAllowed(name) {
  if (!ALLOWED_SCRATCH_DB_NAMES.includes(name)) {
    throw new Error(`허용되지 않은 스크래치 DB 이름: "${name}". 허용 목록: [${ALLOWED_SCRATCH_DB_NAMES.join(', ')}]`);
  }
}

let passed = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`❌ [${name}] 실패${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✅ ${name}`);
}

async function applySqlFile(connection, filePath, label) {
  const sql = fs.readFileSync(filePath, 'utf8');
  await connection.query(sql);
  console.log(`   완료: ${label}`);
}

async function main() {
  assertScratchDbNameAllowed(SCRATCH_DB_NAME);
  const realDbName = process.env.DB_NAME;
  if (realDbName && realDbName === SCRATCH_DB_NAME) {
    throw new Error('.env DB_NAME 이 스크래치 DB 이름과 동일합니다. 중단합니다.');
  }
  if (!process.env.DB_HOST || !process.env.DB_USER) {
    throw new Error('.env 확인 필요: DB_HOST, DB_USER');
  }

  console.log('🛒 shopify_cart_requests — 스크래치 DB 검증 (실제 Shopify 호출 0회)\n');
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
    // 1) setup + migration 001~004
    console.log(`🧪 스크래치 DB 생성: ${SCRATCH_DB_NAME}`);
    await adminConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${SCRATCH_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await adminConn.query(`USE \`${SCRATCH_DB_NAME}\``);
    await applySqlFile(adminConn, path.join(__dirname, 'schema.sql'), 'schema.sql');
    await applySqlFile(adminConn, path.join(__dirname, 'seed_data.sql'), 'seed_data.sql');

    console.log('\n🔧 Migration 적용 (001~004)...');
    for (const file of loadMigrationFiles()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const violations = findSafetyViolations(sql);
      if (violations.length > 0) throw new Error(`${file} 안전성 위반: ${violations.join(', ')}`);
      await adminConn.query(sql);
      console.log(`   완료: ${file}`);
    }
    check('1. Migration 004 적용', true);

    const tableCheck = await verifyAgentTablesExist(adminConn, SCRATCH_DB_NAME);
    check('Agent 테이블 5개 존재(shopify_cart_requests 포함)', tableCheck.ok, tableCheck.missing.join(','));

    const schemaCheck = await verifyShopifyCartRequestsSchema(adminConn, SCRATCH_DB_NAME);
    check('004 정확한 스키마(컬럼/타입/ENUM/기본값/인덱스/FK CASCADE)', schemaCheck.ok, schemaCheck.problems.join(' | '));

    // Repository 를 스크래치 DB pool 로 로드
    process.env.DB_NAME = SCRATCH_DB_NAME;
    const { pool } = require('../config/database');
    const repo = require('../agent/repositories/shopifyCartRepository');

    // Agent Session fixture (FK 대상)
    const userId = 1;
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO agent_sessions (id, user_id, history_id, survey_session_id, status, context_snapshot, context_hash, model_name, prompt_version, idempotency_key)
       VALUES (?, ?, 'shopify-verify-history', NULL, 'ready', ?, ?, 'template-only', 'v0', ?)`,
      [sessionId, userId, JSON.stringify({ images: [] }), 'c'.repeat(64), `shopify-verify-${sessionId}`]
    );

    const NOW = new Date('2026-07-23T00:00:00.000Z');
    const baseClaim = {
      userId,
      sessionId,
      requestHash: 'r'.repeat(64),
      proposalHash: 'p'.repeat(64),
      shopifyConfigFingerprint: 'f'.repeat(64),
      selectedItems: [{ product_key: 'TOOTHBRUSH_SOFT', quantity: 1 }],
    };

    // 2) 정상 pending INSERT
    const id1 = crypto.randomUUID();
    await repo.insertPendingClaim({ ...baseClaim, id: id1, idempotencyKeyHash: 'a'.repeat(64), now: NOW });
    const row1 = await repo.findById(id1);
    check('2. 정상 pending INSERT', row1.status === 'pending' && row1.attempt_count === 0 && row1.external_call_started_at === null);

    // 3) 같은 user_id + 같은 hash 중복 차단
    let duplicateBlocked = false;
    try {
      await repo.insertPendingClaim({ ...baseClaim, id: crypto.randomUUID(), idempotencyKeyHash: 'a'.repeat(64), now: NOW });
    } catch (error) {
      duplicateBlocked = error.code === 'SHOPIFY_CART_CLAIM_CONFLICT' && error.existingRow && error.existingRow.id === id1;
    }
    check('3. 같은 user_id + 같은 idempotency_key_hash 중복 차단(기존 행 반환)', duplicateBlocked);

    // 4) 다른 user_id + 같은 hash 허용
    const otherUserId = 2;
    const otherSessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO agent_sessions (id, user_id, history_id, survey_session_id, status, context_snapshot, context_hash, model_name, prompt_version, idempotency_key)
       VALUES (?, ?, 'shopify-verify-history-2', NULL, 'ready', ?, ?, 'template-only', 'v0', ?)`,
      [otherSessionId, otherUserId, JSON.stringify({ images: [] }), 'd'.repeat(64), `shopify-verify-${otherSessionId}`]
    );
    const idOther = crypto.randomUUID();
    await repo.insertPendingClaim({
      ...baseClaim, id: idOther, userId: otherUserId, sessionId: otherSessionId, idempotencyKeyHash: 'a'.repeat(64), now: NOW,
    });
    check('4. 다른 user_id + 같은 hash 는 허용된다', (await repo.findById(idOther)) !== null);

    // 5~7) dispatch claim
    const affected1 = await repo.markExternalCallStarted({ id: id1, now: NOW });
    check('5. external_call_started_at 조건부 UPDATE affectedRows=1', affected1 === 1);
    const affected2 = await repo.markExternalCallStarted({ id: id1, now: NOW });
    check('6. 두 번째 dispatch claim 은 affectedRows=0(중복 호출 차단)', affected2 === 0);
    const afterClaim = await repo.findById(id1);
    check('7. attempt_count=1 로 기록된다', afterClaim.attempt_count === 1 && afterClaim.external_call_started_at !== null);

    // 8) succeeded 조건부 UPDATE + 12) 금액 저장
    const succeededAffected = await repo.markSucceeded({
      id: id1,
      shopifyCartId: 'gid://shopify/Cart/verify',
      checkoutUrl: 'https://demo-store.myshopify.com/checkout/verify',
      estimatedTotalAmount: '18.97',
      estimatedTotalCurrencyCode: 'USD',
      estimatedTotalIsEstimated: true,
      warningCodes: ['MERCHANDISE_NOT_ENOUGH_STOCK'],
      now: NOW,
    });
    check('8. succeeded 조건부 UPDATE affectedRows=1', succeededAffected === 1);

    const succeededRow = await repo.findById(id1);
    check(
      '12. 금액/통화/estimated flag 가 저장된다(Decimal 문자열 보존)',
      succeededRow.estimated_total_amount === '18.97' &&
        succeededRow.estimated_total_currency_code === 'USD' &&
        Number(succeededRow.estimated_total_is_estimated) === 1,
      JSON.stringify({
        amount: succeededRow.estimated_total_amount,
        currency: succeededRow.estimated_total_currency_code,
        estimated: succeededRow.estimated_total_is_estimated,
      })
    );
    check(
      'succeeded 불변조건(오류 컬럼 전부 NULL, completed_at 존재)',
      succeededRow.normalized_error_code === null &&
        succeededRow.normalized_http_status === null &&
        succeededRow.safe_error_details_json === null &&
        succeededRow.completed_at !== null
    );

    // 11) terminal 상태에서 추가 UPDATE 차단
    const afterTerminal = await repo.markTerminalError({
      id: id1, status: 'failed', normalizedErrorCode: 'X', normalizedHttpStatus: 500, safeErrorDetails: null, now: NOW,
    });
    check('11. terminal(succeeded) 상태에서 추가 UPDATE 는 affectedRows=0', afterTerminal === 0);
    check('   succeeded 값이 변조되지 않았다', (await repo.findById(id1)).status === 'succeeded');

    // 13) succeeded 결과 재조회·재현
    const reproduced = await repo.findByIdempotency(userId, 'a'.repeat(64));
    check(
      '13. succeeded 결과를 Idempotency 로 재조회해 그대로 재현할 수 있다',
      reproduced.id === id1 && reproduced.checkout_url === 'https://demo-store.myshopify.com/checkout/verify'
    );

    // 9) failed 조건부 UPDATE
    const id2 = crypto.randomUUID();
    await repo.insertPendingClaim({ ...baseClaim, id: id2, idempotencyKeyHash: 'b'.repeat(64), now: NOW });
    const failedAffected = await repo.markTerminalError({
      id: id2, status: 'failed', normalizedErrorCode: 'SHOPIFY_USER_ERROR', normalizedHttpStatus: 422,
      safeErrorDetails: { category: 'CART_INPUT' }, now: NOW,
    });
    const failedRow = await repo.findById(id2);
    check(
      '9. failed 조건부 UPDATE + 금액 컬럼은 NULL 유지',
      failedAffected === 1 && failedRow.status === 'failed' && failedRow.estimated_total_amount === null && failedRow.checkout_url === null
    );

    // 10) outcome_unknown 조건부 UPDATE
    const id3 = crypto.randomUUID();
    await repo.insertPendingClaim({ ...baseClaim, id: id3, idempotencyKeyHash: 'c'.repeat(64), now: NOW });
    await repo.markExternalCallStarted({ id: id3, now: NOW });
    const unknownAffected = await repo.markTerminalError({
      id: id3, status: 'outcome_unknown', normalizedErrorCode: 'SHOPIFY_CART_OUTCOME_UNKNOWN',
      normalizedHttpStatus: 502, safeErrorDetails: { category: 'TIMEOUT' }, now: NOW,
    });
    check('10. outcome_unknown 조건부 UPDATE affectedRows=1', unknownAffected === 1);

    // stale A/B 전이 (주입 시각만 사용, 실제 sleep 없음)
    const idStaleA = crypto.randomUUID();
    const staleCreatedAt = new Date(NOW.getTime() - 120000);
    await repo.insertPendingClaim({ ...baseClaim, id: idStaleA, idempotencyKeyHash: 'e'.repeat(64), now: staleCreatedAt });
    const staleAAffected = await repo.expireStaleBeforeDispatch({
      id: idStaleA, beforeDispatchCutoff: new Date(NOW.getTime() - 60000), now: NOW,
    });
    const staleARow = await repo.findById(idStaleA);
    check(
      'stale A(호출 전, created_at 기준) → failed 전이',
      staleAAffected === 1 && staleARow.status === 'failed' && staleARow.normalized_error_code === 'SHOPIFY_CART_ABORTED_BEFORE_DISPATCH'
    );

    const idStaleB = crypto.randomUUID();
    await repo.insertPendingClaim({ ...baseClaim, id: idStaleB, idempotencyKeyHash: 'f'.repeat(64), now: NOW });
    await repo.markExternalCallStarted({ id: idStaleB, now: new Date(NOW.getTime() - 120000) });
    const staleBAffected = await repo.expireStaleAfterDispatch({
      id: idStaleB, afterDispatchCutoff: new Date(NOW.getTime() - 60000), now: NOW,
    });
    const staleBRow = await repo.findById(idStaleB);
    check(
      'stale B(호출 후, external_call_started_at 기준) → outcome_unknown 전이',
      staleBAffected === 1 && staleBRow.status === 'outcome_unknown'
    );

    // created_at 은 오래됐지만 external_call_started_at 이 최근이면 stale B 로 전이되지 않아야 한다
    const idFresh = crypto.randomUUID();
    await repo.insertPendingClaim({ ...baseClaim, id: idFresh, idempotencyKeyHash: '1'.repeat(64), now: new Date(NOW.getTime() - 200000) });
    await repo.markExternalCallStarted({ id: idFresh, now: NOW });
    const freshAffected = await repo.expireStaleAfterDispatch({
      id: idFresh, afterDispatchCutoff: new Date(NOW.getTime() - 60000), now: NOW,
    });
    check(
      'created_at 이 오래돼도 external_call_started_at 이 최근이면 stale 로 뒤집히지 않는다',
      freshAffected === 0 && (await repo.findById(idFresh)).status === 'pending'
    );

    // 14) Session 삭제 시 Cascade
    const [beforeSessionDelete] = await pool.query('SELECT COUNT(*) AS c FROM shopify_cart_requests WHERE session_id = ?', [sessionId]);
    await pool.query('DELETE FROM agent_sessions WHERE id = ?', [sessionId]);
    const [afterSessionDelete] = await pool.query('SELECT COUNT(*) AS c FROM shopify_cart_requests WHERE session_id = ?', [sessionId]);
    check(
      '14. agent_sessions 삭제 시 CASCADE 로 함께 삭제된다',
      beforeSessionDelete[0].c > 0 && afterSessionDelete[0].c === 0
    );

    // 15) User 삭제 시 Cascade
    const [beforeUserDelete] = await pool.query('SELECT COUNT(*) AS c FROM shopify_cart_requests WHERE user_id = ?', [otherUserId]);
    await pool.query('DELETE FROM users WHERE id = ?', [otherUserId]);
    const [afterUserDelete] = await pool.query('SELECT COUNT(*) AS c FROM shopify_cart_requests WHERE user_id = ?', [otherUserId]);
    check('15. users 삭제 시 CASCADE 로 함께 삭제된다', beforeUserDelete[0].c > 0 && afterUserDelete[0].c === 0);

    // 16) fixture 삭제
    await pool.query('DELETE FROM shopify_cart_requests');
    await pool.query('DELETE FROM agent_sessions');
    const [remaining] = await pool.query('SELECT COUNT(*) AS c FROM shopify_cart_requests');
    check('16. fixture 완전 삭제', remaining[0].c === 0);

    await pool.end();

    console.log(`\n🎉 shopify_cart_requests 스크래치 DB 검증 완료 (${passed}개 체크 통과).`);
  } finally {
    // 17) 스크래치 DB 삭제
    assertScratchDbNameAllowed(SCRATCH_DB_NAME);
    console.log(`\n🧹 스크래치 DB 정리: DROP DATABASE ${SCRATCH_DB_NAME}`);
    await adminConn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB_NAME}\``);
    console.log('   완료.');
    await adminConn.end();
    if (realDbName) process.env.DB_NAME = realDbName;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ 스크래치 DB 검증 실패:');
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { ALLOWED_SCRATCH_DB_NAMES, SCRATCH_DB_NAME, assertScratchDbNameAllowed };
