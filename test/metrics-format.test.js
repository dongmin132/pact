'use strict';

// pact metrics — format.js (buildScorecard / readout) 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScorecard, formatHuman, formatJson, formatScorecard } = require('../scripts/metrics/format.js');

function sampleCollected() {
  const tasks = [
    { id: 'A', allowed_paths: ['src/**'], dependencies: [] },
    { id: 'B', allowed_paths: ['src/b/**'], dependencies: [] },
  ];
  return {
    projectDir: '/x/brewdy',
    runs: [
      { task_id: 'A', status: 'done', clean_for_merge: true, files_changed: ['src/a.ts', 'docs/z.md'], tokens_used: 100, completed_at: '2026-05-01T00:00:00Z' },
      { task_id: 'B', status: 'blocked' },
    ],
    tasks,
    tasksById: Object.fromEntries(tasks.map((t) => [t.id, t])),
    mergeResults: [{ merged: ['A'], conflicted: null }],
    verifyLogs: [],
    salvageTouches: {},
    calendar: { first: '2026-05-01', last: '2026-05-01', active_days: 1, elapsed_days: 1 },
  };
}

test('buildScorecard: 핵심 구조·수치', () => {
  const card = buildScorecard(sampleCollected(), { generatedAt: '2026-06-23T00:00:00Z' });
  assert.equal(card.project, 'brewdy');
  assert.equal(card.totals.tasks, 2);
  assert.equal(card.worker_outcomes.done_clean, 1);
  assert.equal(card.worker_outcomes.blocked, 1);
  assert.equal(card.rates.not_done_for_you, 0.5, '(0 salvage + 1 blocked)/2');
  assert.equal(card.merge.total, 1);
  assert.equal(card.cost_tokens, 100);
  // 스코프 드리프트 재계산: A 가 docs/z.md (allowed src/** 밖) 건드림
  assert.equal(card.scope_drift.length, 1);
  assert.deepEqual(card.scope_drift[0].files, ['docs/z.md']);
  // 신뢰도 태그 존재
  assert.equal(card.confidence.salvage, 'heuristic');
});

test('buildScorecard: gitMerges 있으면 우선 사용 (merge-result fallback 아님)', () => {
  const c = sampleCollected();
  c.gitMerges = { mergedTaskIds: ['A', 'B', 'C'], conflictTaskIds: ['B'] };
  const card = buildScorecard(c, { generatedAt: '2026-06-23T00:00:00Z' });
  assert.equal(card.merge.total, 3, 'git 머지 3');
  assert.equal(card.merge.conflicts, 1);
  assert.equal(card.merge.source, 'git');
});

test('formatHuman: 핵심 라벨 포함', () => {
  const card = buildScorecard(sampleCollected(), { generatedAt: '2026-06-23T00:00:00Z' });
  const out = formatHuman(card);
  assert.match(out, /pact metrics — brewdy/);
  assert.match(out, /워커 결말/);
  assert.match(out, /pact가 대신 안 해준 일/);
  assert.match(out, /커플링 병목/);
});

test('formatScorecard: 공개 카드 핵심 라벨 + self-reported 정직 라벨', () => {
  const card = buildScorecard(sampleCollected(), { generatedAt: '2026-06-23T00:00:00Z' });
  const sc = formatScorecard(card);
  assert.match(sc, /pact scorecard — brewdy/);
  assert.match(sc, /워커 자력완료율/);
  assert.match(sc, /충돌/);
  assert.match(sc, /self-reported/, '독립 벤치 아님을 정직하게 라벨');
  assert.doesNotMatch(sc, /병렬 폭/, '부풀린 ideal-width는 공개 카드에서 제외');
});

test('formatJson: 파싱 가능 + generated_at 유지', () => {
  const card = buildScorecard(sampleCollected(), { generatedAt: '2026-06-23T00:00:00Z' });
  const parsed = JSON.parse(formatJson(card));
  assert.equal(parsed.generated_at, '2026-06-23T00:00:00Z');
});

// ── IMP-1: driver-events 로 유효 병렬폭 measured 승격 ────────────
test('buildScorecard: driverEvents 있으면 effective/actual_width measured 승격', () => {
  const c = sampleCollected();
  c.driverEvents = [
    { ts: 0, type: 'dispatch', task_id: 'A' },
    { ts: 0, type: 'dispatch', task_id: 'B' },
    { ts: 100, type: 'settle', task_id: 'A', status: 'done' },
    { ts: 100, type: 'settle', task_id: 'B', status: 'done' },
  ];
  const card = buildScorecard(c, { generatedAt: '2026-06-23T00:00:00Z' });
  assert.equal(card.parallelism.effective, 2, '완전 겹침 2개 = 2.0');
  assert.equal(card.parallelism.actual_width, 2);
  assert.equal(card.confidence.effective_parallelism, 'measured');
  assert.equal(card.confidence.actual_width, 'measured');
  assert.ok(!card.deferred_to_event_emission.includes('effective_parallelism'), 'deferred 에서 제거');
  assert.ok(!card.deferred_to_event_emission.includes('actual_width'));
  assert.ok(card.deferred_to_event_emission.includes('time_attribution'), '나머지는 여전히 deferred');
  const human = formatHuman(card);
  assert.match(human, /유효 병렬폭\(실측\)/);
  assert.match(human, /measured/);
});

test('buildScorecard: driverEvents 부재 → 기존 출력 100% 불변(하위호환)', () => {
  const card = buildScorecard(sampleCollected(), { generatedAt: '2026-06-23T00:00:00Z' });
  assert.equal(card.parallelism.effective, undefined, '측정 필드 미추가');
  assert.equal(card.parallelism.actual_width, undefined);
  assert.equal(card.confidence.effective_parallelism, undefined);
  assert.ok(card.deferred_to_event_emission.includes('effective_parallelism'), '여전히 deferred');
  assert.ok(card.deferred_to_event_emission.includes('actual_width'));
  const human = formatHuman(card);
  assert.doesNotMatch(human, /유효 병렬폭\(실측\)/);
});
