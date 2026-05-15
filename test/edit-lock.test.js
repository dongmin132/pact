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
