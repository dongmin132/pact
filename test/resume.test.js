'use strict';

// 워커-완료 2.2 — fresh-worker 재개 결정 로직 (순수) 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldResume, continuationPrompt, withContinuation, classifyRealResult } = require('../scripts/worker-completion/resume.js');

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
