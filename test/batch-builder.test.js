'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBatches,
  detectCycles,
  validateInput,
  depTaskId,
  depKind,
} = require('../batch-builder.js');

const baseTask = (id, deps = []) => ({
  id, title: id, worker_type: 'backend',
  allowed_paths: [`src/${id}.ts`],
  dependencies: deps,
  status: 'todo', retry_count: 0,
});

test('depTaskId / depKind — string 의존성', () => {
  assert.equal(depTaskId('TASK-001'), 'TASK-001');
  assert.equal(depKind('TASK-001'), 'complete');
});

test('depTaskId / depKind — 객체 의존성', () => {
  assert.equal(depTaskId({ task_id: 'TASK-001', kind: 'contract_only' }), 'TASK-001');
  assert.equal(depKind({ task_id: 'TASK-001', kind: 'contract_only' }), 'contract_only');
});

test('depKind — kind 누락 시 complete default', () => {
  assert.equal(depKind({ task_id: 'TASK-001' }), 'complete');
});

test('validateInput — 객체 의존성 무결성', () => {
  const tasks = [
    baseTask('TASK-001'),
    baseTask('TASK-002', [{ task_id: 'TASK-001', kind: 'complete' }]),
  ];
  assert.equal(validateInput(tasks).error, null);
});

test('validateInput — 객체 의존성 알 수 없는 id 거부', () => {
  const tasks = [
    baseTask('TASK-001', [{ task_id: 'NONE', kind: 'complete' }]),
  ];
  assert.match(validateInput(tasks).error, /unknown task/);
});

test('detectCycles — 객체 의존성 cycle 검출', () => {
  const tasks = [
    baseTask('A', [{ task_id: 'B', kind: 'complete' }]),
    baseTask('B', [{ task_id: 'A', kind: 'complete' }]),
  ];
  const r = detectCycles(tasks);
  assert.equal(r.hasCycle, true);
});

test('buildBatches — 객체 의존성으로 배치 생성', () => {
  const tasks = [
    baseTask('A'),
    baseTask('B', [{ task_id: 'A', kind: 'complete' }]),
  ];
  const r = buildBatches(tasks);
  assert.equal(r.error, null);
  assert.equal(r.batches.length, 2);  // A 먼저, B 다음
});
