'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
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
  acquireDriveLock,
  releaseDriveLock,
  driveOwnerPath,
  currentBootEpoch,
  staleReason,
  isHeld,
} = require('../scripts/lock.js');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-lock-'));
  fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-001'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-002'), { recursive: true });
  return dir;
}

// 살아있는 PID 보장용: 현재 process.pid는 항상 살아있음
const ALIVE_PID = process.pid;
// 죽은 PID 시뮬: 매우 큰 PID는 거의 없음
const DEAD_PID = 999999;

test('isAlive — 현재 프로세스는 살아있음', () => {
  assert.equal(isAlive(ALIVE_PID), true);
});

test('isAlive — 비현실적으로 큰 PID는 죽음', () => {
  assert.equal(isAlive(DEAD_PID), false);
});

test('isAlive — 잘못된 입력', () => {
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive('abc'), false);
});

test('acquireLock — 새 lock 획득 (fresh)', () => {
  const dir = tmpProject();
  try {
    const r = acquireLock('TASK-001', { cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(fs.existsSync(lockPath(dir, 'TASK-001')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — 같은 task 두 번째 시도는 거부 (살아있는 lock)', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    const r2 = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /이미 점유/);
    assert.equal(r2.holder.pid, ALIVE_PID);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — stale lock(죽은 PID)은 takeover', () => {
  const dir = tmpProject();
  try {
    // 죽은 PID로 락 박기 (수동)
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: DEAD_PID, task_id: 'TASK-001', acquired_at: '2020-01-01' }),
    );
    const r = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');

    // 새 PID로 박혔는지
    const holder = JSON.parse(fs.readFileSync(lockPath(dir, 'TASK-001'), 'utf8'));
    assert.equal(holder.pid, ALIVE_PID);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — stale takeover는 단일 승자로 수렴 + .stale 잔재 없음 (STAB-2)', () => {
  const dir = tmpProject();
  try {
    // 죽은 PID 락을 박아두고 takeover
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: DEAD_PID, task_id: 'TASK-001', acquired_at: '2020' }),
    );
    const r1 = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r1.ok, true);
    assert.equal(r1.action, 'takeover');

    // 승자가 살아있는 락을 쥐었으니 재획득은 거부(단일 승자)
    const r2 = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /이미 점유/);

    // takeover 시 rename 한 .stale.* 파일은 뒤에 남지 않는다
    const runDir = path.dirname(lockPath(dir, 'TASK-001'));
    const litter = fs.readdirSync(runDir).filter(n => n.includes('.stale.'));
    assert.deepEqual(litter, [], `stale 잔재: ${litter}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — run dir 없으면 거부', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-lock-no-'));
  try {
    const r = acquireLock('MISSING-001', { cwd: dir });
    assert.equal(r.ok, false);
    assert.match(r.error, /run dir 없음/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — session_label 저장', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, sessionLabel: 'tmux:0.1' });
    const holder = JSON.parse(fs.readFileSync(lockPath(dir, 'TASK-001'), 'utf8'));
    assert.equal(holder.session_label, 'tmux:0.1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseLock — 자기 PID 일치 시 삭제', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    const r = releaseLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.removed, true);
    assert.ok(!fs.existsSync(lockPath(dir, 'TASK-001')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseLock — 다른 PID는 거부 (force 없이)', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    const r = releaseLock('TASK-001', { cwd: dir, pid: ALIVE_PID + 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /다른 PID/);
    assert.ok(fs.existsSync(lockPath(dir, 'TASK-001')), 'lock 파일 보존');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseLock — force=true면 강제 삭제', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    const r = releaseLock('TASK-001', { cwd: dir, pid: ALIVE_PID + 1, force: true });
    assert.equal(r.ok, true);
    assert.equal(r.removed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseAllByPid — 자기 PID 잡은 락만 해제', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    // TASK-002는 다른 PID
    fs.writeFileSync(
      lockPath(dir, 'TASK-002'),
      JSON.stringify({ pid: ALIVE_PID + 1, task_id: 'TASK-002' }),
    );

    const r = releaseAllByPid({ cwd: dir, pid: ALIVE_PID });
    assert.deepEqual(r.released, ['TASK-001']);
    assert.equal(r.skipped.length, 0);
    assert.ok(!fs.existsSync(lockPath(dir, 'TASK-001')));
    assert.ok(fs.existsSync(lockPath(dir, 'TASK-002')), 'TASK-002 보존');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanStaleLocks — 죽은 PID 잡은 락만 정리', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    fs.writeFileSync(
      lockPath(dir, 'TASK-002'),
      JSON.stringify({ pid: DEAD_PID, task_id: 'TASK-002' }),
    );

    const r = cleanStaleLocks({ cwd: dir });
    assert.deepEqual(r.cleaned, ['TASK-002']);
    assert.ok(fs.existsSync(lockPath(dir, 'TASK-001')), 'alive lock 보존');
    assert.ok(!fs.existsSync(lockPath(dir, 'TASK-002')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('listLocks — alive/stale 둘 다 표시', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID, sessionLabel: 'main' });
    fs.writeFileSync(
      lockPath(dir, 'TASK-002'),
      JSON.stringify({ pid: DEAD_PID, task_id: 'TASK-002', acquired_at: '2020' }),
    );

    const locks = listLocks({ cwd: dir });
    assert.equal(locks.length, 2);
    const t1 = locks.find(l => l.task_id === 'TASK-001');
    const t2 = locks.find(l => l.task_id === 'TASK-002');
    assert.equal(t1.alive, true);
    assert.equal(t1.session_label, 'main');
    assert.equal(t2.alive, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── Cycle lock (v0.6.1) ───

test('acquireCycleLock — 새 사이클 lock 획득', () => {
  const dir = tmpProject();
  try {
    const r = acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'prepare' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(fs.existsSync(cycleLockPath(dir)));

    const holder = readCycleLock({ cwd: dir });
    assert.equal(holder.pid, ALIVE_PID);
    assert.equal(holder.stage, 'prepare');
    assert.equal(holder.alive, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireCycleLock — 살아있는 lock 있으면 거부', () => {
  const dir = tmpProject();
  try {
    acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'prepare' });
    const r2 = acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'collect' });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /다른 세션에서 진행 중/);
    assert.equal(r2.holder.pid, ALIVE_PID);
    assert.equal(r2.holder.stage, 'prepare');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireCycleLock — stale(죽은 PID)은 takeover', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      cycleLockPath(dir),
      JSON.stringify({ pid: DEAD_PID, stage: 'collect', acquired_at: '2020' }),
    );
    const r = acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'prepare' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseCycleLock — 자기 PID 일치 시 삭제', () => {
  const dir = tmpProject();
  try {
    acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'prepare' });
    const r = releaseCycleLock({ cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.removed, true);
    assert.ok(!fs.existsSync(cycleLockPath(dir)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanStaleLocks — cycle lock도 청소 (v0.6.1)', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      cycleLockPath(dir),
      JSON.stringify({ pid: DEAD_PID, stage: 'prepare', acquired_at: '2020' }),
    );
    const r = cleanStaleLocks({ cwd: dir });
    assert.ok(r.cleaned.includes('__cycle__'));
    assert.ok(!fs.existsSync(cycleLockPath(dir)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── STAB-1 belt: 드라이브 소유권 락 (drive-owner.json) ───────────────────

test('acquireDriveLock — 새 드라이브 락 획득 (fresh)', () => {
  const dir = tmpProject();
  try {
    const r = acquireDriveLock({ cwd: dir, pid: ALIVE_PID, session: 'drive' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(fs.existsSync(driveOwnerPath(dir)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireDriveLock — live 한 타 pid 소유 중이면 거부 (이중 드라이버 차단)', () => {
  const dir = tmpProject();
  try {
    // ALIVE_PID(현재 프로세스) 가 소유 중 — 살아있음
    acquireDriveLock({ cwd: dir, pid: ALIVE_PID });
    const r = acquireDriveLock({ cwd: dir, pid: DEAD_PID }); // 다른 요청자(pid 무관, holder 가 살아있음)
    assert.equal(r.ok, false);
    assert.match(r.error, /드라이버 이미 실행 중/);
    assert.equal(r.holder.pid, ALIVE_PID);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireDriveLock — stale(죽은 pid) 소유는 takeover', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(driveOwnerPath(dir), JSON.stringify({ pid: DEAD_PID, session: 'old', acquired_at: '2020' }));
    const r = acquireDriveLock({ cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');
    // 소유권이 산 pid 로 이전됐고 .stale 잔재 없음
    const held = JSON.parse(fs.readFileSync(driveOwnerPath(dir), 'utf8'));
    assert.equal(held.pid, ALIVE_PID);
    assert.equal(fs.readdirSync(path.join(dir, '.pact')).filter(f => f.includes('.stale.')).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseDriveLock — 해제 후 재획득 가능', () => {
  const dir = tmpProject();
  try {
    acquireDriveLock({ cwd: dir, pid: ALIVE_PID });
    const rel = releaseDriveLock({ cwd: dir, pid: ALIVE_PID });
    assert.equal(rel.ok, true);
    assert.equal(rel.removed, true);
    assert.ok(!fs.existsSync(driveOwnerPath(dir)));
    const r2 = acquireDriveLock({ cwd: dir, pid: DEAD_PID });
    assert.equal(r2.ok, true); // 해제됐으니 다른 pid 도 획득 가능
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseDriveLock — 다른 PID 소유는 force 없이 거부', () => {
  const dir = tmpProject();
  try {
    acquireDriveLock({ cwd: dir, pid: ALIVE_PID });
    const rel = releaseDriveLock({ cwd: dir, pid: DEAD_PID });
    assert.equal(rel.ok, false);
    assert.match(rel.error, /force/);
    assert.ok(fs.existsSync(driveOwnerPath(dir))); // 여전히 존재
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── STAB-5: boot_epoch self-heal (PID 재사용 영구락 자가치유, P3-B) ────────

const TTL_MS = 24 * 60 * 60 * 1000;

test('currentBootEpoch — 10초 버킷으로 양자화된 부팅 시각', () => {
  const be = currentBootEpoch();
  assert.equal(typeof be, 'number');
  assert.ok(Number.isFinite(be));
  assert.equal(be % 10, 0, '10초 배수여야 함');
  // (now - uptime) 근사값과 1버킷 이내
  const expected = Math.round((Date.now() / 1000 - os.uptime()) / 10) * 10;
  assert.ok(Math.abs(be - expected) <= 10);
});

test('staleReason — 다른 boot_epoch + 살아있는 pid → 유지(null) (LG-1: false-reboot 방어)', () => {
  // 벽시계 스텝(NTP/VM restore)이 boot_epoch 를 점프시켜도 살아있는 pid 는 실제 소유자 → 회수 X.
  const cur = 1000;
  const holder = { pid: ALIVE_PID, boot_epoch: cur - 1000, acquired_at: new Date().toISOString() };
  assert.equal(staleReason(holder, { bootEpoch: cur, now: Date.now() }), null);
  assert.equal(isHeld(holder, { bootEpoch: cur, now: Date.now() }), true);
});

test('staleReason — 다른 boot_epoch + 죽은 pid → reclaimedByReboot (재부팅 잔재만 회수)', () => {
  const cur = 1000;
  const holder = { pid: DEAD_PID, boot_epoch: cur - 1000, acquired_at: new Date().toISOString() };
  assert.equal(staleReason(holder, { bootEpoch: cur }), 'reclaimedByReboot');
  assert.equal(isHeld(holder, { bootEpoch: cur }), false);
});

test('staleReason — 같은 boot_epoch + 살아있는 pid + 최근이면 유지(null)', () => {
  const cur = 1000;
  const holder = { pid: ALIVE_PID, boot_epoch: cur, acquired_at: new Date().toISOString() };
  assert.equal(staleReason(holder, { bootEpoch: cur, now: Date.now() }), null);
  assert.equal(isHeld(holder, { bootEpoch: cur, now: Date.now() }), true);
});

test('staleReason — 같은 boot_epoch + 죽은 pid → deadPid', () => {
  const cur = 1000;
  const holder = { pid: DEAD_PID, boot_epoch: cur, acquired_at: new Date().toISOString() };
  assert.equal(staleReason(holder, { bootEpoch: cur }), 'deadPid');
});

test('staleReason — 같은 boot_epoch + 살아있음 + 24h TTL 초과 → reclaimedByTTL', () => {
  const cur = 1000;
  const now = Date.now();
  const holder = { pid: ALIVE_PID, boot_epoch: cur, acquired_at: new Date(now - TTL_MS - 60000).toISOString() };
  assert.equal(staleReason(holder, { bootEpoch: cur, now }), 'reclaimedByTTL');
});

test('staleReason — 1버킷(10초) 차이는 같은 부팅으로 관대하게 취급', () => {
  const cur = 1000;
  const holder = { pid: ALIVE_PID, boot_epoch: cur - 10, acquired_at: new Date().toISOString() };
  assert.equal(staleReason(holder, { bootEpoch: cur, now: Date.now() }), null);
});

test('staleReason — boot_epoch 부재 + 살아있는 pid → 유지 (하위호환)', () => {
  assert.equal(staleReason({ pid: ALIVE_PID }, { bootEpoch: 1000 }), null);
});

test('staleReason — boot_epoch 부재 + 죽은 pid → deadPid (기존 동작)', () => {
  assert.equal(staleReason({ pid: DEAD_PID }, { bootEpoch: 1000 }), 'deadPid');
});

test('staleReason — holder null → deadPid (파싱 불가 정리 대상)', () => {
  assert.equal(staleReason(null), 'deadPid');
});

test('acquireLock — 획득 시 boot_epoch 기록', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    const holder = JSON.parse(fs.readFileSync(lockPath(dir, 'TASK-001'), 'utf8'));
    assert.equal(typeof holder.boot_epoch, 'number');
    assert.equal(holder.boot_epoch % 10, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — 다른 boot_epoch + 살아있는 pid는 거부 (LG-1: 살아있는 락 보존)', () => {
  const dir = tmpProject();
  try {
    // 살아있는 pid + 다른 부팅 = false-reboot(벽시계 스텝) 가능성 → 회수 X, 실제 소유자 보존.
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: ALIVE_PID, boot_epoch: currentBootEpoch() - 100000, acquired_at: new Date().toISOString() }),
    );
    const r = acquireLock('TASK-001', { cwd: dir, pid: DEAD_PID });
    assert.equal(r.ok, false);
    assert.match(r.error, /이미 점유/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — 다른 boot_epoch + 죽은 pid는 takeover (재부팅 잔재)', () => {
  const dir = tmpProject();
  try {
    // 죽은 pid + 다른 부팅 = 재부팅 후 남은 잔재 → takeover 허용.
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: DEAD_PID, boot_epoch: currentBootEpoch() - 100000, acquired_at: new Date().toISOString() }),
    );
    const r = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');
    const holder = JSON.parse(fs.readFileSync(lockPath(dir, 'TASK-001'), 'utf8'));
    assert.ok(Math.abs(holder.boot_epoch - currentBootEpoch()) <= 10, '현재 부팅으로 갱신');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — 24h TTL 초과 락은 takeover', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: ALIVE_PID, boot_epoch: currentBootEpoch(), acquired_at: new Date(Date.now() - TTL_MS - 60000).toISOString() }),
    );
    const r = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireLock — boot_epoch 부재 + 살아있는 pid는 여전히 거부 (하위호환)', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: ALIVE_PID, task_id: 'TASK-001', acquired_at: new Date().toISOString() }),
    );
    const r = acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, false);
    assert.match(r.error, /이미 점유/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanStaleLocks — 회수 사유 구분 (reclaimedByReboot / deadPid) + 살아있는 락 보존(LG-1)', () => {
  const dir = tmpProject();
  try {
    // TASK-001: 살아있는 pid, boot_epoch 없음 → 보존 (하위호환)
    acquireLock('TASK-001', { cwd: dir, pid: ALIVE_PID });
    // TASK-002: 죽은 pid + 다른 부팅 → reclaimedByReboot (재부팅 잔재)
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-002'), { recursive: true });
    fs.writeFileSync(
      lockPath(dir, 'TASK-002'),
      JSON.stringify({ pid: DEAD_PID, boot_epoch: currentBootEpoch() - 100000, acquired_at: new Date().toISOString() }),
    );
    // TASK-003: 죽은 pid + 같은 부팅 → deadPid
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-003'), { recursive: true });
    fs.writeFileSync(
      lockPath(dir, 'TASK-003'),
      JSON.stringify({ pid: DEAD_PID, boot_epoch: currentBootEpoch(), acquired_at: new Date().toISOString() }),
    );
    // TASK-004: 살아있는 pid + 다른 부팅 → 보존 (LG-1: false-reboot 하에 살아있는 락 회수 X)
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-004'), { recursive: true });
    fs.writeFileSync(
      lockPath(dir, 'TASK-004'),
      JSON.stringify({ pid: ALIVE_PID, boot_epoch: currentBootEpoch() - 100000, acquired_at: new Date().toISOString() }),
    );

    const r = cleanStaleLocks({ cwd: dir });
    assert.ok(r.cleaned.includes('TASK-002'));
    assert.ok(r.cleaned.includes('TASK-003'));
    assert.ok(!r.cleaned.includes('TASK-001'), 'boot_epoch 없는 살아있는 락 보존');
    assert.ok(!r.cleaned.includes('TASK-004'), '살아있는 pid 는 다른 부팅이어도 보존(LG-1)');
    assert.deepEqual(r.reclaimedByReboot, ['TASK-002']);
    assert.deepEqual(r.deadPid, ['TASK-003']);
    assert.deepEqual(r.reclaimedByTTL, []);
    assert.ok(fs.existsSync(lockPath(dir, 'TASK-001')));
    assert.ok(fs.existsSync(lockPath(dir, 'TASK-004')), '살아있는 락 파일 보존');
    assert.ok(!fs.existsSync(lockPath(dir, 'TASK-002')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanStaleLocks — TTL 초과 락은 reclaimedByTTL로 구분', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: ALIVE_PID, boot_epoch: currentBootEpoch(), acquired_at: new Date(Date.now() - TTL_MS - 60000).toISOString() }),
    );
    const r = cleanStaleLocks({ cwd: dir });
    assert.deepEqual(r.reclaimedByTTL, ['TASK-001']);
    assert.ok(r.cleaned.includes('TASK-001'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireCycleLock — boot_epoch 기록 + 죽은 pid 재부팅 잔재만 takeover', () => {
  const dir = tmpProject();
  try {
    // fresh 획득 시 boot_epoch 기록
    acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'prepare' });
    const held = JSON.parse(fs.readFileSync(cycleLockPath(dir), 'utf8'));
    assert.equal(typeof held.boot_epoch, 'number');
    releaseCycleLock({ cwd: dir, pid: ALIVE_PID });

    // 살아있는 pid + 다른 부팅 → 회수 X (LG-1: false-reboot 하 진행 중 사이클 보존)
    fs.writeFileSync(
      cycleLockPath(dir),
      JSON.stringify({ pid: ALIVE_PID, boot_epoch: currentBootEpoch() - 100000, stage: 'collect', acquired_at: new Date().toISOString() }),
    );
    const busy = acquireCycleLock({ cwd: dir, pid: DEAD_PID, stage: 'prepare' });
    assert.equal(busy.ok, false, '살아있는 홀더는 다른 부팅이어도 보존');

    // 죽은 pid + 다른 부팅 → takeover (재부팅 잔재)
    fs.writeFileSync(
      cycleLockPath(dir),
      JSON.stringify({ pid: DEAD_PID, boot_epoch: currentBootEpoch() - 100000, stage: 'collect', acquired_at: new Date().toISOString() }),
    );
    const r = acquireCycleLock({ cwd: dir, pid: ALIVE_PID, stage: 'prepare' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireDriveLock — 살아있는 타 pid 는 다른 부팅이어도 거부 (LG-1), 죽은 pid만 takeover', () => {
  const dir = tmpProject();
  try {
    acquireDriveLock({ cwd: dir, pid: ALIVE_PID, session: 'drive' });
    const held = JSON.parse(fs.readFileSync(driveOwnerPath(dir), 'utf8'));
    assert.equal(typeof held.boot_epoch, 'number');
    releaseDriveLock({ cwd: dir, pid: ALIVE_PID });

    // 살아있는 타 pid 소유 + 다른 부팅 → 거부 (false-reboot 하 진행 중 드라이버 보존)
    fs.writeFileSync(
      driveOwnerPath(dir),
      JSON.stringify({ pid: ALIVE_PID, boot_epoch: currentBootEpoch() - 100000, session: 'old', acquired_at: new Date().toISOString() }),
    );
    const busy = acquireDriveLock({ cwd: dir, pid: DEAD_PID });
    assert.equal(busy.ok, false, '살아있는 타 드라이버는 다른 부팅이어도 보존');
    assert.match(busy.error, /이미 실행 중/);

    // 죽은 타 pid 소유 + 다른 부팅 → takeover (재부팅 잔재)
    fs.writeFileSync(
      driveOwnerPath(dir),
      JSON.stringify({ pid: DEAD_PID, boot_epoch: currentBootEpoch() - 100000, session: 'old', acquired_at: new Date().toISOString() }),
    );
    const r = acquireDriveLock({ cwd: dir, pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session-start hook — 재부팅 회수 사유를 systemMessage로 표면화', () => {
  const { spawnSync } = require('child_process');
  const dir = tmpProject();
  try {
    // 재부팅으로 stale 된 (죽은 pid + 다른 부팅) 락 — deadPid 아님, reclaimedByReboot
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: DEAD_PID, boot_epoch: currentBootEpoch() - 100000, acquired_at: new Date().toISOString() }),
    );
    const hook = path.join(__dirname, '..', 'hooks', 'session-start.js');
    const res = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd: dir, permission_mode: 'default' }),
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.match(out.systemMessage, /재부팅|reboot/i);
    assert.match(out.systemMessage, /TASK-001/);
    // 회수됐으므로 락 파일 삭제됨
    assert.ok(!fs.existsSync(lockPath(dir, 'TASK-001')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session-start hook — deadPid만 회수되면 메시지 표면화 안 함(노이즈 억제)', () => {
  const { spawnSync } = require('child_process');
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      lockPath(dir, 'TASK-001'),
      JSON.stringify({ pid: DEAD_PID, acquired_at: new Date().toISOString() }),
    );
    const hook = path.join(__dirname, '..', 'hooks', 'session-start.js');
    const res = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd: dir, permission_mode: 'default' }),
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '', 'deadPid 정리는 조용히');
    assert.ok(!fs.existsSync(lockPath(dir, 'TASK-001')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
