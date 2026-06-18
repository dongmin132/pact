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

// ANSI 색 — TTY 일 때만 (파이프·리다이렉트·테스트는 평문 유지 → 출력 안 깨짐, 기존 assert 보존).
const COLOR = !!process.stdout.isTTY;
const C = COLOR
  ? { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', bold: '\x1b[1m', rst: '\x1b[0m' }
  : { dim: '', red: '', grn: '', yel: '', bold: '', rst: '' };
const paint = (s, code) => (code ? code + s + C.rst : String(s));
const PHASE_COLOR = { spawning: C.grn, collecting: C.yel, done: C.grn, aborted: C.red };

// pact drive 진행을 hero 대시보드로 렌더 (watch 모니터 가독성 — 색·신호등·비용바). 줄 배열 반환.
function renderDriverDashboard(drv, isAlive) {
  const rule = paint('─'.repeat(50), C.dim);
  const terminal = TERMINAL_PHASES.has(drv.phase);
  // 비종료 phase 인데 드라이버 pid 가 죽었으면 = 크래시, 마지막 상태만 남음.
  const stale = drv.pid != null && !isAlive(drv.pid) && !terminal;
  const dot = stale ? '💀' : (PHASE_DOT[drv.phase] || '⚪');
  const phaseCol = stale ? C.red : (PHASE_COLOR[drv.phase] || C.dim);
  const L = (s) => paint(s, C.dim); // 라벨 dim → 값이 두드러짐

  const done = drv.done ?? 0;
  const esc = drv.escalated ?? drv.escalations ?? 0;
  const activeN = (drv.active_workers || []).length;

  const out = [rule];
  out.push(`  🤖 ${paint('pact drive', C.bold)}        ${dot} ${paint(drv.phase, phaseCol + C.bold)}${stale ? paint(' (죽음·마지막 상태)', C.red + C.bold) : ''}`);
  out.push(rule);
  const escTxt = esc > 0 ? paint(`escalation ${esc}`, C.red + C.bold) : `escalation ${esc}`;
  out.push(`  ${L('진행')}   사이클 ${drv.cycle ?? '-'} · 완료 ${paint(done, C.grn)} · 진행중 ${activeN} · ${escTxt}`);
  if (activeN > 0) out.push(`  ${L('활성')}   ${drv.active_workers.join('  ')}`);
  if (drv.budget) {
    const pct = drv.budget > 0 ? (drv.spent_usd ?? 0) / drv.budget * 100 : 0;
    const barCol = pct >= 90 ? C.red : pct >= 70 ? C.yel : C.grn; // 예산 임계 70/90%
    out.push(`  ${L('비용')}   $${drv.spent_usd ?? 0} / $${drv.budget}  ${paint(progressBar(pct), barCol)} ${paint(Math.round(pct) + '%', barCol)}`);
  } else {
    out.push(`  ${L('비용')}   $${drv.spent_usd ?? 0}`);
  }
  if (drv.stopped_reason) out.push(`  ${L('정지')}   ${paint(drv.stopped_reason, C.red)}`);
  out.push(`  ${L('갱신')}   ${paint(relTime(drv.updated_at) + (drv.pid != null ? ` · pid ${drv.pid}` : ''), C.dim)}`);
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

  // --watch 모드: 깜빡임 없는 제자리 갱신. Ctrl+C로 종료.
  // 매 틱 전체 clear(\x1b[2J)는 화면이 한 번 비었다 다시 차서 깜빡임 → 대신 커서만 홈으로
  // 보내 덮어쓰고, 줄끝(\x1b[K)·아래(\x1b[J)만 지워 잔상 제거. 첫 프레임만 전체 clear.
  const isTTY = !!process.stdout.isTTY;
  let first = true;
  const tick = () => {
    const header = `pact status · --watch ${watchSecs}s · ${new Date().toLocaleTimeString()} · Ctrl+C 종료`;
    const frame = `${header}\n\n${render({ summary })}`;
    if (!isTTY) { process.stdout.write(frame + '\n'); return; } // 파이프/리다이렉트: 그냥 프레임
    const lines = frame.split('\n');
    const out = (first ? '\x1b[2J' : '') + '\x1b[H'      // 첫 프레임만 전체 clear, 이후 커서 홈만
      + lines.map((l) => l + '\x1b[K').join('\n')        // 각 줄 끝까지 지움(이전 더 긴 줄 잔상 제거)
      + '\x1b[J';                                        // 커서 아래 잔여 줄 제거(프레임이 짧아졌을 때)
    process.stdout.write(out);
    first = false;
  };
  if (isTTY) process.stdout.write('\x1b[?25l'); // 커서 숨김 — 깜빡이는 커서 자체도 시각 노이즈
  tick();
  const t = setInterval(tick, watchSecs * 1000);
  const stop = () => { clearInterval(t); if (isTTY) process.stdout.write('\x1b[?25h'); process.stdout.write('\n'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};
