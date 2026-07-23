/**
 * database/run-seed.js
 * ----------------------------------------------------------------------------
 * 구강검진 문진표(oral-health-questionnaire-v1) Codebook과 팀 KGPT-backend 정본
 * 설문(database/seed_survey_questionnaire.sql)이 일치하는지 검증하는 실행기.
 *
 * 통합 정책(팀 결정):
 *   - 팀 설문이 source of truth이므로 이 스크립트는 설문을 Seed(INSERT)하지
 *     않는다. 팀의 공식 setup/seed(database/seed_survey_questionnaire.sql)가
 *     survey_questions/survey_question_options를 채운다.
 *   - 이 스크립트는 "검증 전용"이다:
 *       * 테이블이 비어 있으면 자동 Seed하지 않고, 팀 setup/seed를 먼저
 *         실행하라는 안전한 오류로 중단한다(쓰기 0).
 *       * 팀 정본 15문항이 정확히 존재하면(구조 + Codebook checksum 일치)
 *         통과한다.
 *       * 다른 설문이 존재하면 자동 수정·삭제하지 않고 불일치 오류로 중단한다.
 *   - DELETE / TRUNCATE / DROP / INSERT 를 전혀 실행하지 않는다.
 *   - Codebook checksum은 팀 정본의 실제 category/score를 그대로 반영하므로,
 *     DB에서 읽은 실제 category/score와 대조해 내용 일치를 검증한다.
 *
 * 사용법:
 *   node database/run-seed.js              # 검증 실행
 *   node database/run-seed.js --dry-run    # 동일하게 검증만(항상 쓰기 없음)
 */

require('dotenv').config();
const { pool } = require('../config/database');
const {
  CODEBOOK_VERSION,
  CODEBOOK_CHECKSUM,
  QUESTIONS,
  computeCodebookChecksum,
} = require('../agent/catalog/surveyCodebook');

/**
 * 현재 DB에 있는 survey_questions/survey_question_options 내용을
 * buildChecksumInput()과 동일한 shape으로 읽어온다. DB에 아무 것도 없으면
 * { questions: [] }를 반환한다.
 */
async function readCurrentDbContentShape(connection) {
  const [questionRows] = await connection.query(
    'SELECT question_number, question_text, max_score FROM survey_questions ORDER BY question_number'
  );
  if (questionRows.length === 0) {
    return { codebook_version: CODEBOOK_VERSION, questions: [] };
  }

  const [optionRows] = await connection.query(
    'SELECT question_number, option_number, option_text, category, score FROM survey_question_options ORDER BY question_number, option_number'
  );

  const optionsByQuestion = new Map();
  for (const row of optionRows) {
    if (!optionsByQuestion.has(row.question_number)) optionsByQuestion.set(row.question_number, []);
    optionsByQuestion.get(row.question_number).push({
      option_number: row.option_number,
      // DB에는 answer_code가 없다(Agent 전용 매핑) — checksum 비교 목적상
      // question_number/option_number로 codebook을 다시 찾아 answer_code를 채운다.
      option_text: row.option_text,
      category: row.category,
      score: Number(row.score),
    });
  }

  const questions = questionRows.map((q) => ({
    question_number: q.question_number,
    question_text: q.question_text,
    max_score: Number(q.max_score),
    options: optionsByQuestion.get(q.question_number) || [],
  }));

  return { codebook_version: CODEBOOK_VERSION, questions };
}

/**
 * readCurrentDbContentShape()의 결과에 codebook의 question_code/answer_code를
 * 채워 buildChecksumInput()과 완전히 동일한 shape으로 만든다. DB 콘텐츠가
 * codebook과 question_number/option_number 구성 자체가 다르면(문항 개수,
 * 옵션 개수 불일치 등) null을 반환해 checksum 비교 없이 즉시 불일치로 처리한다.
 */
function attachCodebookIdentifiers(dbShape) {
  const byNumber = new Map(QUESTIONS.map((q) => [q.question_number, q]));
  const attached = [];
  for (const dbQuestion of dbShape.questions) {
    const codebookQuestion = byNumber.get(dbQuestion.question_number);
    if (!codebookQuestion) return null;
    if (dbQuestion.options.length !== codebookQuestion.options.length) return null;

    const optionsByNumber = new Map(codebookQuestion.options.map((o) => [o.option_number, o]));
    const options = [];
    for (const dbOption of dbQuestion.options) {
      const codebookOption = optionsByNumber.get(dbOption.option_number);
      if (!codebookOption) return null;
      options.push({
        option_number: dbOption.option_number,
        answer_code: codebookOption.answer_code,
        option_text: dbOption.option_text,
        category: dbOption.category,
        score: dbOption.score,
      });
    }
    attached.push({
      question_number: dbQuestion.question_number,
      question_code: codebookQuestion.question_code,
      question_text: dbQuestion.question_text,
      max_score: dbQuestion.max_score,
      options,
    });
  }
  return { codebook_version: CODEBOOK_VERSION, questions: attached };
}

async function verifySeed(connection) {
  const [countRows] = await connection.query('SELECT COUNT(*) AS c FROM survey_questions');
  const questionCount = countRows[0].c;

  const [optionCountRows] = await connection.query(
    'SELECT question_number, COUNT(*) AS c FROM survey_question_options GROUP BY question_number'
  );
  const optionCountByQuestion = new Map(optionCountRows.map((r) => [r.question_number, r.c]));

  const mismatchedOptionCounts = QUESTIONS.filter(
    (q) => (optionCountByQuestion.get(q.question_number) || 0) !== q.options.length
  ).map((q) => q.question_number);

  const dbShape = await readCurrentDbContentShape(connection);
  const attached = attachCodebookIdentifiers(dbShape);
  const actualChecksum = attached ? computeCodebookChecksum(attached.questions) : null;

  return {
    questionCount,
    expectedQuestionCount: QUESTIONS.length,
    mismatchedOptionCounts,
    actualChecksum,
    expectedChecksum: CODEBOOK_CHECKSUM,
    ok:
      questionCount === QUESTIONS.length &&
      mismatchedOptionCounts.length === 0 &&
      actualChecksum === CODEBOOK_CHECKSUM,
  };
}

async function main(argv = process.argv) {
  const dryRun = argv.includes('--dry-run');

  console.log('🦷 BloomDent 문진표 Codebook 검증기 (검증 전용 — Seed하지 않음)');
  console.log(`   codebook_version: ${CODEBOOK_VERSION}`);
  console.log(`   expected checksum: ${CODEBOOK_CHECKSUM}`);
  if (dryRun) console.log('   모드: --dry-run');
  console.log('');

  const connection = await pool.getConnection();
  try {
    const [countRows] = await connection.query('SELECT COUNT(*) AS c FROM survey_questions');
    const existingCount = countRows[0].c;

    if (existingCount === 0) {
      // 자동 Seed하지 않는다. 팀 공식 setup/seed를 먼저 적용해야 한다.
      console.error('❌ survey_questions가 비어 있습니다.');
      console.error('   이 스크립트는 설문을 Seed하지 않습니다(팀 설문이 정본).');
      console.error('   먼저 팀 공식 setup/seed를 적용하세요:');
      console.error('     - database/schema.sql (setup-database.js)');
      console.error('     - database/seed_survey_questionnaire.sql');
      console.error('   그 후 이 검증기를 다시 실행하세요.');
      process.exit(1);
    }

    console.log(`ℹ️  survey_questions에 ${existingCount}행이 있습니다 — 팀 정본 Codebook과 대조합니다.`);
    const dbShape = await readCurrentDbContentShape(connection);
    const attached = attachCodebookIdentifiers(dbShape);
    if (!attached) {
      console.error('❌ 기존 설문이 Codebook과 문항/옵션 구성 자체가 다릅니다 — 수정·삭제 없이 중단합니다.');
      process.exit(1);
    }
    const actualChecksum = computeCodebookChecksum(attached.questions);
    if (actualChecksum !== CODEBOOK_CHECKSUM) {
      console.error('❌ AGENT_SURVEY_CODEBOOK_MISMATCH: 기존 설문의 checksum이 기대값과 다릅니다 — 수정·삭제 없이 중단합니다.');
      console.error(`   기대: ${CODEBOOK_CHECKSUM}`);
      console.error(`   실제: ${actualChecksum}`);
      process.exit(1);
    }

    console.log('\n📋 검증:');
    const verification = await verifySeed(connection);
    console.log(`   ${verification.questionCount === verification.expectedQuestionCount ? '✅' : '❌'} 문항 개수: ${verification.questionCount}/${verification.expectedQuestionCount}`);
    console.log(`   ${verification.mismatchedOptionCounts.length === 0 ? '✅' : '❌'} 문항별 옵션 개수 일치`);
    console.log(`   ${verification.actualChecksum === verification.expectedChecksum ? '✅' : '❌'} Codebook checksum 일치(팀 정본 category/score 포함)`);

    if (!verification.ok) {
      console.error('\n❌ AGENT_SURVEY_CODEBOOK_MISMATCH: 설문 검증에 실패했습니다.');
      process.exit(1);
    }

    console.log('\n🎉 팀 정본 설문이 Agent Codebook과 일치합니다(검증 통과, 쓰기 0).');
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('\n❌ 검증 실행 중 오류:', error.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = {
  readCurrentDbContentShape,
  attachCodebookIdentifiers,
  verifySeed,
};
