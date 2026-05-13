'use strict';

// pact status — .pact/state.json + worktree + lock 정보 표시
// --summary / -s : 한 줄 요약 (메인 세션 prefix 절감용)
// --watch [SECS] : 주기 폴링 (default 2s). 다른 세션 진행 추적용.

const fs = require('fs');
const path = require('path');

function render({ summary } = {}) {
  const statePath = '.pact/state.json';
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { version: 1, current_cycle: 0, active_workers: [] };

  const { listWorktrees, isMergeInProgress } = require(
    path.join(__dirname, '..', '..', 'scripts', 'worktree-manager.js'),
  );
  const { listLocks } = require(path.join(__dirname, '..', '..', 'scripts', 'lock.js'));

  let wts = { active: [] };
  try { wts = listWorktrees(); } catch { /* fall through */ }
  const merging = isMergeInProgress();
  const locks = listLocks();

  if (summary) {
    const cycle = state.current_cycle ?? 0;
    const active = (state.active_workers || []).length;
    const wtCount = wts.active ? wts.active.length : 0;
    const merge = merging ? 'in-progress' : 'clean';
    const claimed = locks.filter(l => l.alive).length;
    return `cycle:${cycle} active:${active} worktree:${wtCount} claimed:${claimed} merge:${merge}\n`;
  }

  const lines = [];
  lines.push('📊 pact status\n');
  lines.push(`Cycle: ${state.current_cycle}`);
  lines.push(`활성 워커: ${(state.active_workers || []).length}개`);

  if (wts.active && wts.active.length > 0) {
    lines.push(`\nWorktree (${wts.active.length}):`);
    wts.active.forEach(w => lines.push(`  ${w.task_id}  ${w.branch || ''}`));
  } else {
    lines.push('\nWorktree: 없음');
  }

  if (locks.length > 0) {
    lines.push(`\nLock (${locks.length}):`);
    locks.forEach(l => {
      const aliveTag = l.alive ? '🟢' : '🔴 stale';
      const label = l.session_label ? ` [${l.session_label}]` : '';
      lines.push(`  ${aliveTag} ${l.task_id} pid=${l.pid}${label} acquired=${l.acquired_at}`);
    });
  }

  if (merging) {
    lines.push('\n⚠️ 머지 진행 중 (충돌 미해결?). /pact:resolve-conflict');
  } else {
    lines.push('\n머지: clean');
  }

  return lines.join('\n') + '\n';
}

function parseWatchInterval(args) {
  const idx = args.indexOf('--watch');
  if (idx < 0) return null;
  const val = args[idx + 1];
  const secs = val && !val.startsWith('-') ? parseFloat(val) : 2;
  if (!Number.isFinite(secs) || secs < 0.5) return 2;
  return secs;
}

module.exports = function status(args) {
  const summary = args.includes('--summary') || args.includes('-s');
  const watchSecs = parseWatchInterval(args);

  if (watchSecs === null) {
    process.stdout.write(render({ summary }));
    return;
  }

  // --watch 모드: 주기 폴링. Ctrl+C로 종료.
  const tick = () => {
    process.stdout.write('\x1bc'); // clear (ANSI reset)
    process.stdout.write(`(--watch ${watchSecs}s, Ctrl+C로 종료)\n\n`);
    process.stdout.write(render({ summary }));
  };
  tick();
  const t = setInterval(tick, watchSecs * 1000);
  process.on('SIGINT', () => { clearInterval(t); process.exit(0); });
};
