'use strict';

// PACT-026 — Git worktree wrapper
//
// W1 위치: <repo>/.pact/worktrees/<task_id>/
// W2 branch: pact/<TASK-ID> per task
// W3 base: 호출 시 명시 (보통 현재 main HEAD)
//
// 모든 함수는 { cwd } 옵션으로 작업 디렉토리 명시 가능 (테스트용).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const WORKTREE_BASE = '.pact/worktrees';

function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
  });
}

function gitVersion() {
  const r = git(['--version']);
  if (r.status !== 0) return null;
  const m = /git version (\d+)\.(\d+)/.exec(r.stdout);
  return m ? { major: +m[1], minor: +m[2] } : null;
}

function isGitRepo(opts) {
  return git(['rev-parse', '--git-dir'], opts).status === 0;
}

function hasBranch(name, opts) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], opts).status === 0;
}

function isClean(opts) {
  const r = git(['status', '--porcelain'], opts);
  return r.status === 0 && r.stdout.trim() === '';
}

/** 머지 진행 중인지 감지 (MERGE_HEAD 존재). P1.5+ 게이트용. */
function isMergeInProgress(opts = {}) {
  return git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], opts).status === 0;
}

/** 환경 검증: git 2.5+, repo, main(or master) 존재, working tree clean. */
function checkEnvironment(opts = {}) {
  const errors = [];

  const v = gitVersion();
  if (!v) {
    errors.push('git이 설치되어 있지 않거나 실행 불가');
    return { ok: false, errors };
  }
  if (v.major < 2 || (v.major === 2 && v.minor < 5)) {
    errors.push(`git 2.5+ 필요 (현재 ${v.major}.${v.minor})`);
  }

  if (!isGitRepo(opts)) {
    errors.push('현재 디렉토리는 git 저장소가 아닙니다');
    return { ok: false, errors };
  }

  if (!hasBranch('main', opts) && !hasBranch('master', opts)) {
    errors.push('main 또는 master 브랜치가 없습니다');
  }

  if (!isClean(opts)) {
    errors.push('uncommitted changes가 있습니다 (git stash 또는 commit 권장)');
  }

  return { ok: errors.length === 0, errors };
}

/** worktree 생성. 결과: { ok, working_dir, branch_name, abs_path, error } */
function createWorktree(taskId, baseBranch, opts = {}) {
  if (!TASK_ID_RE.test(taskId)) {
    return { ok: false, error: `task_id 형식 위반 (예상: PACT-001 같은 패턴): ${taskId}` };
  }
  const branchName = `pact/${taskId}`;
  const cwd = opts.cwd || process.cwd();
  const wtPath = path.join(WORKTREE_BASE, taskId);
  const absPath = path.join(cwd, wtPath);

  if (fs.existsSync(absPath)) {
    return { ok: false, error: `worktree 이미 존재: ${wtPath}` };
  }

  const r = git(['worktree', 'add', '-b', branchName, wtPath, baseBranch], opts);
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || 'git worktree add 실패' };
  }

  // node_modules symlink (best-effort) — 워커가 tsx/tsc 경로 못 찾아 디버깅 cycle 발생하던
  // 토큰 누수 막음. opts.linkNodeModules: false 로 opt-out 가능.
  if (opts.linkNodeModules !== false) {
    const srcNm = path.join(cwd, 'node_modules');
    const dstNm = path.join(absPath, 'node_modules');
    if (fs.existsSync(srcNm) && !fs.existsSync(dstNm)) {
      try { fs.symlinkSync(srcNm, dstNm, 'dir'); } catch { /* best-effort */ }
    }
  }

  return {
    ok: true,
    working_dir: wtPath,
    branch_name: branchName,
    abs_path: absPath,
  };
}

/** worktree 제거 + branch 삭제. opts.force 시 강제. */
function removeWorktree(taskId, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const wtPath = path.join(WORKTREE_BASE, taskId);
  const absPath = path.join(cwd, wtPath);

  // 우리가 만든 node_modules symlink는 git worktree remove 전에 unlink (untracked 거부 회피)
  const dstNm = path.join(absPath, 'node_modules');
  try {
    const lst = fs.lstatSync(dstNm);
    if (lst.isSymbolicLink()) fs.unlinkSync(dstNm);
  } catch { /* not exist or not symlink */ }

  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(wtPath);

  const r = git(args, opts);
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || 'git worktree remove 실패' };
  }

  // branch 삭제 (best-effort, 실패해도 worktree 제거는 성공)
  git(['branch', '-D', `pact/${taskId}`], opts);

  return { ok: true };
}

/** 활성 worktree 목록. main worktree는 제외, .pact/worktrees/<id> 형식만 반환. */
function listWorktrees(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const r = git(['worktree', 'list', '--porcelain'], opts);
  if (r.status !== 0) {
    return { active: [], error: (r.stderr || '').trim() };
  }

  const active = [];
  const blocks = r.stdout.split(/\n\n+/).filter(b => b.trim());

  for (const block of blocks) {
    const wt = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice(9);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7);
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5);
    }
    if (!wt.path) continue;

    // main worktree (== cwd)는 제외
    const real = fs.realpathSync(wt.path);
    const realCwd = fs.realpathSync(cwd);
    if (real === realCwd) continue;

    // .pact/worktrees/<id> 패턴만 인정
    const m = /\.pact\/worktrees\/([A-Z][A-Z0-9]*-\d+)$/.exec(wt.path);
    if (!m) continue;
    wt.task_id = m[1];

    active.push(wt);
  }

  return { active };
}

module.exports = {
  checkEnvironment,
  createWorktree,
  removeWorktree,
  listWorktrees,
  isMergeInProgress,
  TASK_ID_RE,
  WORKTREE_BASE,
};
