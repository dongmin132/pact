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
