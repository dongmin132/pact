'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTasksAgainstSchema } = require('../scripts/parse-tasks.js');

const VALID = {
  id: 'PACT-001',
  title: '로그인 API',
  priority: 'P0',
  dependencies: [],
  allowed_paths: ['src/api/auth/login.ts'],
  done_criteria: ['POST 200 반환'],
  tdd: true,
};

test('validateTasksAgainstSchema — 정상 task 통과', () => {
  const r = validateTasksAgainstSchema([VALID]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('필수 필드 누락 (done_criteria 빈 배열) → 거부', () => {
  const r = validateTasksAgainstSchema([{ ...VALID, done_criteria: [] }]);
  assert.equal(r.ok, false);
});

test('files 5개 초과 → 거부', () => {
  const r = validateTasksAgainstSchema([{
    ...VALID,
    files: ['a','b','c','d','e','f'],
  }]);
  assert.equal(r.ok, false);
});

test('priority enum 위반 거부', () => {
  const r = validateTasksAgainstSchema([{ ...VALID, priority: 'critical' }]);
  assert.equal(r.ok, false);
});

test('id 형식 위반 (소문자) 거부', () => {
  const r = validateTasksAgainstSchema([{ ...VALID, id: 'pact-001' }]);
  assert.equal(r.ok, false);
});

test('dependencies 객체 형식 통과', () => {
  const r = validateTasksAgainstSchema([{
    ...VALID,
    dependencies: [{ task_id: 'PACT-000', kind: 'complete' }],
  }]);
  assert.equal(r.ok, true);
});

test('dependencies kind enum 위반 거부', () => {
  const r = validateTasksAgainstSchema([{
    ...VALID,
    dependencies: [{ task_id: 'PACT-000', kind: 'soft' }],
  }]);
  assert.equal(r.ok, false);
});
