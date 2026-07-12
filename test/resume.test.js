'use strict';

// 워커-완료 2.2 — fresh-worker 재개 결정 로직 (순수) 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  shouldResume, continuationPrompt, withContinuation, classifyRealResult,
  readResumeCount, consumeResume, resumesRemaining, resumeStatePath, DEFAULT_MAX_RESUME,
} = require('../scripts/worker-completion/resume.js');

test('shouldResume: 미완(incomplete) + cap 미만이면 재개', () => {
  assert.equal(shouldResume({ incomplete: true }, 0, 2), true);
  assert.equal(shouldResume({ incomplete: true }, 1, 2), true);
  assert.equal(shouldResume({ incomplete: true }, 2, 2), false, 'cap 도달 → 위임');
});

test('shouldResume: 미완 아니면 재개 안 함', () => {
  assert.equal(shouldResume({ incomplete: false }, 0, 2), false);
  assert.equal(shouldResume(null, 0, 2), false);
});

test('continuationPrompt: 처음부터 다시 X, 부분작업 이어서 + 원 프롬프트 포함', () => {
  const p = continuationPrompt({ task_prompt: 'DO THE THING', working_dir: '/wt/X' }, 1);
  assert.match(p, /RESUME 1/);
  assert.match(p, /git status/);
  assert.match(p, /보존/);
  assert.match(p, /DO THE THING/, '원 task 프롬프트 포함');
});

test('withContinuation: task_prompt 교체, 원본 불변', () => {
  const task = { task_id: 'T', task_prompt: 'ORIG', working_dir: '/wt' };
  const c = withContinuation(task, 1);
  assert.notEqual(c.task_prompt, 'ORIG');
  assert.match(c.task_prompt, /ORIG/);
  assert.equal(c._resume, 1);
  assert.equal(task.task_prompt, 'ORIG', '원본 task 불변');
});

// classifyRealResult — 실 SDK 워커 결과를 {ok, incomplete, reason}로 분류.
// 핵심: abort/timeout 시 SDK 가 throw 아니라 subtype='error_during_execution' result 를
// 반환하는 실제 동작(라이브 --real 로 발견) → incomplete 로 안 잡혀 resume 대신 retry 되던 버그.

test('classifyRealResult: success → ok, 미완 아님', () => {
  const r = classifyRealResult({ subtype: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.incomplete, false);
});

test('classifyRealResult: timeout/abort 는 error_during_execution 이어도 incomplete (실버그 회귀)', () => {
  // SDK 가 abort 시 throw 안 하고 error_during_execution result 를 반환 → catch 우회.
  const r = classifyRealResult({ subtype: 'error_during_execution', timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true, 'timeout 은 미완(보존·resume) — 일시에러 retry 아님');
  assert.equal(r.reason, 'timeout');
});

test('classifyRealResult: aborted signal 도 incomplete', () => {
  const r = classifyRealResult({ subtype: 'error_during_execution', aborted: true });
  assert.equal(r.incomplete, true);
});

test('classifyRealResult: budget/turn 소진 → incomplete', () => {
  assert.equal(classifyRealResult({ subtype: 'error_max_budget_usd' }).incomplete, true);
  assert.equal(classifyRealResult({ subtype: 'error_max_turns' }).incomplete, true);
});

test('classifyRealResult: timeout 아닌 일시 에러 → incomplete 아님(retry 대상)', () => {
  const r = classifyRealResult({ subtype: 'error_during_execution' });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, false, 'timeout/abort 아니면 일시에러 → retry');
});

// ---- 영속 회로차단기 (STR-2 / P2-A) — 재개 카운트가 LLM 기억이 아닌 파일 기반 ----
// .pact/runs/<id>/resume.json 에 누적. 조회(readResumeCount)와 소비(consumeResume)를 분리.

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pact-resume-'));
}

test('resumeStatePath: .pact/runs/<id>/resume.json 을 가리킨다', () => {
  const p = resumeStatePath('/proj', 'PACT-001');
  assert.equal(p, path.join('/proj', '.pact', 'runs', 'PACT-001', 'resume.json'));
});

test('readResumeCount: 파일 없으면 0 (조회는 부수효과 없음)', () => {
  const cwd = tmpProject();
  try {
    assert.equal(readResumeCount(cwd, 'PACT-001'), 0);
    // 조회는 파일을 만들지 않는다 (조회 ≠ 소비)
    assert.equal(fs.existsSync(resumeStatePath(cwd, 'PACT-001')), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('consumeResume: 소비할 때마다 카운트 증가 + 영속 (다음 조회에 반영)', () => {
  const cwd = tmpProject();
  try {
    assert.equal(consumeResume(cwd, 'PACT-001', 2), 1);
    assert.equal(readResumeCount(cwd, 'PACT-001'), 1, '조회는 소비된 값 그대로');
    assert.equal(consumeResume(cwd, 'PACT-001', 2), 2);
    assert.equal(readResumeCount(cwd, 'PACT-001'), 2);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('consumeResume: cap 도달 후에는 증가 안 함 (회로차단기)', () => {
  const cwd = tmpProject();
  try {
    consumeResume(cwd, 'PACT-001', 2);
    consumeResume(cwd, 'PACT-001', 2);
    assert.equal(consumeResume(cwd, 'PACT-001', 2), 2, 'cap=2 초과 소비 거부(위임 신호)');
    assert.equal(readResumeCount(cwd, 'PACT-001'), 2);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('consumeResume: task 별로 카운트 독립', () => {
  const cwd = tmpProject();
  try {
    consumeResume(cwd, 'PACT-001', 2);
    assert.equal(readResumeCount(cwd, 'PACT-001'), 1);
    assert.equal(readResumeCount(cwd, 'PACT-002'), 0, '다른 task 는 0');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('resumesRemaining: cap - 소비, 0 미만 clamp', () => {
  assert.equal(resumesRemaining(0, 2), 2);
  assert.equal(resumesRemaining(1, 2), 1);
  assert.equal(resumesRemaining(2, 2), 0);
  assert.equal(resumesRemaining(3, 2), 0, '음수는 0 으로');
  assert.equal(DEFAULT_MAX_RESUME, 2);
});

// ---- doc-lint: parallel.md 가 fresh-resume 프롬프트를 인라인 리터럴로 중복하지 않고
//      resume-prompt CLI 단일소스를 호출하는지 (STR-2 실제 drift 봉쇄) ----

test('doc-lint: parallel.md 는 resume-prompt CLI 를 호출하고 인라인 연속프롬프트 리터럴이 없다', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'commands', 'parallel.md'), 'utf8');
  assert.match(md, /pact resume-prompt/, 'resume-prompt CLI 호출(단일소스)을 써야 함');
  assert.doesNotMatch(
    md,
    /처음부터 다시 X — git status로 진행 확인/,
    'fresh-resume 프롬프트 인라인 리터럴은 resume.js 단일소스로 이관됐어야 함',
  );
});

// ---- doc-lint: parallel.md 는 이벤트 루프 슬롯 파이프라인이다 (배치-배리어 아님) ----
//   완료마다 collect-one(단건 게이트 머지) + 슬롯이 비면 admit(다음 task 온디맨드) 을 써야 하고,
//   "모든 워커 종료 후 배치 collect" 배리어 지시로 회귀하면 안 된다(이중 머지 방지).
test('doc-lint: parallel.md 는 collect-one·admit 슬롯 파이프라인을 쓴다 (배리어 회귀 금지)', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'commands', 'parallel.md'), 'utf8');
  assert.match(md, /run-cycle collect-one/, '완료마다 단건 게이트 머지(collect-one)를 써야 함');
  assert.match(md, /run-cycle admit/, '슬롯이 비면 다음 task 온디맨드 투입(admit)을 써야 함');
  assert.match(md, /--graph/, 'prepare --graph 로 전체 DAG(다음 투입 후보)를 확보해야 함');
  assert.doesNotMatch(
    md,
    /모든 워커 종료 후 collect/,
    '배치-배리어("모든 워커 종료 후 collect") 지시로 회귀하면 안 됨 — collect-one 이 완료마다 머지',
  );
});
