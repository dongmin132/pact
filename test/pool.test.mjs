'use strict';

// K-슬롯 워커 풀 스케줄러 단위 테스트 (P2-2 · SPD-1 + SPD-3).
// 순수 스케줄러라 admit/runTask/mergeOne/overlaps 를 mock 으로 주입해 결정적으로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../experiments/headless-driver/pool.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overlapsBy = (a, b) => a.some((x) => b.includes(x));

// 이벤트 로그 기반 harness — run:/done:/merge: 시점을 기록.
function harness(taskSpec, { mergeResults = {}, delays = {} } = {}) {
  const tasks = new Map(Object.entries(taskSpec).map(([id, t]) => [id, {
    deps: t.deps || [],
    allowed_paths: t.paths || [],
    size: t.size ?? 0,
  }]));
  const events = [];
  const mergeCalls = [];
  const admit = async (id) => ({ ok: true, task: { task_id: id } });
  const runTask = async (task) => {
    events.push('run:' + task.task_id);
    await sleep(delays[task.task_id] ?? 5);
    events.push('done:' + task.task_id);
    return { task_id: task.task_id, status: 'done' };
  };
  const mergeOne = async (id) => {
    mergeCalls.push(id);
    events.push('merge:' + id);
    const r = mergeResults[id] ?? 'merged';
    return typeof r === 'string' ? { result: r } : r;
  };
  return { tasks, events, mergeCalls, admit, runTask, mergeOne };
}
const idx = (events, e) => events.indexOf(e);

test('pool — 슬롯 재충전: 빠른 task 완료 즉시 다음 task 투입 (배치 전원 대기 X)', async () => {
  // slots=2. A(빠름)·B(느림) 먼저 투입 → A 완료로 슬롯 나면 C 즉시 투입(B 완료 전).
  const h = harness(
    { A: { size: 4 }, B: { size: 3 }, C: { size: 2 }, D: { size: 1 } },
    { delays: { A: 5, B: 80, C: 5, D: 5 } },
  );
  const r = await runPipeline({ slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne });
  // C 는 A 가 끝나 슬롯이 비어야 투입됨 → run:C 는 done:A 이후, 그러나 done:B 이전(즉시 재충전).
  assert.ok(idx(h.events, 'run:C') > idx(h.events, 'done:A'), 'C 는 A 완료 후 투입');
  assert.ok(idx(h.events, 'run:C') < idx(h.events, 'done:B'), 'C 는 B(느림) 완료를 기다리지 않고 즉시 투입');
  assert.equal(r.outcomes.length, 4);
  assert.equal(r.conflicted, null);
});

test('pool — path 겹침 task 는 in-flight 해소 전 투입 안 됨', async () => {
  // A·B 는 src/x 겹침, C 는 src/y. slots=2 → A + C 동시, B 는 A 머지 후에야.
  const h = harness(
    { A: { size: 3, paths: ['src/x.ts'] }, B: { size: 2, paths: ['src/x.ts'] }, C: { size: 1, paths: ['src/y.ts'] } },
    { delays: { A: 40, C: 5 } },
  );
  const r = await runPipeline({
    slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne, overlaps: overlapsBy,
  });
  assert.ok(idx(h.events, 'run:C') < idx(h.events, 'done:A'), 'C 는 A 와 동시 실행(무겹침)');
  assert.ok(idx(h.events, 'run:B') > idx(h.events, 'merge:A'), 'B 는 A 머지(=in-flight 해소) 후에야 투입');
  assert.equal(r.outcomes.length, 3);
});

test('pool — LPT: 가장 큰 task 를 먼저 투입 (makespan 최소화)', async () => {
  const h = harness({ A: { size: 1 }, B: { size: 2 }, C: { size: 3 }, D: { size: 4 } }, { delays: { A: 5, B: 5, C: 5, D: 5 } });
  await runPipeline({ slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne });
  const firstTwo = h.events.filter((e) => e.startsWith('run:')).slice(0, 2).map((e) => e.slice(4));
  assert.deepEqual(firstTwo.sort(), ['C', 'D'], '가장 큰 두 개(D=4,C=3)가 먼저 투입');
});

test('pool — 완료 즉시 단건 머지 호출(task 당 1회, 게이트 경유)', async () => {
  const h = harness({ A: { size: 1 }, B: { size: 1 }, C: { size: 1 } });
  const r = await runPipeline({ slots: 3, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne });
  assert.deepEqual(h.mergeCalls.sort(), ['A', 'B', 'C'], '완료된 task 마다 mergeOne 1회');
  assert.equal(r.merges.length, 3);
  assert.ok(r.merges.every((m) => m.result === 'merged'));
});

test('pool — 충돌 시 정지: 이후 task dispatch 안 됨 + conflicted 반환', async () => {
  // slots=1 로 순차. A 머지가 conflicted → B·C 는 투입 금지.
  const h = harness(
    { A: { size: 3 }, B: { size: 2 }, C: { size: 1 } },
    { mergeResults: { A: { result: 'conflicted', detail: { task_id: 'A', files: ['src/x.ts'] } } } },
  );
  const r = await runPipeline({ slots: 1, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne });
  assert.ok(r.conflicted, 'conflicted 반환');
  assert.equal(r.conflicted.task_id, 'A');
  assert.ok(r.stoppedReason && /충돌/.test(r.stoppedReason));
  assert.ok(!h.events.includes('run:B'), 'B 는 투입 안 됨(정지)');
  assert.ok(!h.events.includes('run:C'), 'C 는 투입 안 됨(정지)');
  assert.deepEqual(r.skipped.sort(), ['B', 'C']);
});

test('pool — deps: 의존 task 는 dep 머지 전까지 투입 안 됨', async () => {
  // B deps [A]. slots=2 여도 B 는 A 머지 후.
  const h = harness({ A: { size: 1 }, B: { size: 1, deps: ['A'] } }, { delays: { A: 30 } });
  const r = await runPipeline({ slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne });
  assert.ok(idx(h.events, 'run:B') > idx(h.events, 'merge:A'), 'B 는 A 머지(done) 후 투입');
  assert.equal(r.outcomes.length, 2);
});

test('pool — rejected dep 는 의존 task 를 영구 blocked(skipped) 로 남김', async () => {
  // A 머지 reject → B(deps [A]) 는 done 아닌 A 위에 못 쌓음 → skipped.
  const h = harness(
    { A: { size: 1 }, B: { size: 1, deps: ['A'] } },
    { mergeResults: { A: 'rejected' } },
  );
  const r = await runPipeline({ slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne });
  assert.ok(!h.events.includes('run:B'), 'rejected dep 위의 task 는 투입 안 됨');
  assert.deepEqual(r.skipped, ['B']);
});

test('pool — admit path_overlap(레이스) 는 재큐 후 성공', async () => {
  // admit 이 첫 호출만 path_overlap 반환(레이스 흉내) → 재큐 → 재시도 성공.
  const h = harness({ A: { size: 1 } });
  let calls = 0;
  const admit = async (id) => {
    calls += 1;
    if (calls === 1) return { ok: false, reason: 'path_overlap' };
    return { ok: true, task: { task_id: id } };
  };
  const r = await runPipeline({ slots: 1, tasks: h.tasks, admit, runTask: h.runTask, mergeOne: h.mergeOne });
  assert.equal(r.outcomes.length, 1);
  assert.equal(r.outcomes[0].status, 'done');
  assert.ok(calls >= 2, '재큐 후 admit 재호출');
});

test('pool — 데모 모드(mergeOne 없음): 워커 done 이 곧 done, deps 정상 해소', async () => {
  const h = harness({ A: { size: 1 }, B: { size: 1, deps: ['A'] } }, { delays: { A: 20 } });
  const r = await runPipeline({ slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: null });
  assert.equal(r.outcomes.length, 2);
  assert.equal(r.merges.length, 0);
  assert.ok(idx(h.events, 'run:B') > idx(h.events, 'done:A'), 'mergeOne 없어도 dep 해소');
});
