'use strict';

// pact multi-session lock — v0.6.0 (멀티세션 sibling 패턴)
//
// 목적: cmux/tmux 등으로 여러 Claude Code 세션을 동시 띄울 때 같은 task를
//       두 세션이 잡지 못하게 한다. .pact/runs/<task_id>/lock.pid 파일 기반.
//
// stale 처리: 락 파일의 PID가 더 이상 살아있지 않으면 takeover 허용.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileExclusive } = require('./lib/atomic-write.js');

// 같은-부팅 잔여 락 백스톱: 24h 초과 시 회수(6h는 장시간 세션 강탈 위험이라 금지).
const LOCK_TTL_MS = 24 * 60 * 60 * 1000;
// 부팅 시각 양자화 버킷(초). 1버킷 이내 차이는 rounding jitter 로 보고 같은 부팅 취급.
const BOOT_EPOCH_BUCKET = 10;

function lockPath(cwd, taskId) {
  return path.join(cwd, '.pact', 'runs', taskId, 'lock.pid');
}

function cycleLockPath(cwd) {
  return path.join(cwd, '.pact', 'cycle.lock');
}

function driveOwnerPath(cwd) {
  return path.join(cwd, '.pact', 'drive-owner.json');
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
 * 현재 부팅 시각을 10초 버킷으로 양자화(크로스플랫폼: os.uptime 사용).
 * 재부팅하면 값이 크게 바뀌므로, PID 재사용으로 인한 영구락을 stale 판정에서 구분할 수 있다.
 * @returns {number} — 10의 배수(epoch seconds 근사, 10초 버킷)
 */
function currentBootEpoch() {
  return Math.round((Date.now() / 1000 - os.uptime()) / BOOT_EPOCH_BUCKET) * BOOT_EPOCH_BUCKET;
}

/**
 * 락 holder 가 stale(회수 가능)인지 판정하고 사유를 돌려준다.
 * - boot_epoch 가 현재와 1버킷(10초) 초과 차이 → 재부팅 후 PID 재사용, isAlive 무관 stale.
 * - 같은 부팅: 죽은 pid 는 즉시 stale, 살아있어도 acquired_at 기준 24h TTL 초과면 stale.
 * - boot_epoch 부재(구버전 락): 순수 isAlive 판정(기존 동작, 하위호환).
 * @param {object|null} holder — readLock 결과(파싱 실패면 null)
 * @param {object} [opts]
 * @param {number} [opts.bootEpoch] — 현재 부팅 epoch(주입용, 기본 currentBootEpoch())
 * @param {number} [opts.now] — 현재 시각 ms(주입용, 기본 Date.now())
 * @returns {null|'deadPid'|'reclaimedByReboot'|'reclaimedByTTL'} — null=유효(유지), 문자열=회수 사유
 */
function staleReason(holder, opts = {}) {
  if (!holder) return 'deadPid'; // 파싱 불가 = 정리 대상
  const hasBoot = typeof holder.boot_epoch === 'number' && Number.isFinite(holder.boot_epoch);
  if (hasBoot) {
    const cur = typeof opts.bootEpoch === 'number' ? opts.bootEpoch : currentBootEpoch();
    if (Math.abs(holder.boot_epoch - cur) > BOOT_EPOCH_BUCKET) return 'reclaimedByReboot';
    if (!isAlive(holder.pid)) return 'deadPid';
    // 살아있음 — 같은 부팅 내 pid 재사용/락만 남은 세션 대비 24h TTL 백스톱.
    const acquiredMs = holder.acquired_at ? Date.parse(holder.acquired_at) : NaN;
    if (Number.isFinite(acquiredMs)) {
      const now = typeof opts.now === 'number' ? opts.now : Date.now();
      if (now - acquiredMs > LOCK_TTL_MS) return 'reclaimedByTTL';
    }
    return null;
  }
  // 하위호환: boot_epoch 부재 → 순수 isAlive 판정
  return isAlive(holder.pid) ? null : 'deadPid';
}

/** staleReason 이 null(유효)이면 여전히 점유 중 → takeover/정리 금지. */
function isHeld(holder, opts = {}) {
  return staleReason(holder, opts) === null;
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
  let stalePath = null;
  if (fs.existsSync(file)) {
    const holder = readLock(file);
    if (holder && isHeld(holder)) {
      return { ok: false, error: `이미 점유 중 (pid=${holder.pid}${holder.session_label ? `, session=${holder.session_label}` : ''})`, holder };
    }
    // stale(죽은 PID·재부팅·TTL) — 기존 파일을 옆으로 치우고 배타적으로 재공개.
    // rename 은 원자적이라 동시 takeover 자여도 단일 승자로 수렴한다(STAB-2).
    action = 'takeover';
    stalePath = `${file}.stale.${pid}.${Date.now()}`;
    try { fs.renameSync(file, stalePath); } catch { stalePath = null; }
  }

  const payload = {
    pid,
    task_id: taskId,
    session_label: opts.sessionLabel || null,
    acquired_at: new Date().toISOString(),
    boot_epoch: currentBootEpoch(),
  };
  // 배타적 공개 — check-then-write TOCTOU 대신 link 기반 원자 획득(STAB-2).
  const won = writeFileExclusive(file, JSON.stringify(payload, null, 2) + '\n');
  if (stalePath) { try { fs.unlinkSync(stalePath); } catch { /* best-effort */ } }
  if (!won) {
    // 그 찰나 다른 세션이 이미 획득 — 기존과 동일한 실패 반환.
    const holder = readLock(file);
    return {
      ok: false,
      error: `이미 점유 중 (pid=${holder ? holder.pid : '?'}${holder && holder.session_label ? `, session=${holder.session_label}` : ''})`,
      holder: holder || undefined,
    };
  }
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
 * stale lock 일괄 정리 — task lock + cycle lock.
 * 회수 사유를 구분(STAB-5): 죽은 pid(deadPid) / 재부팅 후 pid 재사용(reclaimedByReboot) /
 * 같은-부팅 24h TTL 초과(reclaimedByTTL). `cleaned` 는 하위호환용 전체 목록.
 * @returns {{cleaned: string[], reclaimedByReboot: string[], reclaimedByTTL: string[], deadPid: string[]}}
 */
function cleanStaleLocks(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runsDir = path.join(cwd, '.pact', 'runs');
  const cleaned = [];
  const reclaimedByReboot = [];
  const reclaimedByTTL = [];
  const deadPid = [];
  // 한 번의 정리 사이클 내 판정 일관성을 위해 현재 부팅/시각을 한 번만 샘플.
  const judgeOpts = { bootEpoch: currentBootEpoch(), now: Date.now() };

  const categorize = (label, reason) => {
    cleaned.push(label);
    if (reason === 'reclaimedByReboot') reclaimedByReboot.push(label);
    else if (reason === 'reclaimedByTTL') reclaimedByTTL.push(label);
    else deadPid.push(label);
  };

  if (fs.existsSync(runsDir)) {
    for (const taskId of fs.readdirSync(runsDir)) {
      const file = lockPath(cwd, taskId);
      if (!fs.existsSync(file)) continue;
      const reason = staleReason(readLock(file), judgeOpts);
      if (reason) {
        try {
          fs.unlinkSync(file);
          categorize(taskId, reason);
        } catch { /* ignore */ }
      }
    }
  }

  // cycle lock (v0.6.1) — prepare/collect 도중 죽은 세션 잔재
  const cycleFile = cycleLockPath(cwd);
  if (fs.existsSync(cycleFile)) {
    const reason = staleReason(readLock(cycleFile), judgeOpts);
    if (reason) {
      try {
        fs.unlinkSync(cycleFile);
        categorize('__cycle__', reason);
      } catch { /* ignore */ }
    }
  }

  return { cleaned, reclaimedByReboot, reclaimedByTTL, deadPid };
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
  let stalePath = null;
  if (fs.existsSync(file)) {
    const holder = readLock(file);
    if (holder && isHeld(holder)) {
      return {
        ok: false,
        error: `사이클이 다른 세션에서 진행 중 (pid=${holder.pid}${holder.stage ? `, stage=${holder.stage}` : ''})`,
        holder,
      };
    }
    // stale(죽은 PID·재부팅·TTL) — 기존 파일을 치우고 배타적 재공개(단일 승자 수렴, STAB-2).
    action = 'takeover';
    stalePath = `${file}.stale.${pid}.${Date.now()}`;
    try { fs.renameSync(file, stalePath); } catch { stalePath = null; }
  }

  const payload = {
    pid,
    stage: opts.stage || null,
    acquired_at: new Date().toISOString(),
    boot_epoch: currentBootEpoch(),
  };
  // 배타적 공개 — link 기반 원자 획득(STAB-2).
  const won = writeFileExclusive(file, JSON.stringify(payload, null, 2) + '\n');
  if (stalePath) { try { fs.unlinkSync(stalePath); } catch { /* best-effort */ } }
  if (!won) {
    const holder = readLock(file);
    return {
      ok: false,
      error: `사이클이 다른 세션에서 진행 중 (pid=${holder ? holder.pid : '?'}${holder && holder.stage ? `, stage=${holder.stage}` : ''})`,
      holder: holder || undefined,
    };
  }
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
 * 드라이브 소유권 락(belt, STAB-1) — 같은 레포에 두 헤드리스 드라이버 동시 실행 차단.
 * driver-state.json 은 관측용(단일 writer)이라 소유권 판정에 쓰지 않는다 → 전용 파일
 * .pact/drive-owner.json 을 writeFileExclusive+isAlive 로 검사/기록한다.
 * live 한 타 pid 가 소유 중이면 거부. stale(죽은 pid)·자기 pid 는 takeover(재공개).
 *
 * @returns {{ok:true, file:string, action:'fresh'|'takeover'} | {ok:false, error:string, holder?:object}}
 */
function acquireDriveLock(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const file = driveOwnerPath(cwd);
  const dir = path.dirname(file);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let action = 'fresh';
  let stalePath = null;
  if (fs.existsSync(file)) {
    const holder = readLock(file);
    if (holder && holder.pid !== pid && isHeld(holder)) {
      return {
        ok: false,
        error: `드라이버 이미 실행 중 (pid=${holder.pid}${holder.session ? `, session=${holder.session}` : ''})`,
        holder,
      };
    }
    // 자기 pid 재획득(멱등) 또는 stale(죽은 pid·재부팅·TTL) — 치우고 배타적 재공개(단일 승자 수렴).
    action = 'takeover';
    stalePath = `${file}.stale.${pid}.${Date.now()}`;
    try { fs.renameSync(file, stalePath); } catch { stalePath = null; }
  }

  const payload = {
    pid,
    session: opts.session || null,
    acquired_at: new Date().toISOString(),
    boot_epoch: currentBootEpoch(),
  };
  const won = writeFileExclusive(file, JSON.stringify(payload, null, 2) + '\n');
  if (stalePath) { try { fs.unlinkSync(stalePath); } catch { /* best-effort */ } }
  if (!won) {
    const holder = readLock(file);
    return {
      ok: false,
      error: `드라이버 이미 실행 중 (pid=${holder ? holder.pid : '?'})`,
      holder: holder || undefined,
    };
  }
  return { ok: true, file, action };
}

/** 드라이브 소유권 락 해제(정상/SIGINT/SIGTERM 종료 시). 자기 pid 일 때만(force 로 강제). */
function releaseDriveLock(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const file = driveOwnerPath(cwd);

  if (!fs.existsSync(file)) return { ok: true, removed: false };

  const holder = readLock(file);
  if (!opts.force && holder && holder.pid !== pid) {
    return { ok: false, error: `다른 PID(${holder.pid})가 드라이브 소유 중. force 필요.` };
  }
  try { fs.unlinkSync(file); } catch { /* 이미 없음 */ }
  return { ok: true, removed: true };
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
  currentBootEpoch,
  staleReason,
  isHeld,
  lockPath,
  acquireCycleLock,
  releaseCycleLock,
  readCycleLock,
  cycleLockPath,
  acquireDriveLock,
  releaseDriveLock,
  driveOwnerPath,
};
