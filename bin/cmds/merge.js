'use strict';

// pact merge — .pact/runs/*/status.json 기반 머지 게이트
// 결정적 검증 후 통과한 워커만 git merge 시도.
// 충돌 시 즉시 멈춤, abort 안 함 (사용자가 /pact:resolve-conflict).

const fs = require('fs');
const path = require('path');

module.exports = function merge(args) {
  const runsRoot = '.pact/runs';
  if (!fs.existsSync(runsRoot)) {
    console.error('.pact/runs 없음. cycle 진행 전.');
    process.exit(2);
  }

  const { validateStatus } = require(path.join(__dirname, '..', '..', 'scripts', 'validate-status.js'));
  const { mergeAll } = require(path.join(__dirname, '..', '..', 'scripts', 'merge-coordinator.js'));

  const taskDirs = fs.readdirSync(runsRoot).filter(d => {
    const full = path.join(runsRoot, d);
    return fs.statSync(full).isDirectory();
  });

  const eligible = [];
  const rejected = [];

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
      rejected.push({ task_id: taskId, reason: 'ownership 위반: ' + status.files_attempted_outside_scope.join(', ') });
      continue;
    }

    // verify_results 체크: fail 0이어야 함
    const failed = Object.entries(status.verify_results || {})
      .filter(([_, v]) => v === 'fail')
      .map(([k]) => k);
    if (failed.length > 0) {
      rejected.push({ task_id: taskId, reason: `verify fail: ${failed.join(', ')}` });
      continue;
    }

    eligible.push(taskId);
  }

  console.log(`머지 대상: ${eligible.length}개 (거부 ${rejected.length}개)`);
  rejected.forEach(r => console.log(`  ✗ ${r.task_id}: ${r.reason}`));

  const result = mergeAll(eligible);

  const out = {
    timestamp: new Date().toISOString(),
    eligible: eligible.length,
    merged: result.merged,
    conflicted: result.conflicted,
    skipped: result.skipped,
    rejected,
  };
  fs.writeFileSync('.pact/merge-result.json', JSON.stringify(out, null, 2) + '\n');

  console.log(`\n✓ 머지: ${result.merged.length}개`);
  result.merged.forEach(id => console.log(`  ✓ ${id}`));
  if (result.conflicted) {
    console.log(`\n✗ 충돌: ${result.conflicted.task_id}`);
    console.log(`  files: ${result.conflicted.files.join(', ')}`);
    console.log(`  → /pact:resolve-conflict 또는 git merge --abort`);
    console.log(`  미시도: ${result.skipped.join(', ')}`);
    process.exit(6);
  }
};
