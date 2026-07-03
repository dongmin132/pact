'use strict';

// pact merge — .pact/runs/*/status.json 기반 머지 게이트 (얇은 CLI)
// 결정적 검증 후 통과한 워커만 git merge 시도.
// 충돌 시 즉시 멈춤, abort 안 함 (사용자가 /pact:resolve-conflict).
//
// STR-5 (P3-A): 순수 검증 코어 planMerge 는 scripts/merge-coordinator.js 로 co-locate 되어
// (mergeAll 옆) run-cycle 의 형제 bin/cmds import 레이어 역전을 없앴다. 이 파일은 그 코어를
// 호출하는 얇은 CLI 만 담는다. planMerge 는 하위호환 위해 재export.

const fs = require('fs');
const path = require('path');

const { planMerge, mergeAll } = require(path.join(__dirname, '..', '..', 'scripts', 'merge-coordinator.js'));
const { setTaskStatus } = require(path.join(__dirname, '..', '..', 'scripts', 'task-sources.js'));
const { generateAll: generateReports } = require(path.join(__dirname, '..', '..', 'scripts', 'report-gen.js'));

function executeMerge(args) {
  const quiet = args.includes('--quiet') || args.includes('-q');
  const cwd = process.cwd();

  // WC-2: planMerge 는 report.md 존재를 게이트한다. 신규 종료 ceremony 의 워커는 report.md 를
  // 수기 작성하지 않으므로(status.json 만), collect 를 거치지 않는 standalone `pact merge` 도
  // collect/collect-one 과 동일하게 status.json → report.md 를 게이트 이전에 결정적으로 렌더한다.
  // 수기 report.md 는 존중(generateReports 가 존재 시 skip). 없으면 렌더 → 존재 게이트 tautology 화.
  generateReports({ cwd });

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
