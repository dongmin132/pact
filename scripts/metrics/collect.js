'use strict';

// pact metrics — collect.js
// read-only 로더. 대상 프로젝트의 .pact/ + tasks/*.md + read-only git 을 읽어
// compute.js 가 먹는 plain "collected" 데이터로 만든다. 대상에 아무것도 안 쓴다.

const fs = require('fs');
const path = require('path');
const { parseTasks } = require('../parse-tasks.js');
const { git } = require('./git-ro.js');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// .pact/runs/<ID>/status.json → run 객체. status.json 부재 = failed(워커 미완).
function readRuns(pactDir) {
  const runsDir = path.join(pactDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const out = [];
  for (const id of fs.readdirSync(runsDir)) {
    const dir = path.join(runsDir, id);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const j = readJsonSafe(path.join(dir, 'status.json'));
    out.push({ ...(j || {}), task_id: id, status: (j && j.status) || 'failed' });
  }
  return out;
}

// 현재 merge-result.json + archive/*.json(머지 결과 형태만).
function readMergeResults(pactDir) {
  const out = [];
  const cur = readJsonSafe(path.join(pactDir, 'merge-result.json'));
  if (cur) out.push(cur);
  const arch = path.join(pactDir, 'archive');
  if (fs.existsSync(arch)) {
    for (const f of fs.readdirSync(arch)) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonSafe(path.join(arch, f));
      if (j && ('merged' in j || 'conflicted' in j)) out.push(j);
    }
  }
  return out;
}

// tasks/*.md frontmatter(yaml 블록) → task 객체 (allowed_paths·dependencies 포함).
function readTasks(projectDir) {
  const tdir = path.join(projectDir, 'tasks');
  const tasks = [];
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const { tasks: ts } = parseTasks(fs.readFileSync(path.join(tdir, f), 'utf8'));
        tasks.push(...ts);
      } catch { /* 깨진 파일 무시 */ }
    }
  }
  const byId = {};
  for (const t of tasks) byId[t.id] = t;
  return { tasks, byId };
}

function readVerifyLogs(pactDir) {
  if (!fs.existsSync(pactDir)) return [];
  return fs.readdirSync(pactDir)
    .filter((f) => /^verify-.*\.log$/.test(f))
    .map((f) => {
      const s = fs.statSync(path.join(pactDir, f));
      return { name: f, size: s.size, mtime: s.mtimeMs };
    });
}

// 🟡 heuristic: 히스토리에서 salvage/resume 언어 + task-id 언급 커밋 → done이 사람 손봄.
const SALVAGE_RE = /salvage|resume|grind|수동|복구|재개|이어서|hand[- ]?finish/i;
const TASKID_RE = /[A-Z]{2,}-\d+[a-z]?/g;
function detectSalvage(projectDir, runs) {
  const out = {};
  const ids = new Set(runs.map((r) => r.task_id));
  let log = '';
  try { log = git(projectDir, ['log', '--no-merges', '--format=%H%x09%s', '-n', '5000']); } catch { return out; }
  for (const line of log.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const hash = line.slice(0, tab);
    const subj = line.slice(tab + 1);
    if (!SALVAGE_RE.test(subj)) continue;
    for (const id of subj.match(TASKID_RE) || []) {
      if (ids.has(id)) (out[id] = out[id] || []).push(hash);
    }
  }
  return out;
}

// 머지 수는 merge-result.json(현재 1개)이 아니라 git 머지커밋에서 센다.
// brewdy 패턴: `pact: merge pact/<TASK> — …`. 충돌은 커밋 subject 휴리스틱.
function countMergesFromGit(projectDir) {
  let mergeLog = '';
  try { mergeLog = git(projectDir, ['log', '--merges', '--format=%s', '-n', '10000']); } catch { return null; }
  if (!mergeLog) return null;
  const taskOf = (s) => { const m = s.match(/[A-Z]{2,}-\d+[a-z]?/); return m ? m[0] : s.slice(0, 48); };
  const mergedTaskIds = [];
  for (const s of mergeLog.split('\n')) {
    if (!s || !/pact|[A-Z]{2,}-\d+/.test(s)) continue; // pact 머지만
    mergedTaskIds.push(taskOf(s));
  }
  let allLog = '';
  try { allLog = git(projectDir, ['log', '--format=%s', '-n', '20000']); } catch { /* noop */ }
  const conflictTaskIds = [];
  for (const s of allLog.split('\n')) {
    if (/conflict|충돌/i.test(s)) conflictTaskIds.push(taskOf(s));
  }
  return { mergedTaskIds, conflictTaskIds };
}

// completed_at 분포 → 활성일/경과일.
function computeCalendar(runs) {
  const dates = runs
    .map((r) => r.completed_at)
    .filter(Boolean)
    .map((s) => new Date(s))
    .filter((d) => !isNaN(d.getTime()));
  if (!dates.length) return { first: null, last: null, active_days: 0, elapsed_days: 0 };
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const days = new Set(dates.map(dayKey));
  const ms = dates.map((d) => d.getTime());
  const min = new Date(Math.min(...ms));
  const max = new Date(Math.max(...ms));
  const elapsed = Math.round((max.getTime() - min.getTime()) / 86400000) + 1;
  return { first: dayKey(min), last: dayKey(max), active_days: days.size, elapsed_days: elapsed };
}

function collectAll(projectDir) {
  const pactDir = path.join(projectDir, '.pact');
  const runs = readRuns(pactDir);
  const { tasks, byId } = readTasks(projectDir);
  return {
    projectDir,
    pactDir,
    hasPact: fs.existsSync(pactDir),
    runs,
    tasks,
    tasksById: byId,
    mergeResults: readMergeResults(pactDir),
    gitMerges: countMergesFromGit(projectDir),
    verifyLogs: readVerifyLogs(pactDir),
    salvageTouches: detectSalvage(projectDir, runs),
    calendar: computeCalendar(runs),
  };
}

module.exports = {
  collectAll,
  readRuns,
  readMergeResults,
  countMergesFromGit,
  readTasks,
  readVerifyLogs,
  detectSalvage,
  computeCalendar,
};
