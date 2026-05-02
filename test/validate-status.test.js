'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStatus } = require('../scripts/validate-status.js');

const VALID = {
  task_id: 'PACT-001',
  status: 'done',
  branch_name: 'pact/PACT-001',
  commits_made: 2,
  clean_for_merge: true,
  files_changed: ['src/api/auth/login.ts'],
  files_attempted_outside_scope: [],
  verify_results: {
    lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass'
  },
  tdd_evidence: { red_observed: true, green_observed: true },
  decisions: [],
  blockers: [],
  tokens_used: 12000,
  completed_at: '2026-05-02T10:00:00Z'
};

test('정상 status.json 통과', () => {
  const r = validateStatus(VALID);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('필수 필드 누락 거부 (task_id)', () => {
  const bad = { ...VALID };
  delete bad.task_id;
  const r = validateStatus(bad);
  assert.equal(r.ok, false);
});

test('status enum 위반 거부', () => {
  const r = validateStatus({ ...VALID, status: 'finished' });
  assert.equal(r.ok, false);
});

test('verify_results 값이 enum 외 거부', () => {
  const r = validateStatus({
    ...VALID,
    verify_results: { lint: 'maybe' },
  });
  assert.equal(r.ok, false);
});

test('task_id 형식 위반 거부', () => {
  const r = validateStatus({ ...VALID, task_id: 'lowercase-1' });
  assert.equal(r.ok, false);
});

test('tdd_evidence 누락 거부', () => {
  const bad = { ...VALID };
  delete bad.tdd_evidence;
  const r = validateStatus(bad);
  assert.equal(r.ok, false);
});

test('completed_at이 ISO 형식 아닐 때 거부', () => {
  const r = validateStatus({ ...VALID, completed_at: '오늘' });
  assert.equal(r.ok, false);
});
