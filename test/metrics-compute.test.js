'use strict';

// pact metrics — compute.js 순수함수 테스트 (RED→GREEN)
// 입력은 "collected" 데이터(IO 없음). batch-builder 순수함수 재사용 검증 포함.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeOutcomes,
  scopeDrift,
  couplingChokepoints,
  idealWavesAndTax,
  mergeStats,
  totalCost,
} = require('../scripts/metrics/compute.js');

// ── computeOutcomes ─────────────────────────────────────────────
test('computeOutcomes: done(clean) / salvaged / blocked / failed 분류 + rates', () => {
  const runs = [
    { task_id: 'A', status: 'done', clean_for_merge: true, files_changed: ['src/a.ts'] },
    { task_id: 'B', status: 'done', clean_for_merge: true, files_changed: ['src/b.ts'] }, // salvaged
    { task_id: 'C', status: 'done', clean_for_merge: false, files_changed: ['src/c.ts'] }, // not clean → salvaged
    { task_id: 'D', status: 'blocked' },
    { task_id: 'E', status: 'failed' },
  ];
  const salvageTouches = { B: ['src/b.ts'] }; // B는 main에서 손봄

  const o = computeOutcomes(runs, salvageTouches);
  assert.equal(o.done_clean, 1, 'A만 clean');
  assert.equal(o.done_salvaged, 2, 'B(salvage) + C(clean=false)');
  assert.equal(o.blocked, 1);
  assert.equal(o.failed, 1);
  assert.equal(o.total, 5);
  assert.equal(o.rates.completion_by_worker, 1 / 5);
  assert.equal(o.rates.salvage, 2 / 5);
  assert.equal(o.rates.unfinished, 2 / 5);
});

// ── scopeDrift ──────────────────────────────────────────────────
test('scopeDrift: allowed_paths 밖 files_changed만 (pathsOverlap 재사용)', () => {
  const runs = [
    { task_id: 'A', files_changed: ['src/api/x.ts', 'docs/y.md'] },
    { task_id: 'B', files_changed: ['src/b.ts'] },
  ];
  const tasksById = {
    A: { id: 'A', allowed_paths: ['src/api/**'] },
    B: { id: 'B', allowed_paths: ['src/**'] },
  };
  const drift = scopeDrift(runs, tasksById);
  assert.equal(drift.length, 1, 'A만 드리프트');
  assert.equal(drift[0].task, 'A');
  assert.deepEqual(drift[0].files, ['docs/y.md']);
});

test('scopeDrift: task 정의 없거나 files_changed 없으면 graceful', () => {
  const drift = scopeDrift(
    [{ task_id: 'A' }, { task_id: 'Z', files_changed: ['x'] }],
    { A: { allowed_paths: ['**'] } },
  );
  assert.deepEqual(drift, [], '빈 변경/미정의 task는 드리프트 없음');
});

// ── couplingChokepoints ─────────────────────────────────────────
test('couplingChokepoints: 가장 많은 task에 등장한 path 랭킹', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['src/types.ts', 'src/a.ts'] },
    { id: 'B', allowed_paths: ['src/types.ts', 'src/b.ts'] },
    { id: 'C', allowed_paths: ['src/types.ts'] },
  ];
  const top = couplingChokepoints(tasks, [], 10);
  assert.equal(top[0].path, 'src/types.ts');
  assert.equal(top[0].tasks, 3);
});

// ── idealWavesAndTax ────────────────────────────────────────────
test('idealWavesAndTax: 공유파일 task는 다른 wave로(직렬화), tax 잡힘', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['src/types.ts', 'src/a.ts'], dependencies: [], status: 'done' },
    { id: 'B', allowed_paths: ['src/types.ts', 'src/b.ts'], dependencies: [], status: 'done' },
  ];
  const r = idealWavesAndTax(tasks);
  assert.equal(r.ideal_waves, 2, 'types.ts 공유 → 2 wave');
  assert.equal(r.width_max, 1);
  assert.equal(r.serialization_tax, 1, '독립인데 충돌하는 쌍 1');
});

test('idealWavesAndTax: 겹치지 않으면 한 wave, tax 0', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['src/a.ts'], dependencies: [], status: 'done' },
    { id: 'B', allowed_paths: ['src/b.ts'], dependencies: [], status: 'done' },
  ];
  const r = idealWavesAndTax(tasks);
  assert.equal(r.ideal_waves, 1);
  assert.equal(r.width_max, 2);
  assert.equal(r.serialization_tax, 0);
});

// ── mergeStats ──────────────────────────────────────────────────
test('mergeStats: 충돌률 = conflicted≠null / 전체 머지', () => {
  const mergeResults = [
    { merged: ['A', 'B'], conflicted: null },
    { merged: ['C'], conflicted: { task_id: 'C' } },
    { merged: [], conflicted: null },
  ];
  const m = mergeStats(mergeResults);
  assert.equal(m.total, 3, 'A,B,C');
  assert.equal(m.conflicts, 1);
  assert.equal(m.conflict_rate, 1 / 3);
});

// ── totalCost ───────────────────────────────────────────────────
test('totalCost: tokens_used 합 (없으면 0)', () => {
  const runs = [
    { task_id: 'A', tokens_used: 1000 },
    { task_id: 'B', tokens_used: 500 },
    { task_id: 'C' },
  ];
  assert.equal(totalCost(runs), 1500);
});
