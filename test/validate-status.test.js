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

test('tdd_evidence 누락 허용 (ADR-056: 구버전 워커 호환)', () => {
  const bad = { ...VALID };
  delete bad.tdd_evidence;
  const r = validateStatus(bad);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('completed_at이 ISO 형식 아닐 때 거부', () => {
  const r = validateStatus({ ...VALID, completed_at: '오늘' });
  assert.equal(r.ok, false);
});

// ─── ADR-056: required 완화 (task_id + status 2개만 필수) ───

test('ADR-056 — task_id + status만으로 통과 (구버전 워커 산출물 호환)', () => {
  const minimal = { task_id: 'LEGACY-101', status: 'done' };
  const r = validateStatus(minimal);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('ADR-056 — files_attempted_outside_scope 누락 허용', () => {
  const bad = { ...VALID };
  delete bad.files_attempted_outside_scope;
  const r = validateStatus(bad);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('ADR-056 — completed_at 누락 허용', () => {
  const bad = { ...VALID };
  delete bad.completed_at;
  const r = validateStatus(bad);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('ADR-056 — verify_results 누락 허용', () => {
  const bad = { ...VALID };
  delete bad.verify_results;
  const r = validateStatus(bad);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('ADR-056 — files_changed 누락 허용', () => {
  const bad = { ...VALID };
  delete bad.files_changed;
  const r = validateStatus(bad);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('ADR-056 — task_id 누락은 여전히 거부 (필수 2개 중 하나)', () => {
  const r = validateStatus({ status: 'done' });
  assert.equal(r.ok, false);
});

test('ADR-056 — status 누락은 여전히 거부 (필수 2개 중 하나)', () => {
  const r = validateStatus({ task_id: 'PACT-001' });
  assert.equal(r.ok, false);
});

test('ADR-056 — tdd_evidence가 있을 때는 여전히 red_observed/green_observed 필요', () => {
  const r = validateStatus({
    task_id: 'PACT-001',
    status: 'done',
    tdd_evidence: { red_observed: true /* green_observed 누락 */ },
  });
  assert.equal(r.ok, false);
});
