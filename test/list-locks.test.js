'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACT_BIN = path.join(ROOT, 'bin', 'pact');
const { acquireLock } = require('../scripts/lock.js');
const { resolveSessionLabel } = require('../bin/cmds/claim.js');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-ll-'));
  fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-001'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-002'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-003'), { recursive: true });
  return dir;
}

function runPact(args, cwd, env) {
  return spawnSync('node', [PACT_BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
}

test('resolveSessionLabel — 명시 라벨 우선', () => {
  assert.equal(resolveSessionLabel('explicit-label'), 'explicit-label');
});

test('resolveSessionLabel — env $PACT_SESSION fallback', () => {
  const old = process.env.PACT_SESSION;
  process.env.PACT_SESSION = 'env-label';
  try {
    assert.equal(resolveSessionLabel(), 'env-label');
  } finally {
    if (old === undefined) delete process.env.PACT_SESSION;
    else process.env.PACT_SESSION = old;
  }
});

test('resolveSessionLabel — 자동 fallback은 ppid-<N>', () => {
  const old = process.env.PACT_SESSION;
  delete process.env.PACT_SESSION;
  try {
    const r = resolveSessionLabel();
    assert.match(r, /^ppid-\d+$/);
  } finally {
    if (old !== undefined) process.env.PACT_SESSION = old;
  }
});

test('pact list-locks --session — 특정 라벨만 필터', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, sessionLabel: 's1' });
    acquireLock('TASK-002', { cwd: dir, sessionLabel: 's2' });
    acquireLock('TASK-003', { cwd: dir, sessionLabel: 's1' });

    const r = runPact(['list-locks', '--session', 's1', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.session_label, 's1');
    assert.deepEqual(out.task_ids.sort(), ['TASK-001', 'TASK-003']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact list-locks --mine — PACT_SESSION env 인식', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, sessionLabel: 'my-session' });
    acquireLock('TASK-002', { cwd: dir, sessionLabel: 'other' });

    const r = runPact(['list-locks', '--mine', '--json'], dir, { PACT_SESSION: 'my-session' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.session_label, 'my-session');
    assert.deepEqual(out.task_ids, ['TASK-001']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact list-locks --alive — stale 제외', () => {
  const dir = tmpProject();
  try {
    acquireLock('TASK-001', { cwd: dir, sessionLabel: 'live', pid: process.pid });
    // stale lock 수동 박기 (죽은 PID)
    fs.writeFileSync(
      path.join(dir, '.pact', 'runs', 'TASK-002', 'lock.pid'),
      JSON.stringify({ pid: 999999, session_label: 'dead', acquired_at: '2020' }),
    );

    const r = runPact(['list-locks', '--alive', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.task_ids, ['TASK-001']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact claim — 다중 task 한 번에', () => {
  const dir = tmpProject();
  try {
    const r = runPact(['claim', 'TASK-001', 'TASK-002', '--session', 's1', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.session_label, 's1');
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[1].ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
