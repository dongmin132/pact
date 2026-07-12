'use strict';

// pact metrics — compute.js
// 지표 계산 순수함수 모음. IO 없음(입력은 collect.js가 만든 plain 데이터).
// batch-builder.js 의 검증된 순수함수를 재사용한다(글롭 매칭·배치 계획).

const { buildBatches, pathsOverlap, depTaskId } = require('../../batch-builder.js');

// ── 워커 결말 분류 ──────────────────────────────────────────────
// done(clean)   = status=done · clean_for_merge≠false · main salvage 흔적 없음
// done(salvaged)= status=done 이지만 사람이 손봄(salvageTouches) 또는 clean_for_merge=false
// blocked/failed= 그대로 (status 없거나 그 외는 failed 취급)
function computeOutcomes(runs = [], salvageTouches = {}) {
  let done_clean = 0, done_salvaged = 0, blocked = 0, failed = 0;
  for (const r of runs) {
    if (r.status === 'done') {
      const salvaged =
        (salvageTouches[r.task_id] && salvageTouches[r.task_id].length > 0) ||
        r.clean_for_merge === false;
      if (salvaged) done_salvaged++;
      else done_clean++;
    } else if (r.status === 'blocked') {
      blocked++;
    } else {
      failed++;
    }
  }
  const total = runs.length;
  const rate = (n) => (total ? n / total : 0);
  return {
    done_clean, done_salvaged, blocked, failed, total,
    rates: {
      completion_by_worker: rate(done_clean),
      salvage: rate(done_salvaged),
      unfinished: rate(blocked + failed),
    },
  };
}

// ── 스코프 드리프트 (재계산) ────────────────────────────────────
// framework 자체 files_attempted_outside_scope 무시. files_changed 중
// allowed_paths 글롭에 안 걸리는 것만. pathsOverlap([file], allowed) 로 매칭.
function scopeDrift(runs = [], tasksById = {}) {
  const out = [];
  for (const r of runs) {
    const files = r.files_changed || [];
    const task = tasksById[r.task_id];
    if (!task || files.length === 0) continue;
    const allowed = task.allowed_paths || [];
    const outside = files.filter((f) => !pathsOverlap([f], allowed));
    if (outside.length) out.push({ task: r.task_id, files: outside });
  }
  return out;
}

// ── 커플링 병목 ────────────────────────────────────────────────
// path별로 그 path를 (allowed_paths 선언 또는 실제 files_changed 로) 건드린
// 고유 task 수. 많이 겹친 순.
function couplingChokepoints(tasks = [], runs = [], topN = 10) {
  const taskPaths = new Map(); // taskId -> Set(path)
  const add = (id, p) => {
    if (!id || !p) return;
    if (!taskPaths.has(id)) taskPaths.set(id, new Set());
    taskPaths.get(id).add(p);
  };
  for (const t of tasks) for (const p of t.allowed_paths || []) add(t.id, p);
  for (const r of runs) for (const p of r.files_changed || []) add(r.task_id, p);

  const count = new Map();
  for (const set of taskPaths.values()) {
    for (const p of set) count.set(p, (count.get(p) || 0) + 1);
  }
  return [...count.entries()]
    .map(([p, n]) => ({ path: p, tasks: n }))
    .sort((a, b) => b.tasks - a.tasks || a.path.localeCompare(b.path))
    .slice(0, topN);
}

// ── 이상 wave 폭 + 직렬화 세금 ──────────────────────────────────
// 회고이므로 status를 todo로 정규화해 buildBatches 가 "처음부터 계획한다면"
// 의 wave 구조를 산출. width 는 cap 없이(이상치). serialization_tax 는
// 의존 독립인데 path 충돌하는 쌍 수(= 병렬 가능했는데 파일공유로 직렬화).
function idealWavesAndTax(tasks = []) {
  const norm = tasks.map((t) => ({
    id: t.id,
    title: t.title || t.id,
    allowed_paths: t.allowed_paths || [],
    dependencies: t.dependencies || [],
    status: 'todo',
    done_criteria: t.done_criteria && t.done_criteria.length ? t.done_criteria : ['x'],
    tdd: t.tdd === true,
  }));

  let ideal_waves = 0, width_max = 0, width_avg = 0;
  const plan = buildBatches(norm, { maxBatchSize: 9999 });
  if (plan && Array.isArray(plan.batches) && plan.batches.length) {
    const sizes = plan.batches.map((b) => b.length);
    ideal_waves = sizes.length;
    width_max = Math.max(...sizes);
    width_avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  }

  let serialization_tax = 0;
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j];
      const depRelated =
        (a.dependencies || []).some((d) => depTaskId(d) === b.id) ||
        (b.dependencies || []).some((d) => depTaskId(d) === a.id);
      if (depRelated) continue;
      if (pathsOverlap(a.allowed_paths || [], b.allowed_paths || [])) serialization_tax++;
    }
  }
  return { ideal_waves, width_max, width_avg, serialization_tax };
}

// ── 머지 통계 ──────────────────────────────────────────────────
function mergeStats(mergeResults = []) {
  let total = 0, conflicts = 0;
  for (const m of mergeResults) {
    total += (m.merged || []).length;
    if (m.conflicted) conflicts++;
  }
  return { total, conflicts, conflict_rate: total ? conflicts / total : 0 };
}

// ── 비용 ───────────────────────────────────────────────────────
function totalCost(runs = []) {
  return runs.reduce((sum, r) => sum + (Number(r.tokens_used) || 0), 0);
}

// ── (IMP-1) 파이프라인 타이밍: 유효 병렬폭 + 실측 동시폭 ──────────
// driver-events.jsonl 의 dispatch/settle 이벤트로 task별 in-flight 구간 [dispatch, settle]
// 를 복원해 두 실측 지표를 낸다 — 지금까지 "실측 duration 소스 부재"로 deferred 였던 것:
//   effective_parallelism = Σ(task_span) / wall_span   (완전 겹침 2개 = 2.0 = makespan 압축배)
//   actual_width          = 시간축 동시 in-flight 최대 (구간 스윕)
// ts 는 epoch ms(number, pool.mjs) 또는 ISO(string, driver append) 둘 다 허용.
// requeue 는 admit 레이스로 재큐된 것 → 직전 dispatch 를 폐기(실제 실행 구간만 계상).
// 이벤트가 없으면(레거시 배리어 런·이벤트 파일 부재) null 반환 → format 이 기존 출력을 100%
// 유지한다(하위호환). 순수함수 — IO 없음.
function pipelineTiming(events = []) {
  const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
  const dispatched = new Map(); // task_id -> 최근 dispatch ms
  const intervals = [];         // [start, end]
  for (const e of events) {
    if (!e || !e.type) continue;
    const ms = toMs(e.ts);
    if (!Number.isFinite(ms)) continue;
    if (e.type === 'dispatch') dispatched.set(e.task_id, ms);
    else if (e.type === 'requeue') dispatched.delete(e.task_id); // 재큐 = 미실행 → 폐기
    else if (e.type === 'settle') {
      const start = dispatched.get(e.task_id);
      if (start != null) { intervals.push([start, ms]); dispatched.delete(e.task_id); }
    }
  }
  if (!intervals.length) return null;

  let busy = 0, minStart = Infinity, maxEnd = -Infinity;
  for (const [s, en] of intervals) {
    busy += Math.max(0, en - s);
    if (s < minStart) minStart = s;
    if (en > maxEnd) maxEnd = en;
  }
  const wall = maxEnd - minStart;
  if (wall <= 0) { // 모든 구간이 사실상 동시각(0폭) — 스윕 대신 겹침수로 직접 산출.
    return { tasks: intervals.length, effective_parallelism: intervals.length, actual_width: intervals.length, wall_ms: 0, busy_ms: busy };
  }
  // actual_width: 구간 시작 +1, 끝 -1 스윕. 동일 ts 는 끝(-1)을 시작(+1)보다 먼저 처리해
  // 인접(end==start) 구간이 겹침으로 세지지 않게 한다.
  const pts = [];
  for (const [s, en] of intervals) { pts.push([s, 1]); pts.push([en, -1]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, actualWidth = 0;
  for (const [, d] of pts) { cur += d; if (cur > actualWidth) actualWidth = cur; }

  return {
    tasks: intervals.length,
    effective_parallelism: busy / wall,
    actual_width: actualWidth,
    wall_ms: wall,
    busy_ms: busy,
  };
}

module.exports = {
  computeOutcomes,
  scopeDrift,
  couplingChokepoints,
  idealWavesAndTax,
  mergeStats,
  totalCost,
  pipelineTiming,
};
