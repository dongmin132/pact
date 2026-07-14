'use strict';

// driver.mjs 계약 테스트 — CHANGELOG 에 기록된 실 재발버그 3종을 스크립트된 가짜 async-generator
// 로 고정한다. 실제 Agent SDK/네트워크는 쓰지 않는다(query 주입식). 커버 대상:
//   Bug1: SDK 가 abort/timeout·turn/budget 소진 시 throw 대신 error result 를 '반환' →
//         incomplete 로 분류돼 fresh 워커 resume 가 발동해야 한다 (커밋 8163139/resume.js).
//   Bug2: 중간에 끊겨도 마지막 본 usage/cost 를 보존해 spent_usd 집계가 0 이 되지 않는다.
//   Bug3: wall-clock 초과 시 abort + q.close() 로 SDK 를 실제 종료(좀비 방지)하고 incomplete 반환.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkerReal, attemptTask, runResumableTask, ledger, tallySettle, synthesizeRunStatus, appendDriverEvent, beginCycleEvents, driverEventLine } from '../scripts/headless-driver/driver.mjs';

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

// ---- DRV-3: 동시 실행 워커끼리 남은 예산을 균등 분할(K×BUDGET 폭주 방지) ----

// cfg.options.maxBudgetUsd 만 캡처하고 즉시 성공 종료하는 spy query.
function budgetSpyQuery(sink) {
  return (cfg) => {
    sink.cap = cfg.options.maxBudgetUsd;
    return (async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.1, usage: { input_tokens: 1 } };
    })();
  };
}

test('runWorkerReal — 동시 K 워커면 per-worker cap 이 예산/동시수로 나뉜다(K=3,budget=3 → 워커 1개가 3 전액 못 받음)', async () => {
  ledger.spentUsd = 0;
  const sink = {};
  const r = await runWorkerReal(baseTask(), { query: budgetSpyQuery(sink), budget: 3, activeWorkers: 3 });
  assert.equal(r.ok, true);
  // 이전 코드는 각 워커에 (BUDGET-spent) 전액을 배정 → 동시 3 워커면 실효 상한 3×budget 로 폭주.
  assert.ok(sink.cap < 3, `동시 3 워커면 한 워커가 예산 전액(3)을 받으면 안 됨 — cap=${sink.cap}`);
  assert.equal(sink.cap, 1, 'budget 3 / 동시 3 = per-worker cap 1');
});

test('runWorkerReal — 마지막 1 워커만 남으면 잔여 예산 전액 사용(적응적 분할, 회귀)', async () => {
  ledger.spentUsd = 0;
  const sink = {};
  await runWorkerReal(baseTask(), { query: budgetSpyQuery(sink), budget: 3, activeWorkers: 1 });
  assert.equal(sink.cap, 3, '동시 1 → 잔여 예산 전액(적응적)');
});

test('runWorkerReal — 이미 쓴 비용을 제하고 남은 예산만 분할(spentUsd 반영)', async () => {
  ledger.spentUsd = 1.5;
  const sink = {};
  await runWorkerReal(baseTask(), { query: budgetSpyQuery(sink), budget: 4.5, activeWorkers: 3 });
  assert.equal(sink.cap, 1, '(4.5 - 1.5) / 3 = 1');
  ledger.spentUsd = 0;
});

// ---- P1-#3: 예산 상한 누수 — floor(0.5) 가 declared 예산을 넘고, in-flight 예약 미차감으로 K×cap 폭주 ----

// gate 가 열릴 때까지 in-flight 를 유지하는 query 팩토리 — 여러 워커의 예약이 동시에 겹치게 한다.
function gatedQueryFactory() {
  const releases = [];
  const make = (sink) => {
    let open; const gate = new Promise((res) => { open = res; }); releases.push(open);
    return (cfg) => {
      sink.cap = cfg.options.maxBudgetUsd;
      return (async function* () {
        await gate;
        yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1 } };
      })();
    };
  };
  return { make, releaseAll: () => releases.forEach((r) => r()) };
}

test('P1-#3(a) — --budget 이 floor(0.5)보다 작으면 per-worker cap 이 declared 예산을 넘지 않는다', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const sink = {};
  // 재현: budget=0.1, active=1 인데 구코드는 Math.max(0.5, …) 바닥값 때문에 cap=0.5(>declared 0.1).
  const r = await runWorkerReal(baseTask(), { query: budgetSpyQuery(sink), budget: 0.1, activeWorkers: 1 });
  assert.equal(r.ok, true);
  assert.ok(sink.cap <= 0.1 + 1e-9, `per-worker cap 이 declared 예산(0.1)을 초과하면 안 됨 — cap=${sink.cap}`);
  assert.notEqual(sink.cap, 0.5, 'floor(0.5) 가 남은 예산을 덮어써선 안 됨(누수)');
});

test('P1-#3(b) — 동시 K 워커의 배정 cap 합이 budget 을 넘지 않는다(in-flight 예약 회계)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const K = 4, budget = 4;
  const { make, releaseAll } = gatedQueryFactory();
  const sinks = Array.from({ length: K }, () => ({}));
  const promises = [];
  // 레이스 인터리빙 모델: 워커가 슬롯을 채우며 순차 spawn → 각자 그 순간의 in-flight 수(1,2,…,K)를
  // activeWorkers 로 본다. 구코드는 이미 실행 중인 워커의 미사용 상한을 예약으로 안 빼서 W1 이 잔여
  // 전액을 쥔 채로 W2,W3… 가 또 '잔여/현재수'를 받아 배정 cap 합이 budget 을 크게 초과(잠재 지출 폭주).
  for (let i = 0; i < K; i++) promises.push(runWorkerReal(baseTask(), { query: make(sinks[i]), budget, activeWorkers: i + 1 }));
  const caps = sinks.map((s) => s.cap);
  const sum = caps.reduce((a, b) => a + b, 0);
  assert.equal(caps.filter((c) => typeof c === 'number').length, K, 'K 워커 모두 cap 배정됨');
  assert.ok(sum <= budget + 1e-9, `동시 ${K} 워커의 배정 cap 합(${sum.toFixed(4)}) 이 budget(${budget}) 을 넘으면 안 됨`);
  releaseAll();
  await Promise.all(promises);
  assert.ok(Math.abs(ledger.reservedUsd) < 1e-9, `모든 워커 종료 후 예약액이 0 으로 해제돼야 함 — reservedUsd=${ledger.reservedUsd}`);
});

test('P1-#3(b) — 예약 소진 후 마지막 워커는 잔여를 초과 배정하지 않는다(floor 도 잔여로 clamp)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const { make, releaseAll } = gatedQueryFactory();
  const budget = 1;
  const s1 = {}, s2 = {};
  // W1 이 active=1 로 잔여 전액(1)을 예약 → 남은 예산 0. 구코드는 W1 의 예약을 안 차감해 W2 도 전액(1)을
  // 다시 배정(잠재 지출 2 > budget 1). 수리 후 W2 는 잔여 0(floor 0.5 도 잔여로 clamp).
  const p1 = runWorkerReal(baseTask(), { query: make(s1), budget, activeWorkers: 1 });
  const p2 = runWorkerReal(baseTask(), { query: make(s2), budget, activeWorkers: 1 });
  assert.equal(s1.cap, 1, 'W1 = 잔여 전액');
  assert.ok(s2.cap <= 1e-9, `W2 는 남은 예산(0)을 초과 배정 못 함(예약 차감) — cap=${s2.cap}`);
  assert.ok(s1.cap + s2.cap <= budget + 1e-9, '배정 cap 합 ≤ budget');
  releaseAll();
  await Promise.all([p1, p2]);
  ledger.reservedUsd = 0;
});

// ---- 트랙2 잔여: 예약 해제 ↔ 지출 기입 원자성 (해제-기입 간극 재현) ----
// 1차 P1-#3 수리(reservedUsd 예약 회계)는 floor·K×cap 을 닫았으나, 예약 해제(runWorkerReal.finally)가
// 실제 cost 기입(상위 attemptTask/runLoopTask, 한 마이크로태스크 뒤)보다 먼저였다. 떠나는 워커 B 가
// 예약을 반납했으나 cost 를 아직 spent 에 안 넣은 창에 재투입된 C 가 remaining=budget-spent-reserved 를
// 과대평가 → 잔여 초과 예약(잠재 지출 > budget). 이 테스트는 runWorkerReal 을 직접 호출로 우회하지
// 않고 attemptTask(상위 호출자) 경로로 그 간극을 실제 재현한다. 수리 후 spent 가산과 reserved 해제가
// 원자적이라 어떤 인터리빙에서도 spent+reserved ≤ budget.
test('트랙2 잔여 — 예약 해제↔지출 기입 원자성: 재투입 인터리빙에서 spent+reserved ≤ budget', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const budget = 10;

  // C(재투입 워커): gate 가 열릴 때까지 in-flight 유지 → 간극 관측 창을 넓힌다. cost 0.
  let openC; const cGate = new Promise((res) => { openC = res; });
  const cSink = {};
  const cQuery = (cfg) => {
    cSink.cap = cfg.options.maxBudgetUsd;
    return (async function* () { await cGate; yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1 } }; })();
  };
  let cPromise = null;

  // B(떠나는 워커): 즉시 cost 4 로 완료 → 예약(10) 반납. wrapper 가 B 의 runWorkerReal resolve 직후
  // (=attemptTask 가 아직 spent 를 안 더한 간극)에 C 를 재투입해 그 창을 실제로 만든다.
  const bQuery = () => (async function* () { yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 4, usage: { input_tokens: 1 } }; })();
  const bWrapped = async (task) => {
    const r = await runWorkerReal(task, { query: bQuery, budget, activeWorkers: 1 }); // B 예약 10 반납(finally)
    // ★ 간극: B 의 예약은 해제됐고, attemptTask(B) 의 spent 가산은 아직(이 return 뒤). 여기서 C 재투입.
    cPromise = attemptTask({ ...baseTask(), task_id: 'C' }, { runWorker: (t) => runWorkerReal(t, { query: cQuery, budget, activeWorkers: 1 }) });
    return r;
  };

  await attemptTask({ ...baseTask(), task_id: 'B' }, { runWorker: bWrapped });
  // 이 시점: B 의 지출(4)은 완전히 반영, C 는 아직 in-flight(gate 대기).
  const inv = ledger.spentUsd + ledger.reservedUsd;
  // 구코드: B 예약 반납 후 C 가 remaining=10(spent0·reserved0)을 봐서 10 예약 → spent4+reserved10=14>10.
  assert.ok(inv <= budget + 1e-9, `해제-기입 간극 인터리빙에서 spent(${ledger.spentUsd})+reserved(${ledger.reservedUsd}) ≤ budget(${budget})`);
  // 재투입 C 도 남은 예산(6)만 배정받아야 한다(구코드는 10 을 봄).
  assert.ok(cSink.cap <= budget - 4 + 1e-9, `재투입 C 의 cap(${cSink.cap}) 은 잔여 예산(${budget - 4}) 이하`);

  openC();
  await cPromise;
  assert.ok(Math.abs(ledger.reservedUsd) < 1e-9, `모든 워커 종료 후 예약 0 (reservedUsd=${ledger.reservedUsd})`);
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
});

// ---- DX-2: 파이프라인 라이브 진행 카운터 — settle 마다 즉시 증가(종료 전 0 고착 아님) ----

test('DX-2 — settle 이벤트가 done/escalated 카운터를 즉시 증가(종료까지 0 고착이던 버그)', () => {
  const c = { done: 0, escalated: 0, rejected: 0 };
  // 워커 1개가 머지 성공으로 settle → done 은 이 시점에 이미 1 (구코드는 driver-state 에 종료까지 0).
  tallySettle(c, { type: 'settle', outcome: { task_id: 'A', status: 'done' }, merge: { result: 'merged' } });
  assert.equal(c.done, 1, '완료 즉시 done++');
  tallySettle(c, { type: 'settle', outcome: { task_id: 'B', status: 'escalated' } });
  assert.equal(c.escalated, 1, '위임 즉시 escalated++');
  // 워커가 done 이어도 단건 머지가 rejected 면 base 미반영 → done 아님(rejected 로 센다).
  tallySettle(c, { type: 'settle', outcome: { task_id: 'C', status: 'done' }, merge: { result: 'rejected' } });
  assert.equal(c.done, 1, '머지 rejected 는 done 계상 X');
  assert.equal(c.rejected, 1);
  // 비-settle(dispatch/requeue) 이벤트는 카운터 불변.
  tallySettle(c, { type: 'dispatch', id: 'D', in_flight: ['D'] });
  assert.deepEqual(c, { done: 1, escalated: 1, rejected: 1 }, 'dispatch 는 무시');
});

test('DX-2 — 라이브 누계가 종료 tally 와 정확히 일치(종료 순간 숫자 튐 없음)', () => {
  // 파이프라인 settle 시퀀스 재현: 드라이버가 done+merge-rejected 를 rejected 로 재라벨한 종료 tally 와
  // settle 시점 라이브 누계가 같아야 --watch 가 종료 순간 값 점프를 안 겪는다.
  const settles = [
    { type: 'settle', outcome: { task_id: 'A', status: 'done' }, merge: { result: 'merged' } },
    { type: 'settle', outcome: { task_id: 'B', status: 'done' }, merge: { result: 'rejected' } }, // 재라벨→rejected
    { type: 'settle', outcome: { task_id: 'C', status: 'escalated' } },
    { type: 'settle', outcome: { task_id: 'D', status: 'done' }, merge: { result: 'already_merged' } },
  ];
  const live = { done: 0, escalated: 0, rejected: 0 };
  for (const e of settles) tallySettle(live, e);
  assert.deepEqual(live, { done: 2, escalated: 1, rejected: 1 }, '라이브 누계 = 종료 tally');
});

// ---- IMP-2: 워커 미보고 status.json 합성 — metrics 가 비용0·failed 로 오집계하지 않도록 ----

test('IMP-2 — escalate 워커가 status.json 없이 죽으면 드라이버가 권위 데이터로 합성(synthesized_by 마커)', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-imp2-'));
  try {
    const o = { task_id: 'T-9', status: 'escalated', salvageable: true, reason: 'timeout — 예산 소진',
      cost: 0.42, resumes: 2, attempts: 3, usage: { input_tokens: 1000, output_tokens: 2000 } };
    const res = synthesizeRunStatus(o, { runsRoot });
    assert.equal(res.written, true, '워커 미보고 → 합성');
    const sp = path.join(runsRoot, 'T-9', 'status.json');
    assert.ok(fs.existsSync(sp), 'status.json 이 생성돼야 함');
    const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert.equal(j.synthesized_by, 'driver', '드라이버 합성 마커');
    assert.equal(j.status, 'blocked', 'salvageable escalate → blocked (metrics 미완 집계; failed·비용0 아님)');
    assert.ok(j.cost_usd > 0, 'SDK 실측 비용 보존(비용0 오집계 방지)');
    assert.ok(j.tokens_used > 0, 'tokens 보존');
    assert.equal(j.resumes, 2, 'resume 횟수 보존');
    assert.equal(j.salvageable, true);
  } finally { fs.rmSync(runsRoot, { recursive: true, force: true }); }
});

test('IMP-2 — 워커 자기보고 status.json 이 있으면 절대 덮지 않는다', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-imp2b-'));
  try {
    const dir = path.join(runsRoot, 'T-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ task_id: 'T-1', status: 'done', tokens_used: 5, self: true }));
    const res = synthesizeRunStatus({ task_id: 'T-1', status: 'escalated', cost: 9 }, { runsRoot });
    assert.equal(res.written, false, '자기보고 존재 → 합성 스킵');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
    assert.equal(j.self, true, '워커 자기보고 원본 보존');
    assert.equal(j.synthesized_by, undefined, '드라이버 마커가 붙지 않음(안 덮음)');
  } finally { fs.rmSync(runsRoot, { recursive: true, force: true }); }
});

test('IMP-2 — non-salvageable escalate 는 failed 로 매핑(metrics unfinished)', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-imp2c-'));
  try {
    synthesizeRunStatus({ task_id: 'F-1', status: 'escalated', salvageable: false, cost: 0.1 }, { runsRoot });
    const j = JSON.parse(fs.readFileSync(path.join(runsRoot, 'F-1', 'status.json'), 'utf8'));
    assert.equal(j.status, 'failed', '보존할 부분작업 없는 하드실패 → failed');
    assert.equal(j.synthesized_by, 'driver');
  } finally { fs.rmSync(runsRoot, { recursive: true, force: true }); }
});

// ---- IMP-1: 파이프라인 타이밍 이벤트를 driver-events.jsonl 로 영속 ----

test('IMP-1 — driverEventLine: pool 이벤트(id) → JSONL 레코드(task_id·ts ISO·결말)', () => {
  const disp = driverEventLine({ type: 'dispatch', id: 'A', ts: 0 });
  assert.equal(disp.type, 'dispatch');
  assert.equal(disp.task_id, 'A');
  assert.match(disp.ts, /^\d{4}-\d{2}-\d{2}T/, 'epoch → ISO');
  const settle = driverEventLine({ type: 'settle', id: 'B', ts: 100, outcome: { status: 'done' }, merge: { result: 'merged' } });
  assert.equal(settle.status, 'done');
  assert.equal(settle.merge, 'merged');
});

// ---- IMP-5: 다운시프트 이벤트를 JSONL 로 영속(from/to/direction 관측) ----

test('IMP-5 — driverEventLine: downshift 이벤트 → from/to/direction/signal 레코드', () => {
  const rec = driverEventLine({ type: 'downshift', id: 'A', ts: 200, from: 5, to: 4, direction: 'down', signal: 'rate_limit' });
  assert.equal(rec.type, 'downshift');
  assert.equal(rec.task_id, 'A');
  assert.equal(rec.from, 5);
  assert.equal(rec.to, 4);
  assert.equal(rec.direction, 'down');
  assert.equal(rec.signal, 'rate_limit');
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/, 'epoch → ISO');
});

test('IMP-1 — appendDriverEvent: JSONL 한 줄씩 append(eventsPath 주입)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-imp1-'));
  try {
    const eventsPath = path.join(dir, 'driver-events.jsonl');
    appendDriverEvent({ ts: '2026-01-01T00:00:00Z', type: 'dispatch', task_id: 'A' }, { eventsPath });
    appendDriverEvent({ ts: '2026-01-01T00:00:01Z', type: 'settle', task_id: 'A', status: 'done' }, { eventsPath });
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, 'dispatch');
    assert.equal(JSON.parse(lines[1]).status, 'done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('IMP-1 — beginCycleEvents: 새 cycle_id 는 회전(truncate), 같은 cycle_id 는 이월', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-imp1b-'));
  try {
    const eventsPath = path.join(dir, 'driver-events.jsonl');
    beginCycleEvents('cid-1', 1, { eventsPath });
    appendDriverEvent({ ts: 't', type: 'dispatch', task_id: 'A' }, { eventsPath });
    // 같은 cycle_id(resume/admit) → 이월: 기존 A 이벤트 보존
    beginCycleEvents('cid-1', 1, { eventsPath });
    let lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.task_id === 'A'), '같은 사이클 → 이벤트 이월(무회전)');
    // 새 cycle_id → 회전: 이전 A 이벤트 폐기(무한 성장 방지)
    beginCycleEvents('cid-2', 2, { eventsPath });
    lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(!lines.some((l) => l.task_id === 'A'), '새 사이클 → 이전 이벤트 회전');
    const last = lines[lines.length - 1];
    assert.equal(last.type, 'cycle');
    assert.equal(last.cycle_id, 'cid-2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- T2-1: canUseTool shadow — allowedTools 는 canUseTool 을 스킵시킨다(공식 문서 + SDK 0.3.178 실측) ----
// 실측(2026-07-14): allowedTools=[Write,...] 구성에서 Write 가 실행돼 파일이 생겼는데 deny 콜백은
// 0회 호출됨. 즉 allowedTools 에 든 도구는 가드를 우회한다 → 드라이버는 allowedTools 를 절대
// 넘기면 안 되고, canUseTool(worker-guard)이 유일한 관문이어야 한다. 이 테스트가 그 계약을 고정.

test('T2-1 — SDK 옵션에 allowedTools 를 넘기지 않는다(재도입 시 가드 무력화)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const sink = {};
  const spy = (cfg) => {
    sink.options = cfg.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1 } };
    })();
  };
  await runWorkerReal(baseTask(), { query: spy });
  assert.equal(sink.options.allowedTools, undefined,
    'allowedTools 가 있으면 그 도구들은 canUseTool 을 스킵(자동 승인) — worker-guard 죽은 코드화');
  assert.equal(typeof sink.options.canUseTool, 'function', 'canUseTool 가드는 반드시 배선');
});

test('T2-1 — canUseTool 이 allowed_paths 밖 Write 를 deny, 안은 allow (가드 실효)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const sink = {};
  const spy = (cfg) => {
    sink.options = cfg.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1 } };
    })();
  };
  const task = { ...baseTask(), allowed_paths: ['src/**'] };
  await runWorkerReal(task, { query: spy });
  const deny = await sink.options.canUseTool('Write', { file_path: '/tmp/pact-wt/docs/evil.md' });
  assert.equal(deny.behavior, 'deny', 'allowed_paths 밖 Write 는 deny');
  const allow = await sink.options.canUseTool('Write', { file_path: '/tmp/pact-wt/src/ok.js' });
  assert.equal(allow.behavior, 'allow', 'allowed_paths 안 Write 는 allow');
});

// ---- T2-3: abort/throw 로 result 메시지가 없으면 assistant usage 로 비용 추정 ----
// 실측(SDK 0.3.178): abort 시 SDK 는 result 없이 throw → total_cost_usd/usage 미포착 → 워커
// 비용이 $0.00 으로 ledger 에 기록돼 budget cap 이 실지출을 과소계상한다. assistant 메시지의
// message.usage 를 message.id 로 dedup 누적(같은 API 응답의 블록들이 usage 를 공유)해
// cost-estimate 로 추정하고 costEstimated 마커를 찍는다.

test('T2-3 — result 없이 throw 시 assistant usage 추정 비용이 ledger 에 반영(estimated)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const u = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 10000 };
  const messages = [
    { type: 'assistant', message: { id: 'msg_1', usage: u, content: [] } },
    { type: 'assistant', message: { id: 'msg_1', usage: u, content: [] } }, // 같은 API 응답의 둘째 블록 — 이중계상 금지
    { type: 'assistant', message: { id: 'msg_2', usage: u, content: [] } },
  ];
  const r = await runWorkerReal(baseTask(), { query: throwingQuery(messages, new Error('Claude Code process aborted by user')) });
  assert.equal(r.ok, false);
  assert.equal(r.costEstimated, true, '관측 못한 비용은 추정 마커를 달아야 함');
  // MODEL 기본값 'sonnet' — msg_1 1회 + msg_2 1회 (dedup) = usage 2배
  const { estimateCostUsd } = await import('../scripts/lib/cost-estimate.js');
  const expected = estimateCostUsd({
    input_tokens: 2000, output_tokens: 4000, cache_read_input_tokens: 200000, cache_creation_input_tokens: 20000,
  }, 'sonnet');
  assert.ok(expected > 0, '추정 단가 테이블 유효');
  assert.ok(Math.abs(r.cost - expected) < 1e-9, `dedup 추정: cost=${r.cost} expected=${expected}`);
  assert.ok(Math.abs(ledger.spentUsd - expected) < 1e-9, `ledger 반영: spent=${ledger.spentUsd}`);
});

test('T2-3 — result 가 온 정상/에러 경로는 total_cost_usd 가 우선(추정 안 함)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const u = { input_tokens: 1000, output_tokens: 2000 };
  const messages = [
    { type: 'assistant', message: { id: 'msg_1', usage: u, content: [] } },
    { type: 'result', subtype: 'error_max_turns', num_turns: 9, total_cost_usd: 0.42, usage: u },
  ];
  const r = await runWorkerReal(baseTask(), { query: scriptedQuery(messages) });
  assert.equal(r.cost, 0.42, 'SDK 실측 비용이 있으면 그대로');
  assert.notEqual(r.costEstimated, true, '실측이 있으면 추정 마커 없음');
});

// ---- C-1: worker_model 분기 — 단순 task 는 Haiku 로 (배치 토큰의 ~70%가 워커) ----

test('C-1 — task.worker_model 이 SDK options.model 로 전달(per-task 분기)', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const sink = {};
  const spy = (cfg) => { sink.options = cfg.options; return (async function* () { yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1 } }; })(); };
  await runWorkerReal({ ...baseTask(), worker_model: 'haiku' }, { query: spy });
  assert.equal(sink.options.model, 'haiku');
});

test('C-1 — worker_model 없으면 기본 MODEL(sonnet) 유지', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const sink = {};
  const spy = (cfg) => { sink.options = cfg.options; return (async function* () { yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1 } }; })(); };
  await runWorkerReal(baseTask(), { query: spy });
  assert.equal(sink.options.model, 'sonnet');
});

test('C-1×T2-3 — abort 비용 추정도 per-task 모델 단가로 계산', async () => {
  ledger.spentUsd = 0; ledger.reservedUsd = 0;
  const u = { input_tokens: 1000, output_tokens: 1000 };
  const messages = [{ type: 'assistant', message: { id: 'm1', usage: u, content: [] } }];
  const r = await runWorkerReal({ ...baseTask(), worker_model: 'opus' }, { query: throwingQuery(messages, new Error('aborted')) });
  const { estimateCostUsd } = await import('../scripts/lib/cost-estimate.js');
  const expected = estimateCostUsd(u, 'opus');
  assert.ok(Math.abs(r.cost - expected) < 1e-12, `opus 단가 추정: ${r.cost} ≠ ${expected}`);
});
