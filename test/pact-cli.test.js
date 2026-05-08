'use strict';

// pact CLI 통합 테스트 — bin/pact를 spawn으로 호출.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const PACT_BIN = path.join(__dirname, '..', 'bin', 'pact');

function sh(cmd, opts) {
  return execSync(cmd, { stdio: 'ignore', shell: true, ...opts });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-cli-'));
  sh('git init -b main', { cwd: dir });
  sh('git config user.email t@t.t && git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  sh('git add . && git commit -m init', { cwd: dir });
  return dir;
}

function cleanupRepo(dir) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: dir, encoding: 'utf8' });
    out.split('\n').filter(l => l.startsWith('worktree ')).forEach(l => {
      const wt = l.replace('worktree ', '').trim();
      if (wt !== dir) {
        try { sh(`git worktree remove --force "${wt}"`, { cwd: dir }); } catch {}
      }
    });
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

function runPact(args, cwd) {
  return spawnSync('node', [PACT_BIN, ...args], { cwd, encoding: 'utf8' });
}

const SAMPLE_TASKS_MD = `# TASKS

## frontmatter

\`\`\`yaml
educational_mode: false
\`\`\`

---

## TASK-001  test

\`\`\`yaml
priority: P0
dependencies: []
allowed_paths: [src/a.ts]
files: [src/a.ts]
work: [setup]
done_criteria: [exists]
tdd: false
\`\`\`

## TASK-002  test 2

\`\`\`yaml
priority: P0
dependencies:
  - task_id: TASK-001
    kind: complete
allowed_paths: [src/b.ts]
files: [src/b.ts]
work: [setup]
done_criteria: [exists]
tdd: false
\`\`\`
`;

test('pact (인자 없음) — usage 출력 + exit 0', () => {
  const r = runPact([], process.cwd());
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test('pact <unknown> — usage 출력 + exit 1', () => {
  const r = runPact(['nonexistent'], process.cwd());
  assert.equal(r.status, 1);
});

test('pact batch — TASKS.md → .pact/batch.json', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'TASKS.md'), SAMPLE_TASKS_MD);
    const r = runPact(['batch'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(fs.readFileSync(path.join(repo, '.pact/batch.json'), 'utf8'));
    assert.equal(out.total_tasks, 2);
    assert.ok(out.batches.length >= 1);
  } finally { cleanupRepo(repo); }
});

test('pact batch — tasks/*.md shard를 기본 task source로 사용', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'tasks'));
    fs.writeFileSync(path.join(repo, 'tasks', 'auth.md'), SAMPLE_TASKS_MD);
    const r = runPact(['batch'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(fs.readFileSync(path.join(repo, '.pact/batch.json'), 'utf8'));
    assert.deepEqual(out.task_sources, ['tasks/auth.md']);
    assert.equal(out.total_tasks, 2);
  } finally { cleanupRepo(repo); }
});

test('pact slice --headers — tasks/*.md shard TOC 출력', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'tasks'));
    fs.writeFileSync(path.join(repo, 'tasks', 'auth.md'), SAMPLE_TASKS_MD);
    const r = runPact(['slice', '--headers'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /sources: tasks\/auth\.md/);
    assert.match(r.stdout, /TASK-001/);
  } finally { cleanupRepo(repo); }
});

test('pact batch — TASKS.md 없으면 exit 2', () => {
  const repo = makeRepo();
  try {
    const r = runPact(['batch'], repo);
    assert.equal(r.status, 2);
  } finally { cleanupRepo(repo); }
});

test('pact batch — TBD 마커 잔존 시 exit 4', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'TASKS.md'), `## TASK-001  TBD task

\`\`\`yaml
priority: P0
dependencies: []
allowed_paths: [a]
files: [a]
work: [w]
done_criteria: [d]
contracts:
  api_endpoints: TBD
tdd: false
\`\`\`
`);
    const r = runPact(['batch'], repo);
    assert.equal(r.status, 4);
  } finally { cleanupRepo(repo); }
});

test('pact status — 빈 .pact/에서도 동작', () => {
  const repo = makeRepo();
  try {
    const r = runPact(['status'], repo);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pact status/);
    assert.match(r.stdout, /Cycle: 0/);
  } finally { cleanupRepo(repo); }
});

test('pact status --summary — 한 줄 요약 (메인 prefix 절감용)', () => {
  const repo = makeRepo();
  try {
    const r = runPact(['status', '--summary'], repo);
    assert.equal(r.status, 0);
    // 단일 라인, 키:값 공백구분
    const lines = r.stdout.trim().split('\n').filter(l => l.length > 0);
    assert.equal(lines.length, 1, `요약은 1줄, 실제: ${lines.length}\n${r.stdout}`);
    assert.match(lines[0], /cycle:\d+/);
    assert.match(lines[0], /active:\d+/);
    assert.match(lines[0], /worktree:\d+/);
    assert.match(lines[0], /merge:(clean|in-progress)/);
    // 장식 X (이모지·여백·헤더 없음)
    assert.doesNotMatch(lines[0], /📊|pact status|---/);
  } finally { cleanupRepo(repo); }
});

test('pact status -s — --summary 단축 alias', () => {
  const repo = makeRepo();
  try {
    const r = runPact(['status', '-s'], repo);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /cycle:\d+ /);
  } finally { cleanupRepo(repo); }
});

test('pact merge — runs/ 없으면 exit 2', () => {
  const repo = makeRepo();
  try {
    const r = runPact(['merge'], repo);
    assert.equal(r.status, 2);
  } finally { cleanupRepo(repo); }
});

test('pact split-docs — legacy TASKS/API/DB를 domain shard로 분리', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'TASKS.md'), `# TASKS

## AUTH-001  login

\`\`\`yaml
priority: P0
dependencies: []
allowed_paths:
  - src/auth/login.ts
files:
  - src/auth/login.ts
work:
  - login
done_criteria:
  - works
tdd: true
\`\`\`

## MEETUP-001  create meetup

\`\`\`yaml
priority: P0
dependencies: []
allowed_paths:
  - src/meetup/create.ts
files:
  - src/meetup/create.ts
work:
  - create
done_criteria:
  - works
tdd: true
\`\`\`
`);
    fs.writeFileSync(path.join(repo, 'API_CONTRACT.md'), `# API

## POST /api/auth/login

\`\`\`yaml
method: POST
path: /api/auth/login
\`\`\`

## POST /api/meetups

\`\`\`yaml
method: POST
path: /api/meetups
\`\`\`
`);
    fs.writeFileSync(path.join(repo, 'DB_CONTRACT.md'), `# DB

## users table

\`\`\`yaml
table: users
\`\`\`

## meetups table

\`\`\`yaml
table: meetups
\`\`\`
`);

    const r = runPact(['split-docs'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(repo, 'tasks/auth.md')));
    assert.ok(fs.existsSync(path.join(repo, 'tasks/meetup.md')));
    assert.ok(fs.existsSync(path.join(repo, 'contracts/api/auth.md')));
    assert.ok(fs.existsSync(path.join(repo, 'contracts/api/meetups.md')));
    assert.ok(fs.existsSync(path.join(repo, 'contracts/db/user.md')));
    assert.ok(fs.existsSync(path.join(repo, 'contracts/db/meetup.md')));
    assert.ok(fs.existsSync(path.join(repo, 'contracts/manifest.md')));
    assert.ok(fs.existsSync(path.join(repo, 'docs/context-map.md')));

    const authTasks = fs.readFileSync(path.join(repo, 'tasks/auth.md'), 'utf8');
    assert.match(authTasks, /AUTH-001/);
    assert.doesNotMatch(authTasks, /MEETUP-001/);

    const contextMap = fs.readFileSync(path.join(repo, 'docs/context-map.md'), 'utf8');
    assert.match(contextMap, /tasks\/auth\.md/);
    assert.match(contextMap, /contracts\/api\/auth\.md/);
  } finally { cleanupRepo(repo); }
});

test('pact split-docs — task에 context_refs 자동 주입', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'TASKS.md'), `# TASKS

## AUTH-001  login

\`\`\`yaml
priority: P0
dependencies: []
allowed_paths:
  - src/auth/login.ts
files:
  - src/auth/login.ts
work:
  - login
done_criteria:
  - works
contracts:
  api_endpoints:
    - POST /api/auth/login
  db_tables:
    - users
tdd: true
\`\`\`
`);

    const r = runPact(['split-docs'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const authShard = fs.readFileSync(path.join(repo, 'tasks/auth.md'), 'utf8');
    assert.match(authShard, /context_refs:/);
    assert.match(authShard, /contracts\/api\/auth\.md/);
    assert.match(authShard, /contracts\/db\/user\.md/);
    assert.match(authShard, /contracts\/modules\/auth\.md/);
  } finally { cleanupRepo(repo); }
});

test('pact split-docs — MODULE_OWNERSHIP을 contracts/modules shard로 분리', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'MODULE_OWNERSHIP.md'), `# Modules

## auth 모듈

\`\`\`yaml
module: auth
owner_paths:
  - src/auth/**
shared_with: []
related_tasks: [AUTH-001]
\`\`\`

## meetup 모듈

\`\`\`yaml
module: meetup
owner_paths:
  - src/meetup/**
shared_with: []
related_tasks: [MEETUP-001]
\`\`\`
`);
    const r = runPact(['split-docs'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(repo, 'contracts/modules/auth.md')));
    assert.ok(fs.existsSync(path.join(repo, 'contracts/modules/meetup.md')));
    const manifest = fs.readFileSync(path.join(repo, 'contracts/manifest.md'), 'utf8');
    assert.match(manifest, /## Modules/);
    assert.match(manifest, /contracts\/modules\/auth\.md/);
  } finally { cleanupRepo(repo); }
});

test('pact context-map sync — Domains 표를 현재 shard 상태로 갱신', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'contracts/api'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'contracts/modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tasks/auth.md'), '# auth tasks\n');
    fs.writeFileSync(path.join(repo, 'contracts/api/auth.md'), '# auth api\n');
    fs.writeFileSync(path.join(repo, 'contracts/modules/auth.md'), '# auth module\n');

    const r = runPact(['context-map', 'sync'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const ctx = fs.readFileSync(path.join(repo, 'docs/context-map.md'), 'utf8');
    assert.match(ctx, /pact:context-map:domains:start/);
    assert.match(ctx, /\| auth \|/);
    assert.match(ctx, /tasks\/auth\.md/);
    assert.match(ctx, /contracts\/modules\/auth\.md/);

    // idempotent: 두 번째 실행은 변경 없음
    const r2 = runPact(['context-map', 'sync'], repo);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /변경 없음/);
  } finally { cleanupRepo(repo); }
});

test('pact context-guard --parallel — 긴 docs spec 문서 경고만 출력', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'coffeechat_dev_spec.md'), Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'));

    const r = runPact(['context-guard', '--parallel', '--max-lines', '10'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /coffeechat_dev_spec\.md/);
    assert.match(r.stdout, /PreToolUse hook/);
  } finally { cleanupRepo(repo); }
});

test('pact context-guard --allow-long-context — 긴 문서 경고만 출력', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'TASKS.md'), Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'));

    const r = runPact(['context-guard', '--parallel', '--max-lines', '10', '--allow-long-context'], repo);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /warning only/);
    assert.match(r.stdout, /TASKS\.md/);
  } finally { cleanupRepo(repo); }
});
