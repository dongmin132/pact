'use strict';

// pact metrics — collect.js + git-ro.js (read-only 로더) 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { readRuns, readMergeResults, readTasks, computeCalendar, collectAll, readDriverEvents } = require('../scripts/metrics/collect.js');
const { git, READONLY } = require('../scripts/metrics/git-ro.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pact-metrics-')); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }

// ── readRuns ────────────────────────────────────────────────────
test('readRuns: status.json 읽고, 부재 디렉토리는 미보고(null → in_flight)', () => {
  const d = tmp();
  write(path.join(d, '.pact/runs/A/status.json'), JSON.stringify({ task_id: 'A', status: 'done', tokens_used: 10 }));
  fs.mkdirSync(path.join(d, '.pact/runs/B'), { recursive: true }); // status.json 없음 — 진행중일 수 있음
  const runs = readRuns(path.join(d, '.pact'));
  const byId = Object.fromEntries(runs.map((r) => [r.task_id, r]));
  assert.equal(byId.A.status, 'done');
  assert.equal(byId.A.tokens_used, 10);
  assert.equal(byId.B.status, null, 'status.json 없으면 미보고 — failed 단정 금지(dogfood #5)');
});

// ── readMergeResults ────────────────────────────────────────────
test('readMergeResults: 현재 + archive 머지결과만', () => {
  const d = tmp();
  write(path.join(d, '.pact/merge-result.json'), JSON.stringify({ merged: ['A'], conflicted: null }));
  write(path.join(d, '.pact/archive/m1.json'), JSON.stringify({ merged: ['B'], conflicted: { task_id: 'B' } }));
  write(path.join(d, '.pact/archive/notmerge.json'), JSON.stringify({ something: 1 }));
  const mr = readMergeResults(path.join(d, '.pact'));
  assert.equal(mr.length, 2, '머지결과 형태 2개만');
});

// ── readTasks ───────────────────────────────────────────────────
test('readTasks: tasks/*.md frontmatter 에서 allowed_paths 파싱', () => {
  const d = tmp();
  const md = [
    '## FOO-1  샘플 task',
    '',
    '```yaml',
    'priority: P0',
    'status: done',
    'dependencies: []',
    'allowed_paths:',
    '  - src/foo/**',
    'done_criteria:',
    '  - 된다',
    'tdd: false',
    '```',
    '',
  ].join('\n');
  write(path.join(d, 'tasks/foo.md'), md);
  const { byId } = readTasks(d);
  assert.ok(byId['FOO-1'], 'FOO-1 파싱됨');
  assert.deepEqual(byId['FOO-1'].allowed_paths, ['src/foo/**']);
});

// ── readDriverEvents (IMP-1) ────────────────────────────────────
test('readDriverEvents: JSONL 파싱 · 깨진/빈 줄 무시 · 부재 → []', () => {
  const d = tmp();
  write(path.join(d, '.pact/driver-events.jsonl'), [
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', type: 'cycle', cycle: 1, cycle_id: 'c1' }),
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'dispatch', task_id: 'A' }),
    'not-json-garbage',
    JSON.stringify({ ts: '2026-01-01T00:00:00.100Z', type: 'settle', task_id: 'A', status: 'done' }),
    '',
  ].join('\n'));
  const evs = readDriverEvents(path.join(d, '.pact'));
  assert.equal(evs.length, 3, '깨진 줄·빈 줄 제외한 3개');
  assert.equal(evs[1].type, 'dispatch');
  assert.equal(evs[2].status, 'done');
  assert.equal(readDriverEvents(path.join(tmp(), '.pact')).length, 0, '파일 부재 → []');
});

test('collectAll: driverEvents 포함(부재 시 빈 배열)', () => {
  const d = tmp();
  const c = collectAll(d);
  assert.ok(Array.isArray(c.driverEvents), 'driverEvents 필드 존재');
  assert.equal(c.driverEvents.length, 0);
});

// ── computeCalendar ─────────────────────────────────────────────
test('computeCalendar: 활성일(고유 날짜)/경과일', () => {
  const runs = [
    { completed_at: '2026-05-01T10:00:00Z' },
    { completed_at: '2026-05-01T20:00:00Z' }, // 같은 날
    { completed_at: '2026-05-03T10:00:00Z' },
    { completed_at: null },
  ];
  const c = computeCalendar(runs);
  assert.equal(c.active_days, 2, '고유 날짜 2');
  assert.equal(c.elapsed_days, 3, '05-01~05-03 = 3일');
  assert.equal(c.first, '2026-05-01');
  assert.equal(c.last, '2026-05-03');
});

// ── git-ro 화이트리스트 ─────────────────────────────────────────
test('git-ro: 비-readonly 명령 거부, readonly 허용', () => {
  const d = tmp();
  execFileSync('git', ['-C', d, 'init', '-q']);
  execFileSync('git', ['-C', d, 'config', 'user.email', 't@t'], {});
  execFileSync('git', ['-C', d, 'config', 'user.name', 't'], {});
  write(path.join(d, 'x.txt'), 'hi');
  execFileSync('git', ['-C', d, 'add', '.']);
  execFileSync('git', ['-C', d, 'commit', '-qm', 'init']);

  // mutating/미허용은 throw
  for (const bad of ['checkout', 'commit', 'merge', 'reset', 'stash', 'branch', 'add', 'rm', 'clean', 'push']) {
    assert.throws(() => git(d, [bad, '--whatever'], { allowFail: false }), new RegExp(bad), `${bad} 거부`);
  }
  // readonly 는 동작
  const out = git(d, ['log', '--format=%s']);
  assert.match(out, /init/);
  assert.ok(READONLY.has('log'));
});

// ── read-only 불변식: collect/git 후 대상 git 상태 불변 ──────────
test('read-only 불변식: metrics 읽기 후 git status·HEAD 불변', () => {
  const d = tmp();
  execFileSync('git', ['-C', d, 'init', '-q']);
  execFileSync('git', ['-C', d, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', d, 'config', 'user.name', 't']);
  write(path.join(d, '.pact/runs/A/status.json'), JSON.stringify({ task_id: 'A', status: 'done', completed_at: '2026-05-01T00:00:00Z' }));
  write(path.join(d, 'tasks/foo.md'), '## A  t\n\n```yaml\npriority: P0\nstatus: done\ndependencies: []\nallowed_paths:\n  - src/**\ndone_criteria:\n  - x\ntdd: false\n```\n');
  execFileSync('git', ['-C', d, 'add', '.']);
  execFileSync('git', ['-C', d, 'commit', '-qm', 'init']);
  const headBefore = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const statusBefore = execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' });

  collectAll(d); // 전체 수집 실행

  const headAfter = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const statusAfter = execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(headAfter, headBefore, 'HEAD 불변');
  assert.equal(statusAfter, statusBefore, 'working tree 불변');
});
