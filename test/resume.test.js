'use strict';

// 워커-완료 2.2 — fresh-worker 재개 결정 로직 (순수) 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldResume, continuationPrompt, withContinuation } = require('../scripts/worker-completion/resume.js');

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
