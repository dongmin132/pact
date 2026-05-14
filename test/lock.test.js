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
