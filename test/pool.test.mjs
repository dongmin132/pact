'use strict';

// K-슬롯 워커 풀 스케줄러 단위 테스트 (P2-2 · SPD-1 + SPD-3).
// 순수 스케줄러라 admit/runTask/mergeOne/overlaps 를 mock 으로 주입해 결정적으로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, isRateLimited, createDownshiftController } from '../scripts/headless-driver/pool.mjs';

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

test('pool — dispatch/settle 이벤트에 ts 포함 (IMP-1 타이밍 소스)', async () => {
  const h = harness({ A: { size: 1 } });
  const evs = [];
  const r = await runPipeline({
    slots: 1, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne,
    onEvent: (e) => evs.push(e),
  });
  assert.equal(r.outcomes.length, 1);
  const disp = evs.find((e) => e.type === 'dispatch' && e.id === 'A');
  const settle = evs.find((e) => e.type === 'settle' && e.id === 'A');
  assert.ok(disp && typeof disp.ts === 'number', 'dispatch 에 ts(number)');
  assert.ok(settle && typeof settle.ts === 'number', 'settle 에 ts(number)');
  assert.ok(settle.ts >= disp.ts, 'settle ts ≥ dispatch ts');
});

test('pool — 데모 모드(mergeOne 없음): 워커 done 이 곧 done, deps 정상 해소', async () => {
  const h = harness({ A: { size: 1 }, B: { size: 1, deps: ['A'] } }, { delays: { A: 20 } });
  const r = await runPipeline({ slots: 2, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: null });
  assert.equal(r.outcomes.length, 2);
  assert.equal(r.merges.length, 0);
  assert.ok(idx(h.events, 'run:B') > idx(h.events, 'done:A'), 'mergeOne 없어도 dep 해소');
});

// ============================================================================
// IMP-5 최소형: rate-limit 신호 기반 반응형 다운시프트
// ============================================================================

test('isRateLimited — 429/rate_limit/overloaded/529 를 subtype·reason·message 에서 판별', () => {
  assert.equal(isRateLimited({ reason: 'error:429 Too Many Requests' }), true, '429');
  assert.equal(isRateLimited({ subtype: 'rate_limit_error' }), true, 'rate_limit subtype');
  assert.equal(isRateLimited({ reason: 'overloaded_error: server busy' }), true, 'overloaded');
  assert.equal(isRateLimited({ reason: 'error:HTTP 529 overloaded' }), true, '529(anthropic overloaded)');
  assert.equal(isRateLimited({ message: 'rate-limit hit, retry later' }), true, 'message 필드');
  assert.equal(isRateLimited({ rate_limited: true }), true, '명시 boolean 신호');
  assert.equal(isRateLimited({ error: 'Too Many Requests' }), true, 'error 필드');
});

test('isRateLimited — 일반 오류/정상 완료엔 false (오탐 없음)', () => {
  assert.equal(isRateLimited({ status: 'done' }), false, '정상 완료');
  assert.equal(isRateLimited({ reason: 'error_max_turns' }), false, '턴 소진');
  assert.equal(isRateLimited({ reason: 'error:TypeError x is not a function' }), false, '일반 예외');
  assert.equal(isRateLimited({ reason: 'timeout' }), false, '타임아웃');
  assert.equal(isRateLimited(null), false, 'null 방어');
  assert.equal(isRateLimited(undefined), false, 'undefined 방어');
});

test('downshift 컨트롤러 — rate-limit settle 시 목표 1 감소, clean streak 리셋', () => {
  const c = createDownshiftController({ max: 5 });
  assert.equal(c.target, 5, '초기 목표 = max');
  const info = c.observe({ reason: 'error:429' });
  assert.equal(info.changed, true);
  assert.equal(info.direction, 'down');
  assert.equal(info.from, 5);
  assert.equal(info.to, 4);
  assert.equal(c.target, 4, '목표 5→4');
});

test('downshift 컨트롤러 — 하한 1 고정: 반복 rate-limit 도 1 밑으로 안 내려감', () => {
  const c = createDownshiftController({ max: 3, floor: 1 });
  for (let i = 0; i < 10; i++) c.observe({ reason: 'overloaded' });
  assert.equal(c.target, 1, '하한 1 클램프');
  // 하한 도달 후 추가 rate-limit 은 changed=false
  const info = c.observe({ reason: '429' });
  assert.equal(info.changed, false);
  assert.equal(c.target, 1);
});

test('downshift 컨트롤러 — 연속 N회 클린 settle 시 1 복원(상한 = max)', () => {
  const c = createDownshiftController({ max: 4, recoverAfter: 3 });
  c.observe({ reason: '429' });          // 4→3
  c.observe({ reason: '429' });          // 3→2
  assert.equal(c.target, 2);
  // 클린 2회로는 복원 안 됨(N=3)
  assert.equal(c.observe({ status: 'done' }).changed, false);
  assert.equal(c.observe({ status: 'done' }).changed, false);
  assert.equal(c.target, 2, '2회로는 복원 X');
  // 3회째 클린 → 1 복원
  const up = c.observe({ status: 'done' });
  assert.equal(up.changed, true);
  assert.equal(up.direction, 'up');
  assert.equal(c.target, 3, '2→3 복원');
});

test('downshift 컨트롤러 — 상한(max) 초과 복원 없음: 신호 없으면 target 불변', () => {
  const c = createDownshiftController({ max: 3, recoverAfter: 2 });
  for (let i = 0; i < 20; i++) assert.equal(c.observe({ status: 'done' }).changed, false);
  assert.equal(c.target, 3, 'max 위로 자동 상향 없음');
});

test('downshift 컨트롤러 — 일반 오류엔 무반응(다운시프트 X), 진동 방지: 다운시프트가 클린 streak 리셋', () => {
  const c = createDownshiftController({ max: 5, recoverAfter: 3 });
  // 일반 오류(비 rate-limit)는 다운시프트 안 함
  assert.equal(c.observe({ status: 'escalated', reason: 'error_max_turns' }).direction, null);
  assert.equal(c.target, 5, '일반 오류로는 안 내려감');
  // 다운시프트 후 클린 2회 쌓다가 rate-limit 재발 → streak 리셋(급복원 방지)
  c.observe({ reason: '429' });          // 5→4, streak=0
  c.observe({ status: 'done' });         // streak=1
  c.observe({ status: 'done' });         // streak=2
  c.observe({ reason: '429' });          // 4→3, streak 리셋
  c.observe({ status: 'done' });         // streak=1 (이전 2회 무효)
  c.observe({ status: 'done' });         // streak=2
  assert.equal(c.target, 3, '리셋 탓에 아직 복원 전');
  assert.equal(c.observe({ status: 'done' }).direction, 'up'); // streak=3 → 복원
  assert.equal(c.target, 4);
});

test('pool — downshift 옵션 없으면 기존 동작 불변(target=slots, 이벤트 없음)', async () => {
  const h = harness({ A: { size: 1 }, B: { size: 1 }, C: { size: 1 } });
  const evs = [];
  const r = await runPipeline({
    slots: 3, tasks: h.tasks, admit: h.admit, runTask: h.runTask, mergeOne: h.mergeOne,
    onEvent: (e) => evs.push(e),
  });
  assert.equal(r.outcomes.length, 3);
  assert.ok(!evs.some((e) => e.type === 'downshift'), 'downshift 미설정 → downshift 이벤트 없음');
});

test('pool — rate-limit settle 시 다운시프트: 이후 dispatch 의 in-flight 상한이 줄어든다', async () => {
  // slots=3. 가장 큰 R 이 먼저 투입돼 즉시 rate-limit 으로 settle → 목표 3→2.
  // 이후 dispatch 되는 task 는 in-flight 가 2 를 넘지 않는다(회복 없음: recoverAfter 큼).
  const tasks = new Map([
    ['R', { deps: [], allowed_paths: [], size: 100 }],   // 최대 → 최우선 dispatch
    ['A', { deps: [], allowed_paths: [], size: 5 }],
    ['B', { deps: [], allowed_paths: [], size: 4 }],
    ['C', { deps: [], allowed_paths: [], size: 3 }],
    ['D', { deps: [], allowed_paths: [], size: 2 }],
    ['E', { deps: [], allowed_paths: [], size: 1 }],
  ]);
  const admit = async (id) => ({ ok: true, task: { task_id: id } });
  const runTask = async (task) => {
    if (task.task_id === 'R') { await sleep(2); return { task_id: 'R', status: 'escalated', reason: 'error:429 Too Many Requests' }; }
    await sleep(40);
    return { task_id: task.task_id, status: 'done' };
  };
  const evs = [];
  const r = await runPipeline({
    slots: 3, tasks, admit, runTask, mergeOne: null,
    downshift: { recoverAfter: 99, floor: 1 },
    onEvent: (e) => evs.push(e),
  });
  assert.equal(r.outcomes.length, 6);
  const ds = evs.find((e) => e.type === 'downshift');
  assert.ok(ds, 'downshift 이벤트 발화');
  assert.equal(ds.direction, 'down');
  assert.equal(ds.from, 3);
  assert.equal(ds.to, 2);
  // 다운시프트 이후의 dispatch 는 in-flight ≤ 2
  const dsIdx = evs.indexOf(ds);
  const laterDispatch = evs.filter((e, i) => i > dsIdx && e.type === 'dispatch');
  assert.ok(laterDispatch.length >= 1, '다운시프트 후에도 남은 task dispatch 존재');
  for (const d of laterDispatch) {
    assert.ok(d.in_flight.length <= 2, `다운시프트 후 dispatch in-flight ≤ 2 (실제 ${d.in_flight.length})`);
  }
});
