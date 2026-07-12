'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  createCodexAdapter,
  buildReviewPrompt,
  parseFindings,
  parseCapturedMessage,
} = require('../scripts/cross-review/codex-adapter.js');

// codex 미설치 환경에서는 실 CLI 스모크 테스트를 skip 하기 위한 감지.
function codexAvailable() {
  try {
    const r = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return !!r && r.status === 0;
  } catch {
    return false;
  }
}

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

// XREV-CODEX-3 — 결정적 출력 캡처 (--output-last-message)

test('createCodexAdapter — --output-last-message 파일 캡처가 stdout 스크레이핑보다 우선', async () => {
  // 최종 메시지 파일에는 진짜 findings, stdout 에는 프롬프트 에코(가짜) 를 두어
  // 어댑터가 파일(결정적)을 신뢰하는지 검증. 구코드는 stdout 만 읽어 실패한다.
  const adapter = createCodexAdapter({
    runner: (args) => {
      if (args[0] !== 'exec') return { status: 0 };
      const i = args.indexOf('--output-last-message');
      assert.notEqual(i, -1, 'call_review 는 --output-last-message 를 넘겨야 한다');
      const file = args[i + 1];
      assert.equal(typeof file, 'string');
      fs.writeFileSync(file, '[{"file":"real.ts","severity":"error","message":"진짜 발견"}]');
      return {
        status: 0,
        // stdout 에는 프롬프트 예시 에코(<path> placeholder) — 스크레이핑 시 가짜 finding
        stdout: '예시를 되풀이합니다:\n[{"file":"<path>","severity":"info","message":"에코"}]',
      };
    },
  });
  const findings = await adapter.call_review({
    target: 'code', artifacts: ['HEAD~1..HEAD'], context: '',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'real.ts');
  assert.equal(findings[0].severity, 'error');
});

test('createCodexAdapter — 파일 미기록 시 stdout 파싱 폴백 (하위호환)', async () => {
  // 최종 메시지 파일을 쓰지 않는 runner → 기존 stdout 스크레이핑 경로로 폴백.
  const adapter = createCodexAdapter({
    runner: (args) => {
      if (args[0] !== 'exec') return { status: 0 };
      return { status: 0, stdout: '[{"file":"only-stdout.ts","severity":"warn","message":"폴백"}]' };
    },
  });
  const findings = await adapter.call_review({
    target: 'plan', artifacts: ['TASKS.md'], context: '',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'only-stdout.ts');
});

test('parseCapturedMessage — 중첩 배열/message 내 `}]` 리터럴을 직접 JSON.parse 로 정확히 파싱', () => {
  // 이런 유효 JSON 은 비그리디 정규식(parseFindings)이 조기 절단해 [] 를 낸다.
  // 최종 메시지 파일은 순수 JSON 이므로 전체를 직접 parse 해야 올바르다.
  const captured = '[{"file":"a.ts","severity":"warn","message":"arr[0] }] 참고"}]';
  assert.deepEqual(parseFindings(captured), []); // 정규식 스크레이핑은 오절단
  const r = parseCapturedMessage(captured);
  assert.equal(r.length, 1);
  assert.equal(r[0].file, 'a.ts');
  assert.match(r[0].message, /참고/);
});

test('parseCapturedMessage — 빈/공백 입력은 null (stdout 폴백 트리거)', () => {
  assert.equal(parseCapturedMessage(''), null);
  assert.equal(parseCapturedMessage('   \n'), null);
  assert.equal(parseCapturedMessage(null), null);
});

test('createCodexAdapter — 실 codex CLI check_available 스모크', { skip: !codexAvailable() }, async () => {
  // codex 가 로컬에 설치된 경우에만 실행 — 실 바이너리가 호출 가능한지 결정적으로 확인.
  const adapter = createCodexAdapter();
  assert.equal(await adapter.check_available(), true);
});
