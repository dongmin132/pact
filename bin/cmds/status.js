'use strict';

// pact status — .pact/state.json + worktree + lock + driver-state 정보 표시
// --summary / -s : 한 줄 요약 (메인 세션 prefix 절감용)
// --watch [SECS] : 주기 폴링 (default 2s). 다른 세션 / pact drive 헤드리스 진행 라이브 추적.
//   pact drive 는 채팅에 narration 이 없으므로 → 둘째 터미널에서 `pact status --watch` 가 라이브 모니터.

const fs = require('fs');
const path = require('path');

// pact drive 가 쓰는 헤드리스 진행 상태 (P5 reader side).
// 종료 phase = 드라이버가 정상 마무리. 그 외(spawning/collecting…) = 진행 중.
const TERMINAL_PHASES = new Set(['done', 'aborted']);

function readDriverState() {
  const p = '.pact/driver-state.json';
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  } catch { return null; } // 관측은 best-effort — 깨진 파일이 status 를 막지 않음
}

// ISO timestamp → "3초 전 / 2분 전" (watch 에서 freshness 한눈에). CLI 런타임이라 Date 사용 OK.
function relTime(iso) {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  let s = Math.round((Date.now() - t) / 1000);
  if (s < 0) s = 0;
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

// 0~100% → 블록 게이지. 블록문자는 단일폭이라 CJK 정렬 안 깨짐.
function progressBar(pct, width = 16) {
  const p = Math.max(0, Math.min(100, pct));
  const fill = Math.round((p / 100) * width);
  return '▕' + '█'.repeat(fill) + '░'.repeat(width - fill) + '▏';
}

const PHASE_DOT = { spawning: '🟢', collecting: '🟡', done: '✅', aborted: '🔴' };

// pact drive 진행을 hero 대시보드로 렌더 (watch 모니터 가독성). 줄 배열 반환.
function renderDriverDashboard(drv, isAlive) {
  const rule = '─'.repeat(50);
  const terminal = TERMINAL_PHASES.has(drv.phase);
  // 비종료 phase 인데 드라이버 pid 가 죽었으면 = 크래시, 마지막 상태만 남음.
  const stale = drv.pid != null && !isAlive(drv.pid) && !terminal;
  const dot = stale ? '💀' : (PHASE_DOT[drv.phase] || '⚪');

  const done = drv.done ?? 0;
  const esc = drv.escalated ?? drv.escalations ?? 0;
  const activeN = (drv.active_workers || []).length;

  const out = [rule];
  out.push(`  🤖 pact drive        ${dot} ${drv.phase}${stale ? ' (죽음·마지막 상태)' : ''}`);
  out.push(rule);
  out.push(`  진행   사이클 ${drv.cycle ?? '-'} · 완료 ${done} · 진행중 ${activeN} · escalation ${esc}`);
  if (activeN > 0) out.push(`  활성   ${drv.active_workers.join('  ')}`);
  if (drv.budget) {
    const pct = drv.budget > 0 ? (drv.spent_usd ?? 0) / drv.budget * 100 : 0;
    out.push(`  비용   $${drv.spent_usd ?? 0} / $${drv.budget}  ${progressBar(pct)} ${Math.round(pct)}%`);
  } else {
    out.push(`  비용   $${drv.spent_usd ?? 0}`);
  }
  if (drv.stopped_reason) out.push(`  정지   ${drv.stopped_reason}`);
  out.push(`  갱신   ${relTime(drv.updated_at)}${drv.pid != null ? ` · pid ${drv.pid}` : ''}`);
  out.push(rule);
  return out;
}

function render({ summary } = {}) {
  const statePath = '.pact/state.json';
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { version: 1, current_cycle: 0, active_workers: [] };

  const { listWorktrees, isMergeInProgress } = require(
    path.join(__dirname, '..', '..', 'scripts', 'worktree-manager.js'),
  );
  const { listLocks, isAlive } = require(path.join(__dirname, '..', '..', 'scripts', 'lock.js'));

  let wts = { active: [] };
  try { wts = listWorktrees(); } catch { /* fall through */ }
  const merging = isMergeInProgress();
  const locks = listLocks();
  const drv = readDriverState();

  if (summary) {
    const cycle = state.current_cycle ?? 0;
    const active = (state.active_workers || []).length;
    const wtCount = wts.active ? wts.active.length : 0;
    const merge = merging ? 'in-progress' : 'clean';
    const claimed = locks.filter(l => l.alive).length;
    const drive = drv ? ` drive:${drv.phase} spent:$${drv.spent_usd ?? 0}` : '';
    return `cycle:${cycle} active:${active} worktree:${wtCount} claimed:${claimed} merge:${merge}${drive}\n`;
  }

  const lines = [];

  // pact drive 진행이 있으면 대시보드를 최상단 hero 로 (watch 모니터 가독성).
  if (drv) {
    renderDriverDashboard(drv, isAlive).forEach(l => lines.push(l));
    lines.push('');
  }

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
    process.stdout.write('\x1b[2J\x1b[H'); // clear + home (스크롤백 보존)
    process.stdout.write(`pact status · --watch ${watchSecs}s · ${new Date().toLocaleTimeString()} · Ctrl+C 종료\n\n`);
    process.stdout.write(render({ summary }));
  };
  tick();
  const t = setInterval(tick, watchSecs * 1000);
  process.on('SIGINT', () => { clearInterval(t); process.exit(0); });
};
