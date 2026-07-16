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

// cwd 가 리포 루트인가 (H6). git worktree add 는 전체 리포를 체크아웃하고 WORKTREE_BASE 는 cwd
// 상대라, 모노리포 서브디렉토리(packages/app 등)에서 실행하면 산출물이 리포 루트로 조용히 머지된다
// (e2e 실증). --show-toplevel 과 cwd 를 realpath 비교해 루트가 아니면 checkEnvironment 가 거부한다.
// (서브패키지 단위 지원은 v1.1 — 여기선 '조용한 오머지'만 fail-loud 로 막는다.)
function repoRootCheck(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const r = git(['rev-parse', '--show-toplevel'], opts);
  if (r.status !== 0) return { ok: false, top: null };
  const canon = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const top = canon((r.stdout || '').trim());
  return { ok: top === canon(cwd), top };
}

function hasBranch(name, opts) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], opts).status === 0;
}

function isClean(opts) {
  const r = git(['status', '--porcelain'], opts);
  return r.status === 0 && r.stdout.trim() === '';
}

/**
 * base branch 자동 감지 — 'main' 하드코딩 제거 (master 기반 repo 지원).
 * 우선순위: main → master → origin/HEAD → 'main'(최후 폴백).
 */
function detectBaseBranch(opts = {}) {
  if (hasBranch('main', opts)) return 'main';
  if (hasBranch('master', opts)) return 'master';
  const r = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], opts);
  if (r.status === 0) {
    const ref = (r.stdout || '').trim().replace(/^origin\//, '');
    if (ref) return ref;
  }
  return 'main';
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

  // H6: 리포 루트가 아니면(모노리포 서브디렉토리 등) 거부 — 산출물이 리포 루트로 조용히 머지되는
  // 오작동 방지. 루트에서 재실행하도록 안내(서브패키지 단위 지원은 v1.1).
  const rootChk = repoRootCheck(opts);
  if (!rootChk.ok && rootChk.top) {
    errors.push(`리포 루트가 아닙니다 (서브디렉토리 실행). pact 는 리포 루트에서 실행해야 합니다: cd ${rootChk.top} 후 재실행. (모노리포 서브패키지 단위 지원은 v1.1)`);
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

/**
 * prepare 재진입 시 stale worktree 정리 (데이터 안전). createWorktree 계약은 그대로 두고
 * 그 직전에 호출해 "worktree 이미 존재" cruft 를 안전하게 회수한다.
 * - git worktree prune (이미 삭제된 dir 의 admin 메타 정리)
 * - 대상 dir 이 남아있으면: (a) 미커밋 작업물(untracked 포함)이 있으면 보존,
 *   (b) base 대비 미머지 커밋이 있으면 보존, (c) 둘 다 없을(clean AND 미머지 없음) 때만 제거(reclaimed).
 *   회수는 데이터 손실이 확실히 없을 때만 — 커밋 안 된 워커 편집물 force-remove 금지(fresh-resume 전제·5철학).
 * @returns {{ok:true, action:'clean'|'reclaimed'} | {ok:false, preserved?:boolean, error:string}}
 */
function reconcileWorktree(taskId, baseBranch, opts = {}) {
  if (!TASK_ID_RE.test(taskId)) {
    return { ok: false, error: `task_id 형식 위반: ${taskId}` };
  }
  const cwd = opts.cwd || process.cwd();
  const branchName = `pact/${taskId}`;
  const wtPath = path.join(WORKTREE_BASE, taskId);
  const absPath = path.join(cwd, wtPath);

  git(['worktree', 'prune'], opts);

  if (!fs.existsSync(absPath)) {
    return { ok: true, action: 'clean' };
  }

  // 데이터 안전 게이트 (1) — 미커밋 작업물 보존. 미머지 커밋 검사보다 먼저.
  // isClean 재사용: worktree 디렉토리를 cwd 로 git status --porcelain(untracked 포함) 실행.
  // 워커가 아직 커밋하지 않은 편집물이 있으면 회수하지 않는다(force-remove 시 손실 → fresh-resume 전제 붕괴).
  if (!isClean({ cwd: absPath })) {
    return {
      ok: false,
      preserved: true,
      error: `worktree 이미 존재 + 미커밋 작업물 있음 (보존): ${wtPath} — 워커가 커밋 안 한 편집물 손실 방지. 확인 후 회수하려면 수동으로 'git worktree remove --force ${wtPath}'`,
    };
  }

  // 데이터 안전 게이트 (2) — 미머지 커밋 보존. 브랜치 없으면 git status!=0 → 미머지 없음으로 간주(안전 회수).
  const log = git(['log', '--oneline', `${baseBranch}..${branchName}`], opts);
  const hasUnmerged = log.status === 0 && (log.stdout || '').trim() !== '';
  if (hasUnmerged) {
    return {
      ok: false,
      preserved: true,
      error: `worktree 이미 존재 + 미머지 커밋 있음 (보존): ${wtPath} — /pact:resume 또는 수동으로 'git worktree remove --force ${wtPath}'`,
    };
  }

  // clean AND 미머지 없음 → 안전하게 회수 (worktree remove + branch -D + 잔재 rm)
  removeWorktree(taskId, { ...opts, force: true });
  if (fs.existsSync(absPath)) {
    try { fs.rmSync(absPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  git(['branch', '-D', branchName], opts);

  if (fs.existsSync(absPath)) {
    return { ok: false, error: `worktree 회수 실패: ${wtPath}` };
  }
  return { ok: true, action: 'reclaimed' };
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
  detectBaseBranch,
  reconcileWorktree,
  TASK_ID_RE,
  WORKTREE_BASE,
};
