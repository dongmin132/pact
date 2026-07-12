'use strict';

// pact next 회귀 테스트 — B1 (CLI-NEXT-1 + CLI-BATCHFILE-2 + CMD-3)
// SOT 이관: modern prepare는 .pact/current_batch.json만 쓴다. next는 이 파일을 1차로 읽고
// 부재 시에만 레거시 .pact/batch.json(batches[0]={index,task_ids} 객체)로 폴백해야 한다.
// 구코드는 batch.json만 읽고 batches[0](객체)에 .map을 호출해 크래시했다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PACT_BIN = path.join(__dirname, '..', 'bin', 'pact');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-next-'));
  fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
  return dir;
}

function runNext(args, cwd) {
  return spawnSync('node', [PACT_BIN, 'next', ...args], { cwd, encoding: 'utf8' });
}

test('pact next — current_batch.json(task_ids 평탄 배열)에서 미점유 task 출력', () => {
  const dir = tmpRepo();
  try {
    fs.writeFileSync(path.join(dir, '.pact', 'current_batch.json'),
      JSON.stringify({ task_ids: ['TASK-001', 'TASK-002'], prepared_at: 'x' }));
    const r = runNext(['--json'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.available, ['TASK-001', 'TASK-002']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact next — batch.json 폴백(batches[0]={index,task_ids} 객체)에서 크래시 없이 파싱', () => {
  const dir = tmpRepo();
  try {
    // `pact batch` 실제 산출 포맷 (batch.js:50-53)
    fs.writeFileSync(path.join(dir, '.pact', 'batch.json'),
      JSON.stringify({ batches: [{ index: 0, task_ids: ['TASK-001', 'TASK-002'] }] }));
    const r = runNext(['--json'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /is not a function/);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.available, ['TASK-001', 'TASK-002']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact next — 둘 다 있으면 current_batch.json 우선', () => {
  const dir = tmpRepo();
  try {
    fs.writeFileSync(path.join(dir, '.pact', 'current_batch.json'),
      JSON.stringify({ task_ids: ['CURR-1'], prepared_at: 'x' }));
    fs.writeFileSync(path.join(dir, '.pact', 'batch.json'),
      JSON.stringify({ batches: [{ index: 0, task_ids: ['LEGACY-1'] }] }));
    const r = runNext(['--json'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.available, ['CURR-1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact next — 둘 다 없으면 exit 2 + current_batch.json 안내', () => {
  const dir = tmpRepo();
  try {
    const r = runNext(['--json'], dir);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /current_batch\.json/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
