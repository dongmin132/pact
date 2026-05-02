'use strict';

// PACT-028 — Merge coordinator
//
// W4: cycle 단위 sequential 머지
// W5: 충돌 시 즉시 stop, 자동 해결 X — 사용자 위임
//
// 충돌 발생 시 abort 안 함 (호출자가 인지 후 결정).
// 충돌 상태 정리는 abortMerge 별도 호출.

const { spawnSync } = require('child_process');

function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
  });
}

function branchExists(name, opts) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], opts).status === 0;
}

/**
 * 단일 worktree branch를 현재 branch(보통 main)로 머지.
 * 충돌 시 abort 안 함 — 호출자가 결정.
 */
function mergeWorktree(taskId, opts = {}) {
  const branchName = `pact/${taskId}`;

  if (!branchExists(branchName, opts)) {
    return { ok: false, error: `branch not found: ${branchName}` };
  }

  const r = git(['merge', '--no-ff', '-m', `pact: merge ${branchName}`, branchName], opts);
  if (r.status === 0) {
    return { ok: true, branch_name: branchName };
  }

  // 충돌 파일 추출
  const diff = git(['diff', '--name-only', '--diff-filter=U'], opts);
  const conflictedFiles = diff.stdout.trim().split('\n').filter(Boolean);

  return {
    ok: false,
    branch_name: branchName,
    conflicted_files: conflictedFiles,
    error: (r.stderr || '').trim() || 'merge conflict',
  };
}

/**
 * 다수 worktree 순차 머지. 충돌 시 즉시 stop.
 * @returns {{merged: string[], conflicted: object|null, skipped: string[]}}
 */
function mergeAll(taskIds, opts = {}) {
  const merged = [];
  const skipped = [];
  let conflicted = null;

  for (let i = 0; i < taskIds.length; i++) {
    const id = taskIds[i];
    const r = mergeWorktree(id, opts);
    if (r.ok) {
      merged.push(id);
    } else {
      conflicted = {
        task_id: id,
        branch_name: r.branch_name,
        files: r.conflicted_files || [],
        error: r.error,
      };
      skipped.push(...taskIds.slice(i + 1));
      break;
    }
  }

  return { merged, conflicted, skipped };
}

/** git merge --abort. 충돌 상태 정리. */
function abortMerge(opts = {}) {
  const r = git(['merge', '--abort'], opts);
  return { ok: r.status === 0, error: (r.stderr || '').trim() };
}

module.exports = {
  mergeWorktree,
  mergeAll,
  abortMerge,
};
