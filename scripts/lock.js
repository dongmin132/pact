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
 * - **살아있는 pid 는 절대 회수하지 않는다**(LG-1): 벽시계 스텝(NTP 초기 동기·VM save/restore·
 *   수동 시계변경)은 재부팅 없이도 boot_epoch 를 점프시켜 false-reboot 를 낸다. 이때 살아있는
 *   pid 는 그 락의 실제 소유자이므로 회수하면 격리(STAB-1/5)가 깨진다. 재부팅 후 pid 재사용
 *   (coincidental)으로 인한 영구락은 24h TTL 백스톱이 정리한다(즉시 아님, 안전 우선).
 * - 죽은 pid: boot_epoch 가 현재와 1버킷(10초) 초과 차이면 재부팅 잔재(reclaimedByReboot),
 *   같은 부팅이면 deadPid — 둘 다 회수하되 사유만 구분(STAB-5 표면화용).
 * - 같은 부팅 + 살아있음: acquired_at 기준 24h TTL 초과면 reclaimedByTTL.
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
    const rebooted = Math.abs(holder.boot_epoch - cur) > BOOT_EPOCH_BUCKET;
    // 죽은 pid 만 boot_epoch 로 회수 사유를 구분. 살아있으면 재부팅 신호가 있어도 회수 X.
    if (!isAlive(holder.pid)) return rebooted ? 'reclaimedByReboot' : 'deadPid';
    // 살아있음 — 재부팅 신호 무시(false-reboot 방어). pid 재사용/락만 남은 세션은 24h TTL 백스톱.
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
 * stale 락 회수 헬퍼 — rename 후 재검증(P1-#1 TOCTOU 수리 · 단일 소스).
 *
 * 문제: 기존 acquire 는 stale 판정 후 `renameSync(file, stalePath)` 를 **무조건** 실행했다.
 * 판정~rename 사이 다른 세션이 fresh live 락을 writeFileExclusive 로 공개하면, 그 rename 이 남의
 * fresh 락을 .stale 로 밀어내고 나도 내 락을 만들어 **둘 다 획득 성공**으로 오인한다("rename 은
 * 원자적"이라는 전제는 A 가 무엇을 옮기는지 재확인 안 하는 문제를 못 막는다).
 *
 * 고침: rename **후** 옮겨진 파일(stalePath)의 holder 를 다시 읽어, 그게 실제로 살아있으면
 * (=방금 남의 fresh 락을 훔친 것) **비-clobber 복원** 후 실패를 알린다. 무조건 renameSync(stalePath,
 * file) 로 되돌리면 move-away~복원 사이 O_EXCL(writeFileExclusive)로 부재 file 을 새로 잡은 제3자 C 를
 * 덮어써 B+C 이중 점유를 만든다(3자 clobber). 그래서 복원은 link(EEXIST=실패)로 file 이 **부재일 때만**
 * 게시한다: file 이 이미 점유돼 있으면 신규 승자 C 를 보존하고 복원을 포기(stalePath 는 그대로 둠).
 * 죽은/stale 이 확인될 때만 stalePath 를 돌려줘 caller 가 writeFileExclusive 로 재공개하게 한다.
 *
 * @param {string} file 락 경로(caller 가 존재 + stale 로 이미 판정)
 * @param {number} pid 획득 시도 pid(stalePath 유니크화)
 * @param {object} [opts]
 * @param {(holder:object|null)=>boolean} [opts.heldFn] 살아있음(=회수 금지) 판정. 기본 isHeld.
 *   drive/edit 처럼 자기 pid·session 재획득을 stale 로 취급하려면 커스텀 주입.
 * @param {(file:string)=>object|null} [opts.readFn] 락 파서. 기본 readLock.
 * @returns {{ok:true, stalePath:string|null} | {ok:false, holder:object}}
 *   ok:true  — stalePath(치운 경로, rename 실패면 null). writeFileExclusive 재공개 진행 가능.
 *   ok:false — rename 후 재검증에서 live holder 발견(복원 완료). caller 는 점유 실패 반환.
 */
function reclaimStale(file, pid, opts = {}) {
  const heldFn = opts.heldFn || isHeld;
  const readFn = opts.readFn || readLock;
  const stalePath = `${file}.stale.${pid}.${Date.now()}`;
  try {
    fs.renameSync(file, stalePath);
  } catch {
    // file 이 사라짐(다른 세션이 이미 회수/해제) — 재공개(writeFileExclusive)가 승패를 가린다.
    return { ok: true, stalePath: null };
  }
  // rename 후 재검증: 방금 치운 게 실은 fresh live 락이면(판정~rename 사이 공개) 복원 + 실패.
  const moved = readFn(stalePath);
  if (moved && heldFn(moved)) {
    // 비-clobber 복원: move-away~복원 사이 제3자 C 가 O_EXCL 로 부재 file 을 새로 잡았을 수 있다.
    // renameSync 는 그 C 를 덮어써(3자 clobber) B+C 이중 점유를 만든다. 대신 link(EEXIST=실패)로
    // file 이 **부재일 때만** 되돌린다: 이미 C 가 점유했으면 복원을 포기하고 신규 승자 C 를 보존한다.
    // 어느 경로든 file 점유자는 정확히 하나(B 복원 성공 또는 C 유지). unlink 로 .stale 사본은 정리.
    try {
      fs.linkSync(stalePath, file);
      fs.unlinkSync(stalePath);
    } catch { /* file 을 C 가 이미 점유(EEXIST) — 복원 포기, stalePath 는 그대로 둔 채 C 보존 */ }
    return { ok: false, holder: moved };
  }
  return { ok: true, stalePath };
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

  const myLabel = opts.sessionLabel || null;
  let action = 'fresh';
  let stalePath = null;
  if (fs.existsSync(file)) {
    const holder = readLock(file);
    // H3-2: 자기 세션(session_label 일치) 재획득은 멱등 허용 — owner pid 가 살아있게 된 뒤, 같은
    // 세션의 크래시 후 재claim/재시도가 24h TTL 까지 거부되던 회귀 방지(acquireEditLock 과 대칭).
    const heldByOther = (h) => isHeld(h) && !(myLabel && h.session_label === myLabel);
    if (holder && heldByOther(holder)) {
      return { ok: false, error: `이미 점유 중 (pid=${holder.pid}${holder.session_label ? `, session=${holder.session_label}` : ''})`, holder };
    }
    // 자기 세션 재획득 또는 stale(죽은 PID·재부팅·TTL) — 옆으로 치우되 rename 후 재검증(P1-#1).
    // 판정~rename 사이 타 세션 fresh live 락이 공개됐으면 복원 + 점유 실패(둘 다 획득 방지).
    action = holder && myLabel && holder.session_label === myLabel ? 're-acquire' : 'takeover';
    const rec = reclaimStale(file, pid, { heldFn: heldByOther });
    if (!rec.ok) {
      const h = rec.holder;
      return { ok: false, error: `이미 점유 중 (pid=${h.pid}${h.session_label ? `, session=${h.session_label}` : ''})`, holder: h };
    }
    stalePath = rec.stalePath;
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

  const pid = opts.pid || process.pid;
  const categorize = (label, reason) => {
    cleaned.push(label);
    if (reason === 'reclaimedByReboot') reclaimedByReboot.push(label);
    else if (reason === 'reclaimedByTTL') reclaimedByTTL.push(label);
    else deadPid.push(label);
  };

  // M5: 직접 unlink 대신 reclaimStale(rename-후-재검증)로 회수 — 판정~삭제 사이 타 세션이 takeover
  // 로 게시한 fresh live 락을 삭제하지 않는다(P1-#1 을 정리 경로에도 적용). heldFn 은 같은 정리
  // 사이클의 judgeOpts 로 판정 일관성 유지. rec.ok=true(회수 확정)일 때만 stalePath 삭제·categorize.
  const heldFn = (h) => isHeld(h, judgeOpts);
  const reclaim = (file, label, reason) => {
    const rec = reclaimStale(file, pid, { heldFn });
    if (!rec.ok) return; // 재검증에서 live 락 발견 → 복원됨, 회수 취소
    if (rec.stalePath) { try { fs.unlinkSync(rec.stalePath); } catch { /* ignore */ } }
    categorize(label, reason);
  };

  if (fs.existsSync(runsDir)) {
    for (const taskId of fs.readdirSync(runsDir)) {
      const file = lockPath(cwd, taskId);
      if (!fs.existsSync(file)) continue;
      const reason = staleReason(readLock(file), judgeOpts);
      if (reason) reclaim(file, taskId, reason);
    }
  }

  // cycle lock (v0.6.1) — prepare/collect 도중 죽은 세션 잔재
  const cycleFile = cycleLockPath(cwd);
  if (fs.existsSync(cycleFile)) {
    const reason = staleReason(readLock(cycleFile), judgeOpts);
    if (reason) reclaim(cycleFile, '__cycle__', reason);
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
    // stale(죽은 PID·재부팅·TTL) — 치우되 rename 후 재검증(P1-#1). 판정~rename 사이 fresh live 락이
    // 공개됐으면 복원 + 실패(진행 중 사이클 보존, 이중 획득 방지).
    action = 'takeover';
    const rec = reclaimStale(file, pid);
    if (!rec.ok) {
      const h = rec.holder;
      return {
        ok: false,
        error: `사이클이 다른 세션에서 진행 중 (pid=${h.pid}${h.stage ? `, stage=${h.stage}` : ''})`,
        holder: h,
      };
    }
    stalePath = rec.stalePath;
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
    // 자기 pid 재획득(멱등) 또는 stale(죽은 pid·재부팅·TTL) — 치우되 rename 후 재검증(P1-#1).
    // 자기 재획득은 heldFn 이 held 로 보지 않아 재공개하되, 판정~rename 사이 타 pid 의 fresh live
    // 락이 공개됐으면 복원 + 실패(살아있는 타 드라이버 보존, 이중 드라이버 방지).
    action = 'takeover';
    const rec = reclaimStale(file, pid, { heldFn: (h) => !!h && h.pid !== pid && isHeld(h) });
    if (!rec.ok) {
      const h = rec.holder;
      return {
        ok: false,
        error: `드라이버 이미 실행 중 (pid=${h.pid}${h.session ? `, session=${h.session}` : ''})`,
        holder: h,
      };
    }
    stalePath = rec.stalePath;
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
  reclaimStale,
  lockPath,
  acquireCycleLock,
  releaseCycleLock,
  readCycleLock,
  cycleLockPath,
  acquireDriveLock,
  releaseDriveLock,
  driveOwnerPath,
};
