'use strict';

// PACT-026 — Worktree manager 단위 테스트
// 실제 git 명령을 호출하므로 임시 git repo를 fixture로 사용.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
  checkEnvironment,
  createWorktree,
  removeWorktree,
  listWorktrees,
} = require('../scripts/worktree-manager.js');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-wt-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email t@t.t && git config user.name test',
    { cwd: dir, stdio: 'ignore', shell: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add . && git commit -m init', { cwd: dir, stdio: 'ignore', shell: true });
  return dir;
}

function cleanup(dir) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: dir, encoding: 'utf8' });
    const lines = out.split('\n').filter(l => l.startsWith('worktree '));
    for (const l of lines) {
      const wt = l.replace('worktree ', '').trim();
      if (wt !== dir && fs.existsSync(wt)) {
        try { execSync(`git worktree remove --force "${wt}"`, { cwd: dir, stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

test('checkEnvironment — 정상 git repo 통과', () => {
  const repo = makeRepo();
  try {
    const r = checkEnvironment({ cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { cleanup(repo); }
});

test('checkEnvironment — 비-git 디렉토리 실패', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-nogit-'));
  try {
    const r = checkEnvironment({ cwd: dir });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /git/i.test(e)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkEnvironment — uncommitted changes 거부', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    const r = checkEnvironment({ cwd: repo });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /uncommitted/i.test(e)));
  } finally { cleanup(repo); }
});

test('createWorktree — 경로·branch 생성', () => {
  const repo = makeRepo();
  try {
    const r = createWorktree('TEST-001', 'main', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.branch_name, 'pact/TEST-001');
    assert.match(r.working_dir, /\.pact\/worktrees\/TEST-001$/);
    assert.ok(fs.existsSync(path.join(repo, r.working_dir)));
  } finally { cleanup(repo); }
});

test('createWorktree — task_id 형식 위반 거부', () => {
  const repo = makeRepo();
  try {
    const r = createWorktree('invalid-id', 'main', { cwd: repo });
    assert.equal(r.ok, false);
  } finally { cleanup(repo); }
});

test('createWorktree — 이미 존재 시 에러', () => {
  const repo = makeRepo();
  try {
    createWorktree('TEST-001', 'main', { cwd: repo });
    const r = createWorktree('TEST-001', 'main', { cwd: repo });
    assert.equal(r.ok, false);
  } finally { cleanup(repo); }
});

test('removeWorktree — 정리 성공 + branch 삭제', () => {
  const repo = makeRepo();
  try {
    createWorktree('TEST-001', 'main', { cwd: repo });
    const r = removeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(repo, '.pact/worktrees/TEST-001')), false);
    // branch 도 삭제됨 확인
    const out = execSync('git branch --list pact/TEST-001', { cwd: repo, encoding: 'utf8' });
    assert.equal(out.trim(), '');
  } finally { cleanup(repo); }
});

test('listWorktrees — 활성 worktree 발견 + task_id 추출', () => {
  const repo = makeRepo();
  try {
    createWorktree('TEST-001', 'main', { cwd: repo });
    createWorktree('TEST-002', 'main', { cwd: repo });
    const r = listWorktrees({ cwd: repo });
    assert.equal(r.active.length, 2);
    const ids = r.active.map(w => w.task_id).sort();
    assert.deepEqual(ids, ['TEST-001', 'TEST-002']);
  } finally { cleanup(repo); }
});

test('listWorktrees — main worktree는 제외', () => {
  const repo = makeRepo();
  try {
    const r = listWorktrees({ cwd: repo });
    assert.equal(r.active.length, 0);
  } finally { cleanup(repo); }
});
