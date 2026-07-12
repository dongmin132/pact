'use strict';

// PACT-008 — 워커 spawn 헬퍼 단위 테스트

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  prepareWorkerSpawn,
  validatePayload,
  renderPrompt,
  makeTaskPrompt,
} = require('../scripts/spawn-worker.js');

const SPAWN_WORKER = path.join(__dirname, '..', 'scripts', 'spawn-worker.js');

const VALID = {
  task_id: 'PACT-001',
  title: '로그인 API',
  allowed_paths: ['src/api/auth/login.ts'],
  done_criteria: ['POST 200 반환'],
  verify_commands: ['npm test'],
  working_dir: '.pact/worktrees/PACT-001',
  branch_name: 'pact/PACT-001',
  base_branch: 'main',
};

test('validatePayload — 빈 객체는 필수 필드 에러', () => {
  const errors = validatePayload({});
  assert.ok(errors.length > 0);
  assert.ok(errors.some(e => e.includes('task_id')));
});

test('validatePayload — 정상 payload는 에러 0', () => {
  assert.deepEqual(validatePayload(VALID), []);
});

test('validatePayload — task_id 형식 위반 거부', () => {
  const errors = validatePayload({ ...VALID, task_id: 'invalid_id' });
  assert.ok(errors.some(e => e.toLowerCase().includes('task_id')));
});

test('validatePayload — allowed_paths가 배열 아니면 거부', () => {
  const errors = validatePayload({ ...VALID, allowed_paths: 'src/' });
  assert.ok(errors.some(e => e.includes('allowed_paths')));
});

test('validatePayload — null/undefined payload 거부', () => {
  assert.ok(validatePayload(null).length > 0);
  assert.ok(validatePayload(undefined).length > 0);
});

// ─── ADR-055: yolo_mode + forbidden_paths 빈/누락 거부 ───

test('ADR-055 — yolo_mode:true + forbidden_paths 누락은 거부', () => {
  const errors = validatePayload({ ...VALID, yolo_mode: true });
  assert.ok(
    errors.some(e => e.includes('forbidden_paths')),
    `errors: ${JSON.stringify(errors)}`,
  );
});

test('ADR-055 — yolo_mode:true + forbidden_paths:[] 빈 배열은 거부', () => {
  const errors = validatePayload({ ...VALID, yolo_mode: true, forbidden_paths: [] });
  assert.ok(
    errors.some(e => /forbidden_paths/.test(e) && /empty|forbidden/.test(e)),
    `errors: ${JSON.stringify(errors)}`,
  );
});

test('ADR-055 — yolo_mode:true + forbidden_paths 비배열은 거부', () => {
  const errors = validatePayload({ ...VALID, yolo_mode: true, forbidden_paths: 'all' });
  assert.ok(
    errors.some(e => e.includes('forbidden_paths')),
    `errors: ${JSON.stringify(errors)}`,
  );
});

test('ADR-055 — yolo_mode:true + forbidden_paths:["**/*"] deny-all은 통과', () => {
  const errors = validatePayload({ ...VALID, yolo_mode: true, forbidden_paths: ['**/*'] });
  assert.deepEqual(errors, [], `errors: ${JSON.stringify(errors)}`);
});

test('ADR-055 — yolo_mode 미지정은 forbidden_paths 누락 허용 (기존 동작 유지)', () => {
  const errors = validatePayload({ ...VALID });
  assert.deepEqual(errors, []);
});

test('ADR-055 — yolo_mode:false면 forbidden_paths 누락 허용', () => {
  const errors = validatePayload({ ...VALID, yolo_mode: false });
  assert.deepEqual(errors, []);
});

test('renderPrompt — task_id·title 치환', () => {
  const tmpl = '# {{task_id}}\n{{title}}';
  const out = renderPrompt(VALID, tmpl);
  assert.match(out, /PACT-001/);
  assert.match(out, /로그인 API/);
});

test('renderPrompt — done_criteria를 bullet list로 렌더', () => {
  const tmpl = '{{done_criteria}}';
  const out = renderPrompt(VALID, tmpl);
  assert.match(out, /^- POST 200 반환/m);
});

test('renderPrompt — allowed_paths 직렬화', () => {
  const tmpl = '{{allowed_paths}}';
  const out = renderPrompt(VALID, tmpl);
  assert.match(out, /src\/api\/auth\/login\.ts/);
});

test('renderPrompt — tdd: true → ON 표시', () => {
  const tmpl = '{{tdd_mode}}';
  const out = renderPrompt({ ...VALID, tdd: true }, tmpl);
  assert.match(out, /ON/);
});

test('renderPrompt — runs_dir 치환', () => {
  const tmpl = '{{runs_dir}}';
  const out = renderPrompt(VALID, tmpl);
  assert.equal(out, '.pact/runs/PACT-001');
});

test('prepareWorkerSpawn — payload.json 작성·경로 반환', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-test-'));
  try {
    const tmpl = path.join(tmpRoot, 'tmpl.md');
    fs.writeFileSync(tmpl, '# {{task_id}}\n{{title}}');

    const result = prepareWorkerSpawn(VALID, {
      templatePath: tmpl,
      runsRoot: path.join(tmpRoot, 'runs'),
    });

    assert.equal(result.ok, true);
    assert.match(result.prompt, /PACT-001/);
    assert.ok(fs.existsSync(result.prompt_path));
    assert.match(result.task_prompt, /prompt\.md/);
    assert.ok(fs.existsSync(result.payload_path));

    const written = JSON.parse(fs.readFileSync(result.payload_path, 'utf8'));
    assert.equal(written.task_id, 'PACT-001');
    assert.equal(written.title, '로그인 API');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('prepareWorkerSpawn — 잘못된 payload는 ok:false', () => {
  const result = prepareWorkerSpawn({}, { templatePath: '/dev/null' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('validatePayload — worktree 필드 누락 거부 (P1.5+)', () => {
  const noWt = { ...VALID };
  delete noWt.working_dir;
  const errors = validatePayload(noWt);
  assert.ok(errors.some(e => e.includes('working_dir')));
});

test('renderPrompt — working_dir/branch_name/base_branch 치환', () => {
  const tmpl = '{{working_dir}} | {{branch_name}} | {{base_branch}}';
  const out = renderPrompt(VALID, tmpl);
  assert.equal(out, '.pact/worktrees/PACT-001 | pact/PACT-001 | main');
});

test('prepareWorkerSpawn — 결과에 status_path/report_path 포함', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-test-'));
  try {
    const tmpl = path.join(tmpRoot, 'tmpl.md');
    fs.writeFileSync(tmpl, '');

    const result = prepareWorkerSpawn(VALID, {
      templatePath: tmpl,
      runsRoot: path.join(tmpRoot, 'runs'),
    });

    assert.match(result.status_path, /PACT-001\/status\.json$/);
    assert.match(result.report_path, /PACT-001\/report\.md$/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('prepareWorkerSpawn — context_refs 기반 context.md 번들 생성', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-test-'));
  try {
    const tmpl = path.join(tmpRoot, 'tmpl.md');
    fs.writeFileSync(tmpl, '{{context_bundle_path}}');
    fs.mkdirSync(path.join(tmpRoot, 'contracts/api'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'contracts/api/auth.md'), [
      '# Auth API',
      '',
      '## POST /api/auth/login',
      '',
      '```yaml',
      'method: POST',
      'path: /api/auth/login',
      '```',
      '',
      '## POST /api/auth/logout',
      'not relevant',
      '',
    ].join('\n'));

    const result = prepareWorkerSpawn({
      ...VALID,
      context_refs: ['contracts/api/auth.md#POST /api/auth/login'],
    }, {
      templatePath: tmpl,
      runsRoot: path.join(tmpRoot, '.pact/runs'),
      cwd: tmpRoot,
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.context_path));
    assert.ok(fs.existsSync(result.prompt_path));
    const ctx = fs.readFileSync(result.context_path, 'utf8');
    assert.match(ctx, /# Worker Context Bundle/);
    assert.match(ctx, /POST \/api\/auth\/login/);
    assert.doesNotMatch(ctx, /not relevant/);
    assert.match(result.prompt, /\.pact\/runs\/PACT-001\/context\.md/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── TOK-3(1부): bundle_warnings 를 호출자에 플럼빙 (추가 필드, 비파괴) ───

test('prepareWorkerSpawn — bundle_warnings를 호출자에 전달 (anchor 없는 대형 shard)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-test-'));
  try {
    const tmpl = path.join(tmpRoot, 'tmpl.md');
    fs.writeFileSync(tmpl, '');
    const big = ['# Big Contract'].concat(
      Array.from({ length: 250 }, (_, i) => `line ${i}`)).join('\n');
    fs.mkdirSync(path.join(tmpRoot, 'contracts/api'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'contracts/api/big.md'), big);

    const result = prepareWorkerSpawn({
      ...VALID,
      context_refs: ['contracts/api/big.md'],
    }, {
      templatePath: tmpl,
      runsRoot: path.join(tmpRoot, '.pact/runs'),
      cwd: tmpRoot,
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.bundle_warnings));
    assert.equal(result.bundle_warnings.length, 1);
    assert.equal(result.bundle_warnings[0].ref, 'contracts/api/big.md');
    assert.equal(result.bundle_warnings[0].reason, 'no_anchor_full_include');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('prepareWorkerSpawn — context_refs 없으면 bundle_warnings 빈 배열', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-test-'));
  try {
    const tmpl = path.join(tmpRoot, 'tmpl.md');
    fs.writeFileSync(tmpl, '');
    const result = prepareWorkerSpawn(VALID, {
      templatePath: tmpl,
      runsRoot: path.join(tmpRoot, '.pact/runs'),
      cwd: tmpRoot,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.bundle_warnings, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── TOK-1: 워커 종료 메시지 1줄 요약 규약 ───

test('makeTaskPrompt — 최종 메시지로 1줄 요약만 반환하라는 지시 포함', () => {
  const paths = {
    prompt_path: '.pact/runs/PACT-001/prompt.md',
    context_path: '.pact/runs/PACT-001/context.md',
    status_path: '.pact/runs/PACT-001/status.json',
    report_path: '.pact/runs/PACT-001/report.md',
  };
  const tp = makeTaskPrompt(VALID, paths);
  assert.match(tp, /one-line summary/i);
});

// ─── AP-1: 진입 프롬프트는 report.md 수기 작성을 지시하지 않는다 (report-gen 이 렌더) ───

test('makeTaskPrompt — report.md 수기 작성 지시 없음 (report-gen 이 결정적 렌더)', () => {
  const paths = {
    prompt_path: '.pact/runs/PACT-001/prompt.md',
    context_path: '.pact/runs/PACT-001/context.md',
    status_path: '.pact/runs/PACT-001/status.json',
    report_path: '.pact/runs/PACT-001/report.md',
  };
  const tp = makeTaskPrompt(VALID, paths);
  // 워커에게 status.json 은 여전히 쓰라고 지시
  assert.match(tp, /status\.json/);
  // report_path 를 진입 프롬프트에 싣지 않는다 (수기 작성 유도 제거)
  assert.doesNotMatch(tp, /report to /);
  assert.doesNotMatch(tp, /runs\/PACT-001\/report\.md/);
  // report.md 는 pact report-gen 이 렌더한다고 명시
  assert.match(tp, /report-gen/);
});

test('spawn-worker CLI — stdout에 full prompt를 싣지 않음', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-test-'));
  try {
    const payloadPath = path.join(tmpRoot, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify(VALID, null, 2));

    const r = spawnSync('node', [SPAWN_WORKER, payloadPath], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(Object.hasOwn(out, 'prompt'), false);
    assert.match(out.task_prompt, /prompt\.md/);
    assert.match(out.prompt_path, /\.pact\/runs\/PACT-001\/prompt\.md$/);
    assert.ok(fs.existsSync(path.join(tmpRoot, out.prompt_path)));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
