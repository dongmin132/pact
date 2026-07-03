'use strict';

// driver.mjs 계약 테스트 — CHANGELOG 에 기록된 실 재발버그 3종을 스크립트된 가짜 async-generator
// 로 고정한다. 실제 Agent SDK/네트워크는 쓰지 않는다(query 주입식). 커버 대상:
//   Bug1: SDK 가 abort/timeout·turn/budget 소진 시 throw 대신 error result 를 '반환' →
//         incomplete 로 분류돼 fresh 워커 resume 가 발동해야 한다 (커밋 8163139/resume.js).
//   Bug2: 중간에 끊겨도 마지막 본 usage/cost 를 보존해 spent_usd 집계가 0 이 되지 않는다.
//   Bug3: wall-clock 초과 시 abort + q.close() 로 SDK 를 실제 종료(좀비 방지)하고 incomplete 반환.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerReal, attemptTask, runResumableTask, ledger } from '../scripts/headless-driver/driver.mjs';

// ---- 가짜 query 팩토리 (실 SDK 서명 흉내: query(cfg) → async-iterable) ----

// 스크립트된 메시지를 순서대로 흘리고 자연 종료.
function scriptedQuery(messages) {
  return () => (async function* () { for (const m of messages) yield m; })();
}

// 메시지들을 흘린 뒤 throw — 스트림 중단 시 usage/cost 보존 검증용.
function throwingQuery(messages, err) {
  return () => (async function* () { for (const m of messages) yield m; throw err; })();
}

// 영원히 hang — abort/close 전까지 아무 메시지도 안 뱉는다. 좀비 정리(q.close) 검증용.
// SDK 가 abortController 에 반응해 스트림을 끝내는 동작을 흉내낸다.
function hangingQuery() {
  const state = { closeCalled: false, aborted: false };
  let settle;
  const wait = new Promise((res) => { settle = res; });
  const query = (cfg) => {
    const ac = cfg && cfg.options && cfg.options.abortController;
    if (ac && ac.signal && typeof ac.signal.addEventListener === 'function') {
      ac.signal.addEventListener('abort', () => { state.aborted = true; settle(); }, { once: true });
    }
    return {
      close() { state.closeCalled = true; settle(); },
      [Symbol.asyncIterator]() {
        return { next: () => wait.then(() => ({ done: true, value: undefined })) };
      },
    };
  };
  return { query, state };
}

const baseTask = () => ({ task_id: 'T-1', task_prompt: '원 task 지시', working_dir: '/tmp/pact-wt', allowed_paths: ['**'] });

// ---- Bug1: error_max_turns / error_max_budget_usd → incomplete 분류 (resume 대상) ----

test('runWorkerReal — error_max_turns 결과를 incomplete 로 분류(resume 대상, throw 아님)', async () => {
  ledger.spentUsd = 0;
  const messages = [
    { type: 'assistant', message: { content: [] }, usage: { input_tokens: 100, output_tokens: 200 } },
    { type: 'result', subtype: 'error_max_turns', num_turns: 200, total_cost_usd: 0.4, usage: { input_tokens: 100, output_tokens: 200 } },
  ];
  const r = await runWorkerReal(baseTask(), { query: scriptedQuery(messages) });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true, 'incomplete=true 여야 resume 대상이 된다');
  assert.equal(r.reason, 'error_max_turns');
  assert.ok(r.cost > 0, 'result 의 total_cost_usd 가 보존');
  assert.notEqual(r.usage, null);
});

test('runWorkerReal — error_max_budget_usd 도 incomplete 로 분류', async () => {
  ledger.spentUsd = 0;
  const messages = [
    { type: 'result', subtype: 'error_max_budget_usd', num_turns: 12, total_cost_usd: 9.9, usage: { input_tokens: 50 } },
  ];
  const r = await runWorkerReal(baseTask(), { query: scriptedQuery(messages) });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(r.reason, 'error_max_budget_usd');
});

test('runWorkerReal — subtype=success 는 ok(회귀: 정상 완료는 resume 안 함)', async () => {
  ledger.spentUsd = 0;
  const messages = [
    { type: 'result', subtype: 'success', num_turns: 5, total_cost_usd: 0.3, usage: { input_tokens: 10 } },
  ];
  const r = await runWorkerReal(baseTask(), { query: scriptedQuery(messages) });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'real');
});

test('runResumableTask — incomplete 워커 결과가 fresh 워커 resume 를 발동시킨다', async () => {
  ledger.spentUsd = 0;
  let calls = 0;
  const seenPrompts = [];
  // 1회차: 턴 소진(incomplete), 2회차: 완료. runResumableTask 가 이어서 재투입해야 done.
  const fakeRunner = async (task) => {
    calls++;
    seenPrompts.push(task.task_prompt);
    if (calls === 1) return { ok: false, incomplete: true, reason: 'error_max_turns', cost: 0.1, usage: { input_tokens: 1 }, turns: 200, via: 'real' };
    return { ok: true, cost: 0.1, usage: { input_tokens: 1 }, turns: 5, via: 'real' };
  };
  const r = await runResumableTask(baseTask(), { runWorker: fakeRunner });
  assert.equal(r.status, 'done', 'resume 후 최종 done');
  assert.ok(r.resumes >= 1, `resume 가 최소 1회 발동해야 함 (resumes=${r.resumes})`);
  assert.ok(calls >= 2, `fresh 워커가 재투입돼야 함 (calls=${calls})`);
  // 재투입 프롬프트는 "처음부터 다시"가 아니라 continuation(RESUME) 이어야 한다.
  assert.match(seenPrompts[1], /RESUME/, '2회차 프롬프트는 이어서-완료 continuation');
});

test('runResumableTask — 예산 소진 시 resume 대신 위임(salvage 보존)', async () => {
  ledger.spentUsd = 0;
  const fakeRunner = async () => ({ ok: false, incomplete: true, reason: 'error_max_budget_usd', cost: 100, usage: { input_tokens: 1 }, turns: 3, via: 'real' });
  const r = await runResumableTask(baseTask(), { runWorker: fakeRunner });
  assert.equal(r.status, 'escalated');
  assert.equal(r.salvageable, true, '부분작업 worktree 보존 신호');
});

// ---- Bug2: 부분 usage/cost 에서 spent_usd 집계가 0 이 되지 않는다 ----

test('runWorkerReal — 스트림 중단돼도 마지막 본 usage/cost 를 보존(cost 0 방지)', async () => {
  ledger.spentUsd = 0;
  const messages = [
    { type: 'assistant', message: { content: [{ type: 'text' }] }, usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.12 },
  ];
  const r = await runWorkerReal(baseTask(), { query: throwingQuery(messages, new Error('stream broke')) });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true, 'catch 경로는 incomplete(부분작업 보존)');
  assert.ok(r.cost > 0, `중단 전에 본 cost 가 보존돼야 함 (cost=${r.cost})`);
  assert.notEqual(r.usage, null, 'usage 도 보존');
});

test('attemptTask — 부분 cost 를 ledger.spentUsd 에 집계(0 방지)', async () => {
  ledger.spentUsd = 0;
  const fakeRunner = async () => ({ ok: false, incomplete: true, cost: 0.12, usage: { input_tokens: 1 }, turns: 3, via: 'real' });
  const r = await attemptTask(baseTask(), { runWorker: fakeRunner });
  assert.equal(r.status, 'escalated');
  assert.ok(ledger.spentUsd > 0, `spent_usd 집계가 0 이 아니어야 함 (spentUsd=${ledger.spentUsd})`);
});

// ---- Bug3: abort/timeout 시 좀비 없이 정리(q.close) + incomplete ----

test('runWorkerReal — wall-clock 초과 시 abort + q.close 로 정리하고 incomplete 반환', async () => {
  ledger.spentUsd = 0;
  const { query, state } = hangingQuery();
  // 짧은 backstop(50ms) 주입 → hang 워커를 timeout 으로 끊고 정리 경로를 관측.
  const r = await runWorkerReal(baseTask(), { query, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true, 'timeout → incomplete → resume 대상');
  assert.equal(r.reason, 'timeout');
  assert.equal(state.aborted, true, 'abortController 가 발화(무한 hang 방지)');
  assert.equal(state.closeCalled, true, 'q.close() 로 SDK 를 실제 종료(좀비 방지)');
});
