'use strict';

// pact status — .pact/state.json + worktree 정보 표시

const fs = require('fs');
const path = require('path');

module.exports = function status(args) {
  const statePath = '.pact/state.json';
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { version: 1, current_cycle: 0, active_workers: [] };

  console.log('📊 pact status\n');
  console.log(`Cycle: ${state.current_cycle}`);
  console.log(`활성 워커: ${(state.active_workers || []).length}개`);

  // worktree
  try {
    const { listWorktrees } = require(path.join(__dirname, '..', '..', 'scripts', 'worktree-manager.js'));
    const wts = listWorktrees();
    if (wts.active && wts.active.length > 0) {
      console.log(`\nWorktree (${wts.active.length}):`);
      wts.active.forEach(w => console.log(`  ${w.task_id}  ${w.branch || ''}`));
    } else {
      console.log('\nWorktree: 없음');
    }
  } catch (e) {
    console.log(`\nWorktree: 조회 실패 — ${e.message}`);
  }

  // 머지 진행 중?
  const { spawnSync } = require('child_process');
  const merge = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merge.status === 0) {
    console.log('\n⚠️ 머지 진행 중 (충돌 미해결?). /pact:resolve-conflict');
  } else {
    console.log('\n머지: clean');
  }
};
