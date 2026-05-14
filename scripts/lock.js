'use strict';

// pact multi-session lock — v0.6.0 (멀티세션 sibling 패턴)
//
// 목적: cmux/tmux 등으로 여러 Claude Code 세션을 동시 띄울 때 같은 task를
//       두 세션이 잡지 못하게 한다. .pact/runs/<task_id>/lock.pid 파일 기반.
//
// stale 처리: 락 파일의 PID가 더 이상 살아있지 않으면 takeover 허용.

const fs = require('fs');
const path = require('path');

function lockPath(cwd, taskId) {
  return path.join(cwd, '.pact', 'runs', taskId, 'lock.pid');
}

function cycleLockPath(cwd) {
  return path.join(cwd, '.pact', 'cycle.lock');
}

function isAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 = process 존재 여부만 검사 (실제 신호 전달 X)
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM이면 살아있음 (다른 사용자), ESRCH면 죽음
    return e.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 락 획득. 이미 살아있는 lock 있으면 거부. stale lock(죽은 PID)은 takeover.
 *
 * @param {string} taskId
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.pid] — 명시적 PID (테스트용). 기본 process.pid.
 * @param {string} [opts.sessionLabel] — cmux 패널 ID 같은 사람 식별자 (선택).
 * @returns {{ok: true, file: string, action: 'fresh'|'takeover'} | {ok: false, error: string, holder?: object}}
 */
function acquireLock(taskId, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const file = lockPath(cwd, taskId);
  const runDir = path.dirname(file);

  if (!fs.existsSync(runDir)) {
    return { ok: false, error: `run dir 없음: ${runDir} (pact run-cycle prepare 먼저)` };
  }

  let action = 'fresh';
  if (fs.existsSync(file)) {
    const holder = readLock(file);
    if (holder && isAlive(holder.pid)) {
      return { ok: false, error: `이미 점유 중 (pid=${holder.pid}${holder.session_label ? `, session=${holder.session_label}` : ''})`, holder };
    }
    action = 'takeover';
  }

  const payload = {
    pid,
    task_id: taskId,
    session_label: opts.sessionLabel || null,
    acquired_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return { ok: true, file, action };
}

/**
 * 락 해제. 자기 PID와 일치할 때만 삭제 (다른 세션 lock 실수로 풀지 않게).
 *
 * @param {string} taskId
 * @param {object} [opts]
 * @param {boolean} [opts.force] — true면 PID 검사 생략
 * @returns {{ok: boolean, error?: string, removed?: boolean}}
 */
function releaseLock(taskId, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const file = lockPath(cwd, taskId);

  if (!fs.existsSync(file)) return { ok: true, removed: false };

  const holder = readLock(file);
  if (!opts.force && holder && holder.pid !== pid) {
    return { ok: false, error: `다른 PID(${holder.pid})가 점유 중. force 필요.` };
  }

  fs.unlinkSync(file);
  return { ok: true, removed: true };
}

/**
 * 자기 PID가 잡고 있는 모든 lock 해제 (SessionEnd hook용).
 * @returns {{released: string[], skipped: string[]}}
 */
function releaseAllByPid(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const runsDir = path.join(cwd, '.pact', 'runs');
  const released = [];
  const skipped = [];

  if (!fs.existsSync(runsDir)) return { released, skipped };

  for (const taskId of fs.readdirSync(runsDir)) {
    const file = lockPath(cwd, taskId);
    if (!fs.existsSync(file)) continue;
    const holder = readLock(file);
    if (holder && holder.pid === pid) {
      try {
        fs.unlinkSync(file);
        released.push(taskId);
      } catch {
        skipped.push(taskId);
      }
    }
  }
  return { released, skipped };
}

/**
 * stale lock(죽은 PID) 일괄 정리 — task lock + cycle lock.
 * @returns {{cleaned: string[]}}
 */
function cleanStaleLocks(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runsDir = path.join(cwd, '.pact', 'runs');
  const cleaned = [];

  if (fs.existsSync(runsDir)) {
    for (const taskId of fs.readdirSync(runsDir)) {
      const file = lockPath(cwd, taskId);
      if (!fs.existsSync(file)) continue;
      const holder = readLock(file);
      if (!holder || !isAlive(holder.pid)) {
        try {
          fs.unlinkSync(file);
          cleaned.push(taskId);
        } catch { /* ignore */ }
      }
    }
  }

  // cycle lock (v0.6.1) — prepare/collect 도중 죽은 세션 잔재
  const cycleFile = cycleLockPath(cwd);
  if (fs.existsSync(cycleFile)) {
    const holder = readLock(cycleFile);
    if (!holder || !isAlive(holder.pid)) {
      try {
        fs.unlinkSync(cycleFile);
        cleaned.push('__cycle__');
      } catch { /* ignore */ }
    }
  }

  return { cleaned };
}

/**
 * 사이클 lock 획득 (prepare/collect 동시 호출 차단, v0.6.1).
 * stale 시 takeover.
 */
function acquireCycleLock(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const file = cycleLockPath(cwd);
  const pactDir = path.dirname(file);

  if (!fs.existsSync(pactDir)) fs.mkdirSync(pactDir, { recursive: true });

  let action = 'fresh';
  if (fs.existsSync(file)) {
    const holder = readLock(file);
    if (holder && isAlive(holder.pid)) {
      return {
        ok: false,
        error: `사이클이 다른 세션에서 진행 중 (pid=${holder.pid}${holder.stage ? `, stage=${holder.stage}` : ''})`,
        holder,
      };
    }
    action = 'takeover';
  }

  const payload = {
    pid,
    stage: opts.stage || null,
    acquired_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return { ok: true, file, action };
}

function releaseCycleLock(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const file = cycleLockPath(cwd);

  if (!fs.existsSync(file)) return { ok: true, removed: false };

  const holder = readLock(file);
  if (!opts.force && holder && holder.pid !== pid) {
    return { ok: false, error: `다른 PID(${holder.pid})가 사이클 진행 중. force 필요.` };
  }

  fs.unlinkSync(file);
  return { ok: true, removed: true };
}

function readCycleLock(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const file = cycleLockPath(cwd);
  if (!fs.existsSync(file)) return null;
  const holder = readLock(file);
  if (!holder) return null;
  return { ...holder, alive: isAlive(holder.pid) };
}

/**
 * 현재 잡혀 있는 모든 락 목록.
 * @returns {Array<{task_id, pid, session_label, acquired_at, alive}>}
 */
function listLocks(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runsDir = path.join(cwd, '.pact', 'runs');
  const out = [];

  if (!fs.existsSync(runsDir)) return out;

  for (const taskId of fs.readdirSync(runsDir)) {
    const file = lockPath(cwd, taskId);
    if (!fs.existsSync(file)) continue;
    const holder = readLock(file);
    if (!holder) continue;
    out.push({
      task_id: taskId,
      pid: holder.pid,
      session_label: holder.session_label,
      acquired_at: holder.acquired_at,
      alive: isAlive(holder.pid),
    });
  }
  return out;
}

module.exports = {
  acquireLock,
  releaseLock,
  releaseAllByPid,
  cleanStaleLocks,
  listLocks,
  isAlive,
  lockPath,
  acquireCycleLock,
  releaseCycleLock,
  readCycleLock,
  cycleLockPath,
};
