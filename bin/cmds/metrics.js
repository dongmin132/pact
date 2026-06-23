'use strict';

// pact metrics — 사이클 계측기 CLI (결정적·0토큰·read-only)
//
// 대상 프로젝트의 .pact/ + tasks/*.md + read-only git 을 읽어 "사이클 스코어카드"
// 를 낸다. 대상엔 아무것도 안 쓴다(출력은 stdout, 또는 --out 으로 임의 경로).
//
// 헤드라인 = salvage rate("pact가 대신 안 해준 일") — 지금 pact 가 못 보는 지표.

const fs = require('fs');
const path = require('path');
const { collectAll, computeCalendar } = require('../../scripts/metrics/collect.js');
const { buildScorecard, formatHuman, formatJson } = require('../../scripts/metrics/format.js');

const HELP = [
  'pact metrics — 사이클 계측기 (read-only)',
  '',
  '대상 프로젝트의 .pact/ + tasks/*.md + read-only git → 스코어카드.',
  '대상엔 아무것도 안 씀. 출력은 stdout(또는 --out).',
  '',
  '사용법: pact metrics [옵션]',
  '  --project <path>   대상 프로젝트 (기본: 현재 디렉토리)',
  '  --json             기계용 JSON',
  '  --cycle <prefix>   task-family 드릴다운 (예: --cycle CLEANUP)',
  '  --task <ID>        단일 task 상세 (예: --task STORE-102)',
  '  --out <file>       JSON 을 파일로 (대상 아닌 임의 경로)',
  '  --help, -h         이 도움말',
  '',
  '예) pact metrics --project ../brewdy',
  '    pact metrics --project ../brewdy --json --out /tmp/brewdy-metrics.json',
  '    pact metrics --cycle CLEANUP',
  '',
  '종료코드: 0 정상 / 2 .pact 없음(대상이 pact 프로젝트 아님)',
  '',
].join('\n');

function parseArgs(args) {
  const o = { project: process.cwd(), json: false, cycle: null, task: null, out: null, help: false };
  const val = (a, i, key, len) => (a.includes('=') ? a.slice(len) : args[++i.v]);
  for (const ctr = { v: 0 }; ctr.v < args.length; ctr.v++) {
    const a = args[ctr.v];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--project')) o.project = val(a, ctr, 'project', 10);
    else if (a.startsWith('--cycle')) o.cycle = val(a, ctr, 'cycle', 8);
    else if (a.startsWith('--task')) o.task = val(a, ctr, 'task', 7);
    else if (a.startsWith('--out')) o.out = val(a, ctr, 'out', 6);
  }
  return o;
}

// task_id prefix 로 부분집합 (runs·tasks·tasksById·salvage), calendar 재계산.
function subset(collected, predicate) {
  const runs = collected.runs.filter((r) => predicate(r.task_id));
  const tasks = collected.tasks.filter((t) => predicate(t.id));
  const tasksById = {};
  for (const t of tasks) tasksById[t.id] = t;
  const salvageTouches = {};
  for (const id of Object.keys(collected.salvageTouches)) if (predicate(id)) salvageTouches[id] = collected.salvageTouches[id];
  const mergeResults = collected.mergeResults
    .map((m) => ({ ...m, merged: (m.merged || []).filter((x) => predicate(typeof x === 'string' ? x : x && x.task_id)) }))
    .filter((m) => (m.merged || []).length || m.conflicted);
  const gitMerges = collected.gitMerges && {
    mergedTaskIds: collected.gitMerges.mergedTaskIds.filter(predicate),
    conflictTaskIds: collected.gitMerges.conflictTaskIds.filter(predicate),
  };
  return { ...collected, runs, tasks, tasksById, salvageTouches, mergeResults, gitMerges, calendar: computeCalendar(runs) };
}

module.exports = function metrics(args) {
  const o = parseArgs(args);
  if (o.help) { process.stdout.write(HELP); return; }

  const projectDir = path.resolve(o.project);
  const collected = collectAll(projectDir);
  if (!collected.hasPact) {
    process.stderr.write(`pact metrics: ${projectDir} 에 .pact/ 없음 — pact 프로젝트가 맞나요?\n`);
    process.exitCode = 2;
    return;
  }

  let c = collected;
  if (o.cycle) c = subset(c, (id) => typeof id === 'string' && id.startsWith(o.cycle));
  if (o.task) c = subset(c, (id) => id === o.task);

  const card = buildScorecard(c);

  if (o.out) {
    fs.writeFileSync(o.out, formatJson(card));
    process.stdout.write(`JSON → ${o.out}\n`);
    return;
  }
  process.stdout.write((o.json ? formatJson(card) : formatHuman(card)) + '\n');
};
