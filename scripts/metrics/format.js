'use strict';

// pact metrics — format.js
// collected → 스코어카드 객체(buildScorecard) → 사람용 readout / JSON.
// MVP 정직성: 실측 duration 이 필요한 지표(time_attribution·effective parallelism·
// actual width)는 가짜 숫자 대신 "B 이벤트방출 후" 로 미루고, 신뢰 지표만 낸다.

const path = require('path');
const {
  computeOutcomes, scopeDrift, couplingChokepoints,
  idealWavesAndTax, mergeStats, totalCost, pipelineTiming,
} = require('./compute.js');

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${Math.round(x * 100)}%`;

// 머지 수: git 머지커밋(정확) 우선, 없으면 merge-result.json(현재만) fallback.
function mergeFrom(c) {
  const g = c.gitMerges;
  if (g && Array.isArray(g.mergedTaskIds) && g.mergedTaskIds.length) {
    const total = g.mergedTaskIds.length;
    const conflicts = (g.conflictTaskIds || []).length;
    return { total, conflicts, conflict_rate: total ? conflicts / total : 0, source: 'git' };
  }
  return { ...mergeStats(c.mergeResults), source: 'merge-result' };
}

function buildScorecard(c, opt = {}) {
  const o = computeOutcomes(c.runs, c.salvageTouches);
  const merge = mergeFrom(c);
  const waves = idealWavesAndTax(c.tasks);
  const card = {
    project: path.basename(c.projectDir || '.'),
    generated_at: opt.generatedAt || new Date().toISOString(),
    range: {
      first: c.calendar.first, last: c.calendar.last,
      active_days: c.calendar.active_days, elapsed_days: c.calendar.elapsed_days,
    },
    totals: { tasks: o.total, merges: merge.total },
    worker_outcomes: {
      done_clean: o.done_clean, done_salvaged: o.done_salvaged,
      blocked: o.blocked, failed: o.failed,
    },
    rates: {
      completion_by_worker: r3(o.rates.completion_by_worker),
      salvage: r3(o.rates.salvage),
      unfinished: r3(o.rates.unfinished),
      not_done_for_you: r3(o.rates.salvage + o.rates.unfinished),
    },
    parallelism: {
      ideal_waves: waves.ideal_waves, width_max: waves.width_max,
      width_avg: r2(waves.width_avg), serialization_tax: waves.serialization_tax,
    },
    coupling_chokepoints: couplingChokepoints(c.tasks, c.runs, 10),
    scope_drift: scopeDrift(c.runs, c.tasksById),
    merge: { total: merge.total, conflicts: merge.conflicts, conflict_rate: r3(merge.conflict_rate), source: merge.source },
    cost_tokens: totalCost(c.runs),
    confidence: { salvage: 'heuristic', scope_drift: 'reliable', parallelism_ideal: 'reliable', coupling: 'reliable' },
    deferred_to_event_emission: ['time_attribution', 'effective_parallelism', 'actual_width', 'verify_qa_tail'],
  };

  // (IMP-1) driver-events.jsonl 이 있으면 유효 병렬폭·실측 동시폭을 deferred → measured 로 승격.
  // 이벤트 부재 시엔 timing=null → card 를 그대로 반환해 기존 출력을 100% 유지(하위호환).
  const timing = pipelineTiming(c.driverEvents || []);
  if (timing) {
    card.parallelism.effective = r2(timing.effective_parallelism); // makespan 압축배(Σspan/wall)
    card.parallelism.actual_width = timing.actual_width;           // 시간축 동시 in-flight 최대
    card.parallelism.wall_seconds = r2(timing.wall_ms / 1000);
    card.confidence.effective_parallelism = 'measured';
    card.confidence.actual_width = 'measured';
    card.deferred_to_event_emission = card.deferred_to_event_emission
      .filter((x) => x !== 'effective_parallelism' && x !== 'actual_width');
  }
  return card;
}

function formatJson(card) {
  return JSON.stringify(card, null, 2);
}

function formatHuman(card) {
  const L = [];
  const o = card.worker_outcomes;
  const rg = card.range;
  L.push(`pact metrics — ${card.project}   (read-only)`);
  L.push(`${card.totals.tasks} tasks · ${card.totals.merges} merges` +
    (rg.first ? ` · ${rg.first}→${rg.last}  (활성 ${rg.active_days}일 / 경과 ${rg.elapsed_days}일)` : ''));
  L.push('');

  L.push('🔧  워커 결말');
  L.push(`   done(clean) ${o.done_clean} · done(salvaged) ${o.done_salvaged} ⚠ · blocked ${o.blocked} · failed ${o.failed}`);
  L.push(`   ▶ pact가 대신 안 해준 일 = (salvaged+blocked+failed)/${card.totals.tasks} = ${pct(card.rates.not_done_for_you)}   🟡 salvage=heuristic`);
  L.push('');

  const p = card.parallelism;
  L.push('⚡  병렬성 (이상치 — 계획상)                                    ✅');
  L.push(`   ideal waves ${p.ideal_waves} · width 평균 ${p.width_avg}/최대 ${p.width_max} · 직렬화세금 ${p.serialization_tax}쌍`);
  // (IMP-1) 이벤트 실측이 있을 때만 measured 라인 추가 — 부재 시 기존 출력 불변.
  if (p.effective != null) L.push(`   유효 병렬폭(실측) ${p.effective}× · 실측 동시폭 ${p.actual_width} · wall ${p.wall_seconds}s   📊 measured`);
  L.push('');

  L.push('🔗  커플링 병목 (공유 top)                                      ✅');
  for (const ch of card.coupling_chokepoints.slice(0, 5)) {
    L.push(`   ${String(ch.tasks).padStart(3)}  ${ch.path}`);
  }
  L.push('');

  L.push(`🧭  스코프 드리프트 (재계산 — framework detector 무시)  ${card.scope_drift.length} task   ✅`);
  for (const d of card.scope_drift.slice(0, 6)) {
    L.push(`   ${d.task} → ${d.files.slice(0, 4).join(', ')}${d.files.length > 4 ? ' …' : ''}`);
  }
  L.push('');

  const m = card.merge;
  L.push(`🔀  머지 ${m.total} · 충돌 ${m.conflicts} (${pct(m.conflict_rate)})  ✅     💸 ${card.cost_tokens.toLocaleString()} tokens`);
  L.push('');
  L.push(`(B 이벤트방출 후 추가: ${card.deferred_to_event_emission.join(', ')})`);
  return L.join('\n');
}

// 공개용 스코어카드 — README 임베드 가능한 마크다운 카드. 정직: self-reported.
function formatScorecard(card) {
  const o = card.worker_outcomes;
  const r = card.rates;
  const rg = card.range;
  const top = card.coupling_chokepoints[0];
  const L = [];
  L.push(`## 🔬 pact scorecard — ${card.project}`);
  L.push('> pact로 병렬 빌드' + (rg.first ? ` · ${rg.first}→${rg.last} (활성 ${rg.active_days}일/경과 ${rg.elapsed_days}일)` : ''));
  L.push('');
  L.push('| 지표 | 값 |');
  L.push('|---|---|');
  L.push(`| 워커 자력완료율 | ${pct(r.completion_by_worker)} (clean ${o.done_clean}/${card.totals.tasks}) |`);
  L.push(`| 사람 salvage·미완율 | ${pct(r.not_done_for_you)} |`);
  L.push(`| 머지 task | ${card.merge.total} (충돌 ${pct(card.merge.conflict_rate)}) |`);
  if (top) L.push(`| 커플링 병목 #1 | \`${top.path}\` (${top.tasks} tasks) |`);
  L.push(`| 비용 | ${(card.cost_tokens / 1e6).toFixed(2)}M tokens |`);
  L.push('');
  L.push('<sub>generated by `pact metrics --scorecard` · read-only · 🤖 self-reported (독립 벤치 아님)</sub>');
  return L.join('\n');
}

module.exports = { buildScorecard, formatJson, formatHuman, formatScorecard };
