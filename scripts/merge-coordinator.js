'use strict';

// PACT-028 — Merge coordinator
//
// W4: cycle 단위 sequential 머지
// W5: 충돌 시 즉시 stop, 자동 해결 X — 사용자 위임
//
// 충돌 발생 시 abort 안 함 (호출자가 인지 후 결정).
// 충돌 상태 정리는 abortMerge 별도 호출.
//
// STR-5 (P3-A): planMerge(머지 전 결정적 검증)를 여기로 co-locate. 기존엔 bin/cmds/merge.js
// 안에 있어 run-cycle(collect·collect-one)가 형제 bin/cmds 를 라이브러리로 import 하는 레이어
// 역전이었다. 순수 코어(사이드이펙트 X)는 scripts 레이어가 SOT — bin/cmds 는 얇은 CLI 만.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateStatus } = require('./validate-status.js');
const { matchesGlob } = require('../hooks/pre-tool-guard.js');

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
    // pact 브랜치는 머지 성공 후 removeWorktree 가 branch -D 로만 삭제한다.
    // 따라서 collect 재진입에서 branch 없음 = "이전 cycle 에 이미 머지+정리됨" 신호.
    // branch_missing 플래그로 구분 (호출부 mergeAll 이 충돌이 아닌 already_merged 로 처리).
    return { ok: false, branch_missing: true, branch_name: branchName, error: `branch not found: ${branchName}` };
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
 * 다수 worktree 순차 머지. 실제 충돌 시 즉시 stop.
 * branch 없음(이미 머지+정리됨)은 충돌이 아니라 already_merged 로 처리하고 계속 — 재진입 안전(버그 #6).
 * @returns {{merged: string[], already_merged: string[], conflicted: object|null, skipped: string[]}}
 */
function mergeAll(taskIds, opts = {}) {
  const merged = [];
  const alreadyMerged = [];
  const skipped = [];
  let conflicted = null;

  for (let i = 0; i < taskIds.length; i++) {
    const id = taskIds[i];
    const r = mergeWorktree(id, opts);
    if (r.ok) {
      merged.push(id);
    } else if (r.branch_missing) {
      // 이전 cycle 에 이미 머지+정리됨 — 충돌 아님, 멈추지 않고 계속.
      alreadyMerged.push(id);
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

  return { merged, already_merged: alreadyMerged, conflicted, skipped };
}

/** git merge --abort. 충돌 상태 정리. */
function abortMerge(opts = {}) {
  const r = git(['merge', '--abort'], opts);
  return { ok: r.status === 0, error: (r.stderr || '').trim() };
}

function actualDiff(baseBranch, branchName, opts = {}) {
  const r = spawnSync('git', ['diff', '--name-only', `${baseBranch}...${branchName}`], {
    encoding: 'utf8',
    cwd: opts.cwd || process.cwd(),
  });
  if (r.status !== 0) return null;
  return r.stdout.trim().split('\n').filter(Boolean);
}

/**
 * 머지 전 결정적 검증. 사이드이펙트 X.
 *
 * status.json 신뢰 X (ADR-012). 실제 git diff 와 payload.allowed_paths 대조:
 *   1. 실제 변경 파일이 allowed_paths 외 → 거부 (ownership/계약 위반)
 *   2. status.files_changed ≠ 실제 git diff → 거부 (워커 보고 거짓)
 *
 * @param {object} [opts]
 * @param {string[]} [opts.taskIds] — 검증 대상 task_id 목록 (없으면 .pact/runs/* 전체)
 * @param {string} [opts.runsRoot]
 * @param {string} [opts.cwd]
 * @returns {{eligible: string[], rejected: {task_id, reason}[]}}
 */
function planMerge(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runsRoot = opts.runsRoot || path.join(cwd, '.pact/runs');

  const eligible = [];
  const rejected = [];

  if (!fs.existsSync(runsRoot)) {
    return { eligible, rejected, missing: 'runs_dir' };
  }

  const taskDirs = opts.taskIds || fs.readdirSync(runsRoot).filter(d => {
    const full = path.join(runsRoot, d);
    return fs.statSync(full).isDirectory();
  });

  for (const taskId of taskDirs) {
    const statusPath = path.join(runsRoot, taskId, 'status.json');
    if (!fs.existsSync(statusPath)) {
      rejected.push({ task_id: taskId, reason: 'status.json missing' });
      continue;
    }

    let status;
    try {
      status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch (e) {
      rejected.push({ task_id: taskId, reason: `status.json parse: ${e.message}` });
      continue;
    }

    const validation = validateStatus(status);
    if (!validation.ok) {
      // issue #3 — error message에 instancePath 포함. worker가 어느 필드 어떤 형태인지 즉시 파악.
      rejected.push({
        task_id: taskId,
        reason: 'schema 위반: ' + validation.errors.map(e => `${e.path} ${e.message}`).join('; '),
      });
      continue;
    }

    if (status.status !== 'done') {
      rejected.push({ task_id: taskId, reason: `status=${status.status}` });
      continue;
    }
    if (!status.clean_for_merge) {
      rejected.push({ task_id: taskId, reason: 'clean_for_merge=false' });
      continue;
    }
    if (status.files_attempted_outside_scope && status.files_attempted_outside_scope.length > 0) {
      rejected.push({ task_id: taskId, reason: 'ownership 위반(자기 보고): ' + status.files_attempted_outside_scope.join(', ') });
      continue;
    }

    const failed = Object.entries(status.verify_results || {})
      .filter(([_, v]) => v === 'fail')
      .map(([k]) => k);
    if (failed.length > 0) {
      rejected.push({ task_id: taskId, reason: `verify fail: ${failed.join(', ')}` });
      continue;
    }

    const payloadPath = path.join(runsRoot, taskId, 'payload.json');
    if (!fs.existsSync(payloadPath)) {
      rejected.push({ task_id: taskId, reason: 'payload.json missing — allowed_paths 검증 불가' });
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    } catch (e) {
      rejected.push({ task_id: taskId, reason: `payload.json parse: ${e.message}` });
      continue;
    }
    const allowedPaths = payload.allowed_paths || [];
    const baseBranch = payload.base_branch || 'main';
    const branchName = `pact/${taskId}`;

    const diff = actualDiff(baseBranch, branchName, { cwd });
    if (diff === null) {
      rejected.push({ task_id: taskId, reason: `git diff 실패 (${baseBranch}...${branchName})` });
      continue;
    }

    const outsideScope = diff.filter(f => !allowedPaths.some(g => matchesGlob(f, g)));
    if (outsideScope.length > 0) {
      rejected.push({
        task_id: taskId,
        reason: `git diff에 allowed_paths 외 파일: ${outsideScope.join(', ')} (워커 자기 보고와 무관)`,
      });
      continue;
    }

    const reported = (status.files_changed || []).slice().sort();
    const actual = diff.slice().sort();
    if (JSON.stringify(reported) !== JSON.stringify(actual)) {
      rejected.push({
        task_id: taskId,
        reason: `files_changed 보고(${reported.join(',') || '(빈)'}) ≠ 실제 diff(${actual.join(',') || '(빈)'})`,
      });
      continue;
    }

    // ADR-049 — report.md 존재 게이트 (마지막 — 보안 게이트 ADR-012 통과 후 입력 품질 검증).
    // SPD-5(P1-4): collect 가 머지 직전 report-gen(status.json→report.md)을 결정적으로 렌더하므로
    // report.md 존재는 보장된다 → "비공백 10줄" 검사는 이제 템플릿이 자동 충족하는 tautology 라 제거.
    // 존재 검사만 유지: standalone `pact merge` 경로(collect 미경유)의 회귀 안전망.
    const reportPath = path.join(runsRoot, taskId, 'report.md');
    if (!fs.existsSync(reportPath)) {
      rejected.push({ task_id: taskId, reason: 'report.md missing' });
      continue;
    }

    eligible.push(taskId);
  }

  return { eligible, rejected };
}

module.exports = {
  mergeWorktree,
  mergeAll,
  abortMerge,
  planMerge,
};
