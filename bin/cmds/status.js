'use strict';

// pact status — .pact/state.json + worktree 정보 표시
// --summary / -s : 한 줄 요약 (메인 세션 prefix 절감용)

const fs = require('fs');
const path = require('path');

module.exports = function status(args) {
  const summary = args.includes('--summary') || args.includes('-s');

  const statePath = '.pact/state.json';
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { version: 1, current_cycle: 0, active_workers: [] };

  const { listWorktrees, isMergeInProgress } = require(
    path.join(__dirname, '..', '..', 'scripts', 'worktree-manager.js'),
  );

  let wts = { active: [] };
  try { wts = listWorktrees(); } catch { /* fall through */ }
  const merging = isMergeInProgress();

  if (summary) {
    const cycle = state.current_cycle ?? 0;
    const active = (state.active_workers || []).length;
    const wtCount = wts.active ? wts.active.length : 0;
    const merge = merging ? 'in-progress' : 'clean';
    process.stdout.write(`cycle:${cycle} active:${active} worktree:${wtCount} merge:${merge}\n`);
    return;
  }

  console.log('📊 pact status\n');
  console.log(`Cycle: ${state.current_cycle}`);
  console.log(`활성 워커: ${(state.active_workers || []).length}개`);

  if (wts.active && wts.active.length > 0) {
    console.log(`\nWorktree (${wts.active.length}):`);
    wts.active.forEach(w => console.log(`  ${w.task_id}  ${w.branch || ''}`));
  } else {
    console.log('\nWorktree: 없음');
  }

  if (merging) {
    console.log('\n⚠️ 머지 진행 중 (충돌 미해결?). /pact:resolve-conflict');
  } else {
    console.log('\n머지: clean');
  }
};
