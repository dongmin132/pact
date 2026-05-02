'use strict';

// PACT-028 — Merge coordinator 단위 테스트
// 실제 git 명령 호출. 임시 repo 사용.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { createWorktree, removeWorktree } = require('../scripts/worktree-manager.js');
const {
  mergeWorktree,
  mergeAll,
  abortMerge,
} = require('../scripts/merge-coordinator.js');

function sh(cmd, opts) {
  return execSync(cmd, { stdio: 'ignore', shell: true, ...opts });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-merge-'));
  sh('git init -b main', { cwd: dir });
  sh('git config user.email t@t.t && git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
  sh('git add . && git commit -m init', { cwd: dir });
  return dir;
}

function cleanupRepo(dir) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: dir, encoding: 'utf8' });
    const wts = out.split('\n').filter(l => l.startsWith('worktree '));
    for (const l of wts) {
      const wt = l.replace('worktree ', '').trim();
      if (wt !== dir) {
        try { sh(`git worktree remove --force "${wt}"`, { cwd: dir }); } catch {}
      }
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

/** worktree 만들고 거기서 파일 변경·commit */
function workInWorktree(repo, taskId, file, content, msg = 'work') {
  const r = createWorktree(taskId, 'main', { cwd: repo });
  if (!r.ok) throw new Error(`createWorktree failed: ${r.error}`);
  const wtAbs = r.abs_path;
  fs.writeFileSync(path.join(wtAbs, file), content);
  sh(`git add . && git commit -m "${msg}"`, { cwd: wtAbs });
  return r;
}

test('mergeWorktree — 충돌 없는 변경 머지 성공', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A content\n');
    const r = mergeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
  } finally { cleanupRepo(repo); }
});

test('mergeWorktree — 충돌 발생 시 ok:false + 충돌 파일 보고', () => {
  const repo = makeRepo();
  try {
    // main에 conflict.txt 만들고 commit
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'main version\n');
    sh('git add . && git commit -m "main change"', { cwd: repo });

    // worktree에서 같은 파일 다른 내용으로 변경 (base가 main이지만 main 이후 또 변경됨)
    // → 단순히 같은 파일 변경만으론 충돌 안 남. main이 worker 분기 후 변경되어야 함.
    // 그래서 worker 먼저 만들고, main에서 추가 commit, 머지 시도
    workInWorktree(repo, 'TEST-001', 'shared.txt', 'worker line\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main line\n');
    sh('git add . && git commit -m "main shared"', { cwd: repo });

    const r = mergeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, false);
    assert.ok(r.conflicted_files && r.conflicted_files.length > 0);

    // 머지 abort로 정리
    abortMerge({ cwd: repo });
  } finally { cleanupRepo(repo); }
});

test('mergeWorktree — 존재하지 않는 task_id 거부', () => {
  const repo = makeRepo();
  try {
    const r = mergeWorktree('NONE-001', { cwd: repo });
    assert.equal(r.ok, false);
  } finally { cleanupRepo(repo); }
});

test('mergeAll — 충돌 없는 다수 worktree 모두 머지', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A\n');
    workInWorktree(repo, 'TEST-002', 'b.txt', 'B\n');
    workInWorktree(repo, 'TEST-003', 'c.txt', 'C\n');

    const r = mergeAll(['TEST-001', 'TEST-002', 'TEST-003'], { cwd: repo });
    assert.equal(r.merged.length, 3);
    assert.equal(r.conflicted, null);
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'c.txt')));
  } finally { cleanupRepo(repo); }
});

test('mergeAll — 충돌 시 즉시 stop, 이후 task는 untouched', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A\n');
    // TEST-002는 main과 충돌하도록
    workInWorktree(repo, 'TEST-002', 'shared.txt', 'worker\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n');
    sh('git add . && git commit -m "main"', { cwd: repo });

    workInWorktree(repo, 'TEST-003', 'c.txt', 'C\n');

    const r = mergeAll(['TEST-001', 'TEST-002', 'TEST-003'], { cwd: repo });
    assert.equal(r.merged.length, 1, 'TEST-001만 성공');
    assert.equal(r.merged[0], 'TEST-001');
    assert.ok(r.conflicted, '충돌 정보 있어야 함');
    assert.equal(r.conflicted.task_id, 'TEST-002');
    assert.deepEqual(r.skipped, ['TEST-003']);

    abortMerge({ cwd: repo });
  } finally { cleanupRepo(repo); }
});

test('abortMerge — 충돌 상태 정리', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'shared.txt', 'worker\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n');
    sh('git add . && git commit -m "main"', { cwd: repo });

    mergeWorktree('TEST-001', { cwd: repo });  // 충돌
    const r = abortMerge({ cwd: repo });
    assert.equal(r.ok, true);

    // 정리됨 — git status는 clean이어야 함
    const status = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
    assert.equal(status.trim(), '');
  } finally { cleanupRepo(repo); }
});
