'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCodexAdapter,
  buildReviewPrompt,
  parseFindings,
} = require('../scripts/cross-review/codex-adapter.js');

test('buildReviewPrompt — plan target', () => {
  const p = buildReviewPrompt({
    target: 'plan',
    artifacts: ['TASKS.md', 'API_CONTRACT.md'],
    context: 'auth 모듈',
  });
  assert.match(p, /설계 \(plan\)/);
  assert.match(p, /TASKS\.md/);
  assert.match(p, /auth 모듈/);
});

test('buildReviewPrompt — code target', () => {
  const p = buildReviewPrompt({
    target: 'code',
    artifacts: ['HEAD~2..HEAD'],
    context: '',
  });
  assert.match(p, /코드 변경/);
});

test('parseFindings — 정상 JSON 배열', () => {
  const out = '안내 prose...\n[{"file":"src/foo.ts","line":10,"severity":"warn","message":"주의","confidence":7}]\n끝';
  const r = parseFindings(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].file, 'src/foo.ts');
  assert.equal(r[0].severity, 'warn');
});

test('parseFindings — 빈 배열', () => {
  assert.deepEqual(parseFindings('결과: []'), []);
});

test('parseFindings — JSON 없음 / 형식 깨짐', () => {
  assert.deepEqual(parseFindings('그냥 텍스트'), []);
  assert.deepEqual(parseFindings('[invalid json'), []);
});

test('parseFindings — severity enum 외 값을 info로 normalize', () => {
  const r = parseFindings('[{"file":"a","severity":"critical","message":"x"}]');
  assert.equal(r[0].severity, 'info');
});

test('createCodexAdapter — check_available (mock runner)', async () => {
  const adapter = createCodexAdapter({
    runner: (args) => args[0] === '--version' ? { status: 0, stdout: 'codex 1.0.0' } : { status: 1 },
  });
  assert.equal(await adapter.check_available(), true);
});

test('createCodexAdapter — check_available 실패', async () => {
  const adapter = createCodexAdapter({
    runner: () => ({ status: 127, stderr: 'command not found' }),
  });
  assert.equal(await adapter.check_available(), false);
});

test('createCodexAdapter — call_review 정상 결과', async () => {
  const adapter = createCodexAdapter({
    runner: (args) => {
      if (args[0] === 'exec') {
        return {
          status: 0,
          stdout: '[{"file":"src/foo.ts","severity":"warn","message":"테스트"}]',
        };
      }
      return { status: 0 };
    },
  });
  const findings = await adapter.call_review({
    target: 'plan', artifacts: ['TASKS.md'], context: 'test',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
});

test('createCodexAdapter — call_review 실패 시 어댑터 자체 finding', async () => {
  const adapter = createCodexAdapter({
    runner: () => ({ status: 1, stderr: 'API key missing' }),
  });
  const findings = await adapter.call_review({
    target: 'plan', artifacts: [], context: '',
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /codex 호출 실패/);
});
