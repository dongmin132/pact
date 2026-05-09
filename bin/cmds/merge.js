'use strict';

// pact merge — .pact/runs/*/status.json 기반 머지 게이트
// 결정적 검증 후 통과한 워커만 git merge 시도.
// 충돌 시 즉시 멈춤, abort 안 함 (사용자가 /pact:resolve-conflict).
//
// 강화 (ADR-012): status.json 신뢰 X. 실제 git diff와 payload.allowed_paths 대조:
//   1. 실제 변경 파일이 allowed_paths 외 → 거부 (ownership/계약 위반)
//   2. status.files_changed ≠ 실제 git diff → 거부 (워커 보고 거짓)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateStatus } = require(path.join(__dirname, '..', '..', 'scripts', 'validate-status.js'));
const { mergeAll } = require(path.join(__dirname, '..', '..', 'scripts', 'merge-coordinator.js'));
const { matchesGlob } = require(path.join(__dirname, '..', '..', 'hooks', 'pre-tool-guard.js'));
const { setTaskStatus } = require(path.join(__dirname, '..', '..', 'scripts', 'task-sources.js'));

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
      rejected.push({ task_id: taskId, reason: 'schema 위반: ' + validation.errors.map(e => e.message).join(', ') });
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

    eligible.push(taskId);
  }

  return { eligible, rejected };
}

function executeMerge(args) {
  const quiet = args.includes('--quiet') || args.includes('-q');
  const cwd = process.cwd();
  const plan = planMerge({ cwd });

  if (plan.missing === 'runs_dir') {
    console.error('.pact/runs 없음. cycle 진행 전.');
    process.exit(2);
  }

  const { eligible, rejected } = plan;

  console.log(`머지 대상: ${eligible.length}개 (거부 ${rejected.length}개)`);
  if (!quiet) {
    rejected.forEach(r => console.log(`  ✗ ${r.task_id}: ${r.reason}`));
  } else if (rejected.length > 0) {
    console.error(`(거부 상세 ${rejected.length}건은 .pact/merge-result.json.rejected 참고)`);
  }

  const result = mergeAll(eligible);

  // 머지 성공한 task만 source file에 status:done 박기 (다음 batch에서 제외).
  // 충돌·skipped는 건드리지 않음 (재시도 가능 상태 보존).
  const statusUpdates = [];
  for (const taskId of result.merged) {
    const r = setTaskStatus(taskId, 'done', { cwd });
    statusUpdates.push({ task_id: taskId, ...r });
  }

  const out = {
    timestamp: new Date().toISOString(),
    eligible: eligible.length,
    merged: result.merged,
    conflicted: result.conflicted,
    skipped: result.skipped,
    rejected,
    status_updates: statusUpdates,
  };
  fs.writeFileSync(path.join(cwd, '.pact/merge-result.json'), JSON.stringify(out, null, 2) + '\n');

  if (quiet) {
    console.log(`✓ 머지: ${result.merged.length}개${result.merged.length ? ' (' + result.merged.join(', ') + ')' : ''}`);
  } else {
    console.log(`\n✓ 머지: ${result.merged.length}개`);
    result.merged.forEach(id => console.log(`  ✓ ${id}`));
  }
  if (result.conflicted) {
    console.log(`\n✗ 충돌: ${result.conflicted.task_id}`);
    if (!quiet) {
      console.log(`  files: ${result.conflicted.files.join(', ')}`);
      console.log(`  → /pact:resolve-conflict 또는 git merge --abort`);
      console.log(`  미시도: ${result.skipped.join(', ')}`);
    }
    process.exit(6);
  }
}

module.exports = executeMerge;
module.exports.planMerge = planMerge;
