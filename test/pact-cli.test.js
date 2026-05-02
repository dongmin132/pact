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

test('pact merge — runs/ 없으면 exit 2', () => {
  const repo = makeRepo();
  try {
    const r = runPact(['merge'], repo);
    assert.equal(r.status, 2);
  } finally { cleanupRepo(repo); }
});
