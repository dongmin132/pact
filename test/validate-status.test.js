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

// ─── SPD-5: summary 자유 서술 필드 ───

test('SPD-5 — summary(string) 있으면 통과 (거부 X)', () => {
  const r = validateStatus({ ...VALID, summary: '로그인 검증 추가. 엣지케이스 2건 해결.' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('SPD-5 — summary 누락 허용(선택 필드)', () => {
  const r = validateStatus(VALID);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('SPD-5 — summary 비-string 거부', () => {
  const r = validateStatus({ ...VALID, summary: ['a', 'b'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.path === '/summary'));
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

// ─── issue #3 (v0.8.1): decisions error 풍부화 ───

test('issue#3 — decisions가 string[]이면 각 item 메시지에 required 필드 안내', () => {
  const r = validateStatus({
    ...VALID,
    decisions: ['legacy 문장 1', 'legacy 문장 2'],
  });
  assert.equal(r.ok, false);
  // 각 item에 대해 schema가 어떤 형태인지 메시지에 노출 (worker self-correct 가능하도록)
  const msgs = r.errors.map(e => e.message).join(' | ');
  assert.match(msgs, /topic.*choice.*rationale/, `errors: ${JSON.stringify(r.errors)}`);
});

test('issue#3 — decisions 위반 error에 instancePath 박혀있음 (decisions/0)', () => {
  const r = validateStatus({
    ...VALID,
    decisions: ['문장'],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some(e => /\/decisions\/0$/.test(e.path)),
    `paths: ${JSON.stringify(r.errors.map(e => e.path))}`,
  );
});

test('issue#3 — decisions item이 object지만 topic 누락도 path 박혀있음', () => {
  const r = validateStatus({
    ...VALID,
    decisions: [{ choice: 'X', rationale: 'Y' }],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some(e => e.path === '/decisions/0/topic'),
    `paths: ${JSON.stringify(r.errors.map(e => e.path))}`,
  );
});
