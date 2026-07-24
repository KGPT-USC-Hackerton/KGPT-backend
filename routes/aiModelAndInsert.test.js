// 실행 코드에 대한 정적 회귀 테스트.
// 실제 Gemini / Shopify / DB 를 호출하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const aiSource = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');
const imagesSource = fs.readFileSync(path.join(ROOT, 'routes', 'images.js'), 'utf8');
const tipsSource = fs.readFileSync(path.join(ROOT, 'services', 'oralTipsService.js'), 'utf8');

const MODEL_EXPR = /process\.env\.GEMINI_MODEL\s*\|\|\s*['"]gemini-2\.5-flash['"]/;

test('routes/ai.js 의 모든 generateContent 호출이 GEMINI_MODEL 을 사용한다', () => {
  const modelLines = aiSource.split('\n').filter((line) => /^\s*model:/.test(line));
  assert.ok(modelLines.length >= 5, `model: 지정이 5곳 이상이어야 함 (현재 ${modelLines.length})`);
  for (const line of modelLines) {
    assert.match(line, MODEL_EXPR);
  }
});

test('services/oralTipsService.js 도 GEMINI_MODEL 을 사용한다', () => {
  const modelLines = tipsSource.split('\n').filter((line) => /^\s*model:/.test(line));
  assert.strictEqual(modelLines.length, 1);
  assert.match(modelLines[0], MODEL_EXPR);
});

test('실행 코드에 gemini-2.0-flash 하드코딩이 남아 있지 않다', () => {
  const targets = [
    ['routes/ai.js', aiSource],
    ['routes/images.js', imagesSource],
    ['services/oralTipsService.js', tipsSource],
  ];
  for (const [name, source] of targets) {
    assert.ok(!source.includes('gemini-2.0-flash'), `${name} 에 gemini-2.0-flash 가 남아 있음`);
  }
});

// ---------------------------------------------------------------------------
// image_analysis INSERT 회귀
// ---------------------------------------------------------------------------

function extractInsertStatement(source) {
  const start = source.indexOf('INSERT INTO image_analysis');
  assert.ok(start !== -1, 'INSERT INTO image_analysis 를 찾지 못했습니다.');
  // 백틱 템플릿 리터럴의 끝까지
  const end = source.indexOf('`', start);
  return source.slice(start, end);
}

test('image_analysis INSERT 에 소유 정보 컬럼이 모두 포함된다', () => {
  const statement = extractInsertStatement(imagesSource);
  for (const column of ['user_id', 'history_id', 'image_type', 'analysis_status']) {
    assert.ok(statement.includes(column), `INSERT 에 ${column} 이 없습니다.`);
  }
});

test('INSERT 컬럼 수와 placeholder 수가 일치한다', () => {
  const statement = extractInsertStatement(imagesSource);
  const columnPart = statement.slice(statement.indexOf('(') + 1, statement.indexOf(')'));
  const columns = columnPart
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const valuesPart = statement.slice(statement.indexOf('VALUES'));
  const placeholders = (valuesPart.match(/\?/g) || []).length;

  assert.strictEqual(columns.length, placeholders, `컬럼 ${columns.length}개 / placeholder ${placeholders}개`);
  assert.strictEqual(columns[0], 'image_id');
  assert.strictEqual(columns[1], 'user_id');
  assert.strictEqual(columns[2], 'history_id');
  assert.strictEqual(columns[3], 'image_type');
  assert.strictEqual(columns[4], 'analysis_status');
});

test('INSERT 값 배열이 컬럼 순서와 맞고 analysis_status 는 completed 다', () => {
  const start = imagesSource.indexOf('INSERT INTO image_analysis');
  const tail = imagesSource.slice(start, start + 1600);
  const valuesStart = tail.indexOf('[');
  const valuesEnd = tail.indexOf(']');
  const values = tail
    .slice(valuesStart + 1, valuesEnd)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  assert.strictEqual(values[0], 'imageInfo.id');
  assert.strictEqual(values[1], 'imageInfo.user_id');
  assert.strictEqual(values[2], 'history_id');
  assert.strictEqual(values[3], 'position');
  assert.strictEqual(values[4], '"completed"');
  // 기존 분석 결과 컬럼이 사라지지 않았는지
  assert.ok(values.includes('analysisResult.raw_response'));
  assert.ok(values.includes('analysisResult.analyzed_image_url'));
});

test('llm_summary UPDATE 조건 컬럼이 INSERT 로 채워지는 컬럼에 모두 포함된다', () => {
  // routes/ai.js 는 user_id / history_id / image_type 으로 행을 찾아 llm_summary 를 갱신한다.
  const updateBlock = aiSource.slice(aiSource.indexOf('SET llm_summary'));
  const whereKeys = ['user_id = ?', 'history_id = ?', 'image_type = ?'];
  for (const key of whereKeys) {
    assert.ok(updateBlock.includes(key), `UPDATE WHERE 에 ${key} 가 없습니다.`);
  }

  const statement = extractInsertStatement(imagesSource);
  for (const column of ['user_id', 'history_id', 'image_type']) {
    assert.ok(statement.includes(column), `INSERT 가 ${column} 을 채우지 않아 UPDATE 가 0행이 됩니다.`);
  }
});

test('routes/ai.js 는 공유 파서를 사용하고 인라인 중복 정의가 없다', () => {
  assert.ok(aiSource.includes("require(\"../utils/parseCavityLocations\")"));
  assert.ok(!aiSource.includes('cavity_locations JSON parse error'));
});
