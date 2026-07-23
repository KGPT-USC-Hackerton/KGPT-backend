/**
 * middleware/jsonParseErrorHandler.test.js
 * ----------------------------------------------------------------------------
 * 1) isJsonParseError 순수 함수에 대한 오프라인 테스트(mock 에러 객체).
 * 2) 실제 Express + express.json()을 임시 서버로 띄워 진짜 malformed JSON
 *    HTTP 요청을 보내고 400/VALIDATION_ERROR/무노출을 확인하는 통합 테스트.
 *    (server.js 전체를 require하지 않는다 — DB 연결/app.listen(PORT)을
 *    트리거하지 않도록, 동일한 미들웨어 체인만 별도 임시 앱으로 재구성한다.)
 *
 * 실행: node middleware/jsonParseErrorHandler.test.js
 */

const assert = require('node:assert');
const express = require('express');

const jsonParseErrorHandler = require('./jsonParseErrorHandler');
const { isJsonParseError } = jsonParseErrorHandler;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('jsonParseErrorHandler 테스트\n');

// ---------------------------------------------------------------------------
// 1) isJsonParseError 순수 함수
// ---------------------------------------------------------------------------

test('type이 entity.parse.failed 이면 true', () => {
  assert.strictEqual(isJsonParseError({ type: 'entity.parse.failed', status: 400 }), true);
});

test('SyntaxError + status 400 + body 프로퍼티가 있으면 true', () => {
  const err = new SyntaxError('Unexpected token');
  err.status = 400;
  err.body = '{bad';
  assert.strictEqual(isJsonParseError(err), true);
});

test('일반 SyntaxError(body 파싱과 무관)는 false', () => {
  const err = new SyntaxError('some other syntax error');
  assert.strictEqual(isJsonParseError(err), false);
});

test('일반 애플리케이션 에러(Error, status 500)는 false', () => {
  const err = new Error('DB connection failed');
  err.status = 500;
  assert.strictEqual(isJsonParseError(err), false);
});

test('null/undefined는 false', () => {
  assert.strictEqual(isJsonParseError(null), false);
  assert.strictEqual(isJsonParseError(undefined), false);
});

// ---------------------------------------------------------------------------
// 2) 실제 Express 앱 + 진짜 malformed JSON HTTP 요청
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/echo', (req, res) => {
    res.status(200).json({ success: true, received: req.body });
  });
  app.use((req, res) => {
    res.status(404).json({ success: false, message: 'not found' });
  });
  // server.js와 동일한 순서: jsonParseErrorHandler가 일반 500 핸들러보다 먼저.
  app.use(jsonParseErrorHandler);
  app.use((err, req, res, next) => {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  });
  return app;
}

async function withTestServer(fn) {
  const app = buildTestApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  await test('malformed JSON 요청은 400 + VALIDATION_ERROR + 안전한 메시지를 반환한다', async () => {
    await withTestServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      });
      const bodyText = await res.text();
      const body = JSON.parse(bodyText);

      assert.strictEqual(res.status, 400);
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error_code, 'VALIDATION_ERROR');
      assert.strictEqual(body.message, '올바른 JSON 요청 본문이 필요합니다.');

      // 원본 parser 메시지/stack/요청 body가 응답 어디에도 없어야 한다.
      assert.ok(!bodyText.includes('Expected property name'));
      assert.ok(!bodyText.includes('at position'));
      assert.ok(!bodyText.includes('stack'));
      assert.ok(!bodyText.includes('{bad json'));
      assert.strictEqual(Object.keys(body).sort().join(','), 'error_code,message,success');
    });
  });

  await test('정상 JSON 요청은 기존과 동일하게 200으로 정상 처리된다', async () => {
    await withTestServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.success, true);
      assert.deepStrictEqual(body.received, { hello: 'world' });
    });
  });

  await test('body 없는 요청(Content-Length 0)은 malformed로 취급되지 않는다', async () => {
    await withTestServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      });
      assert.strictEqual(res.status, 200);
    });
  });

  console.log(`\n🎉 ${passed}개 테스트 통과`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
