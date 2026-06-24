'use strict';

// pact sizecheck — 턴소진 위험 task 사이징 (정적 분석) 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessTasks, assessTask } = require('../scripts/sizecheck.js');

test('assessTask: files 많으면 oversized', () => {
  const r = assessTask({ id: 'BIG', files: ['a', 'b', 'c', 'd', 'e', 'f'] }, 5);
  assert.equal(r.risk, 'oversized');
  assert.equal(r.file_count, 6);
});

test('assessTask: files 적으면 ok', () => {
  const r = assessTask({ id: 'OK', files: ['a', 'b', 'c'] }, 5);
  assert.equal(r.risk, 'ok');
});

test('assessTask: 광범위 글롭 + files 미명시 = unbounded', () => {
  const r = assessTask({ id: 'GLOB', allowed_paths: ['src/**'] }, 5);
  assert.equal(r.risk, 'unbounded');
});

test('assessTask: 구체 allowed_paths 몇 개면 ok', () => {
  const r = assessTask({ id: 'SMALL', allowed_paths: ['src/a.ts', 'src/b.ts'] }, 5);
  assert.equal(r.risk, 'ok');
  assert.equal(r.file_count, 2);
});

test('assessTasks: 위험만 필터, file_count 내림차순', () => {
  const tasks = [
    { id: 'BIG', files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    { id: 'OK', files: ['a'] },
    { id: 'GLOB', allowed_paths: ['lib/**'] },
  ];
  const out = assessTasks(tasks, { maxFiles: 5 });
  assert.equal(out.length, 2, 'OK 제외');
  assert.equal(out[0].task, 'BIG', 'file_count 큰 게 먼저');
  assert.ok(out.some((r) => r.task === 'GLOB' && r.risk === 'unbounded'));
});
