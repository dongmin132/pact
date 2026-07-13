'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  acquireEditLock,
  releaseEditLock,
  listEditLocks,
  findLockForFile,
  cleanStaleEditLocks,
  expandModuleFiles,
  detectTargetKind,
  editLocksDir,
  lockFile,
} = require('../scripts/edit-lock.js');

const ALIVE_PID = process.pid;
const DEAD_PID = 999999;

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-el-'));
  fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
  return dir;
}

function writeShard(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

test('detectTargetKind — 슬래시 또는 .은 file, 그 외 module', () => {
  assert.equal(detectTargetKind('auth'), 'module');
  assert.equal(detectTargetKind('PROGRESS.md'), 'file');
  assert.equal(detectTargetKind('src/api/auth/login.ts'), 'file');
});

test('expandModuleFiles — contracts/modules/<m>.md의 owner_paths + 자동 shard', () => {
  const dir = tmpProject();
  try {
    writeShard(dir, 'contracts/modules/auth.md',
      '```yaml\nmodule: auth\nowner_paths:\n  - src/auth/**\n  - src/api/auth/**\n```\n');
    writeShard(dir, 'contracts/api/auth.md', '## auth API');
    writeShard(dir, 'tasks/auth.md', '## tasks');

    const paths = expandModuleFiles('auth', { cwd: dir });
    assert.ok(paths.includes('src/auth/**'));
    assert.ok(paths.includes('src/api/auth/**'));
    assert.ok(paths.includes('contracts/api/auth.md'));
    assert.ok(paths.includes('contracts/modules/auth.md'));
    assert.ok(paths.includes('tasks/auth.md'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireEditLock — 모듈 lock 획득 + paths 전개', () => {
  const dir = tmpProject();
  try {
    writeShard(dir, 'contracts/modules/auth.md',
      '```yaml\nmodule: auth\nowner_paths:\n  - src/auth/**\n```\n');

    const r = acquireEditLock('auth', { cwd: dir, sessionLabel: 's1' });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'module');
    assert.ok(r.paths.includes('src/auth/**'));
    assert.ok(fs.existsSync(r.file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireEditLock — 파일 lock (단일 경로)', () => {
  const dir = tmpProject();
  try {
    const r = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1' });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'file');
    assert.deepEqual(r.paths, ['PROGRESS.md']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireEditLock — 다른 session이 잡고 있으면 거부', () => {
  const dir = tmpProject();
  try {
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1', pid: ALIVE_PID });
    const r2 = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's2', pid: ALIVE_PID });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /이미 점유/);
    assert.equal(r2.holder.session_label, 's1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireEditLock — 같은 session은 재획득 OK', () => {
  const dir = tmpProject();
  try {
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1', pid: ALIVE_PID });
    const r2 = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1', pid: ALIVE_PID });
    assert.equal(r2.ok, true);
    assert.equal(r2.action, 're-acquire');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireEditLock — stale(죽은 PID) lock은 takeover + .stale 잔재 없음 (STAB-2)', () => {
  const dir = tmpProject();
  try {
    // 죽은 세션이 잡아둔 lock
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 'dead', pid: DEAD_PID });
    // 살아있는 다른 세션이 takeover
    const r = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's-new', pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'takeover');

    const locks = listEditLocks({ cwd: dir });
    assert.equal(locks.length, 1);
    assert.equal(locks[0].session_label, 's-new');

    // takeover 시 rename 한 .stale.* 잔재 없음 (.lock 만 남아야)
    const litter = fs.readdirSync(editLocksDir(dir)).filter(n => n.includes('.stale.'));
    assert.deepEqual(litter, [], `stale 잔재: ${litter}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireEditLock — 판정~rename 사이 타 세션 fresh live 락 공개되면 복원 + 거부 (P1-#1 인터리빙)', () => {
  const dir = tmpProject();
  const realRename = fs.renameSync;
  try {
    // 죽은 세션 락 → 사전판정 takeover.
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 'dead', pid: DEAD_PID });
    const file = lockFile(dir, 'PROGRESS.md');
    // move-aside 직후 옮겨진 파일을 타 세션(B)의 살아있는 락으로 교체(판정~rename 사이 공개 모델).
    const liveOther = { target: 'PROGRESS.md', kind: 'file', paths: ['PROGRESS.md'], pid: ALIVE_PID, session_label: 'B', acquired_at: new Date().toISOString() };
    let injected = false;
    fs.renameSync = function (from, to) {
      if (!injected && from === file) {
        injected = true;
        realRename.call(fs, from, to);
        fs.writeFileSync(to, JSON.stringify(liveOther));
        return;
      }
      return realRename.call(fs, from, to);
    };
    const r = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's-new', pid: 55555 });
    assert.equal(r.ok, false, '타 세션 fresh 락을 훔치지 않고 거부');
    assert.match(r.error, /이미 점유/);
    assert.equal(r.holder.session_label, 'B');
    // file 이 B 의 live 락으로 복원 + .stale 잔재 없음
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).session_label, 'B');
    assert.deepEqual(fs.readdirSync(editLocksDir(dir)).filter(n => n.includes('.stale.')), []);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireEditLock — move-away~복원 사이 제3자 세션 C 가 락 획득 시 C 미-clobber (3자 레이스)', () => {
  const dir = tmpProject();
  const realRename = fs.renameSync;
  try {
    // 죽은 세션 락 → 사전판정 takeover 경로.
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 'dead', pid: DEAD_PID });
    const file = lockFile(dir, 'PROGRESS.md');
    // move-aside 직후: 옮겨진 게 실은 B 의 live 락 + 부재 file 을 제3자 C 가 새로 획득.
    const liveB = { target: 'PROGRESS.md', kind: 'file', paths: ['PROGRESS.md'], pid: ALIVE_PID, session_label: 'B', acquired_at: new Date().toISOString() };
    const cHolder = { target: 'PROGRESS.md', kind: 'file', paths: ['PROGRESS.md'], pid: ALIVE_PID, session_label: 'C', acquired_at: new Date().toISOString() };
    let injected = false;
    fs.renameSync = function (from, to) {
      if (!injected && from === file) {
        injected = true;
        realRename.call(fs, from, to);                   // dead → stalePath
        fs.writeFileSync(to, JSON.stringify(liveB));      // 옮겨진 게 실은 B 의 live 락
        fs.writeFileSync(file, JSON.stringify(cHolder));  // C 가 부재 file 을 새로 획득
        return;
      }
      return realRename.call(fs, from, to);
    };
    const r = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's-new', pid: 55555 });
    assert.equal(r.ok, false, 'B live 발견 → 훔치지 않고 실패');
    // 핵심: 복원이 C 를 덮지 않아야 — file 은 여전히 C (B+C 이중 점유 방지)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).session_label, 'C', 'C 가 clobber 되지 않아야');
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireEditLock — 같은 session 재획득 중 rename 재검증은 자기 락이라 통과(takeover 아님)', () => {
  const dir = tmpProject();
  try {
    // 같은 session_label 재획득 — heldFn 은 held 로 보지 않아야(자기 락) 재공개 성공.
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1', pid: ALIVE_PID });
    const r = acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1', pid: ALIVE_PID });
    assert.equal(r.ok, true);
    assert.equal(r.action, 're-acquire');
    assert.deepEqual(fs.readdirSync(editLocksDir(dir)).filter(n => n.includes('.stale.')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('releaseEditLock — 자기 session만 해제', () => {
  const dir = tmpProject();
  try {
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1' });
    const r = releaseEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's2' });
    assert.equal(r.ok, false);
    assert.match(r.error, /다른 session/);
    const r2 = releaseEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1' });
    assert.equal(r2.ok, true);
    assert.equal(r2.removed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findLockForFile — 모듈 lock 잡힌 경로 매칭', () => {
  const dir = tmpProject();
  try {
    writeShard(dir, 'contracts/modules/auth.md',
      '```yaml\nmodule: auth\nowner_paths:\n  - src/auth/**\n```\n');
    acquireEditLock('auth', { cwd: dir, sessionLabel: 's1' });

    const hit = findLockForFile('src/auth/login.ts', { cwd: dir });
    assert.ok(hit);
    assert.equal(hit.target, 'auth');
    assert.equal(hit.session_label, 's1');

    const miss = findLockForFile('src/payment/x.ts', { cwd: dir });
    assert.equal(miss, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findLockForFile — 파일 lock 정확 매칭', () => {
  const dir = tmpProject();
  try {
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1' });

    const hit = findLockForFile('PROGRESS.md', { cwd: dir });
    assert.ok(hit);
    assert.equal(hit.target, 'PROGRESS.md');

    const miss = findLockForFile('DECISIONS.md', { cwd: dir });
    assert.equal(miss, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanStaleEditLocks — 죽은 PID lock 정리', () => {
  const dir = tmpProject();
  try {
    acquireEditLock('PROGRESS.md', { cwd: dir, sessionLabel: 's1', pid: ALIVE_PID });
    acquireEditLock('DECISIONS.md', { cwd: dir, sessionLabel: 's2', pid: DEAD_PID });

    const r = cleanStaleEditLocks({ cwd: dir });
    assert.deepEqual(r.cleaned, ['DECISIONS.md']);

    const remaining = listEditLocks({ cwd: dir });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].target, 'PROGRESS.md');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
