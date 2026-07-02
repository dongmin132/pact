'use strict';

// pact report-gen (SPD-5 · P1-4) — status.json → report.md 결정적 렌더 유닛 테스트.
//  · 정상 렌더(구조화 필드 반영)
//  · summary 없음(명시적 placeholder, throw X)
//  · 기존 report.md 존중(덮어쓰지 않음) — 철학5
//  · --force 는 재렌더
//  · CLI (bin/pact report-gen <task_id> | --all)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACT_BIN = path.join(ROOT, 'bin', 'pact');
const { renderReport, generateReport, generateAll } = require('../scripts/report-gen.js');

function mkRuns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-rg-'));
  const runsRoot = path.join(dir, '.pact/runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  return { dir, runsRoot };
}

function writeStatus(runsRoot, taskId, overrides = {}) {
  const dir = path.join(runsRoot, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const status = {
    task_id: taskId,
    status: 'done',
    branch_name: `pact/${taskId}`,
    commits_made: 2,
    clean_for_merge: true,
    files_changed: ['src/a.ts', 'src/b.ts'],
    files_attempted_outside_scope: [],
    verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'skip' },
    tdd_evidence: { red_observed: true, green_observed: true },
    decisions: [{ topic: '저장 위치', choice: 'secure-storage', rationale: 'plaintext 회피' }],
    blockers: [],
    tokens_used: 1000,
    completed_at: '2026-07-03T10:00:00Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status, null, 2));
  return status;
}

// ─── renderReport (순수 함수) ─────────────────────────────

test('renderReport — 구조화 필드가 report 본문에 반영', () => {
  const md = renderReport({
    task_id: 'PROJ-001', status: 'done',
    summary: '로그인 폼 검증 추가. 엣지케이스 2건 발견해 해결.',
    files_changed: ['src/login.ts'],
    verify_results: { lint: 'pass', test: 'fail' },
    decisions: [{ topic: 't', choice: 'c', rationale: 'r' }],
    blockers: ['남은 리팩터'],
    branch_name: 'pact/PROJ-001', commits_made: 3, completed_at: '2026-07-03T10:00:00Z',
  });
  assert.match(md, /# PROJ-001 — done/);
  assert.match(md, /로그인 폼 검증 추가/);
  assert.match(md, /src\/login\.ts/);
  assert.match(md, /- lint: pass/);
  assert.match(md, /- test: fail/);
  assert.match(md, /\*\*t\*\* → c/);
  assert.match(md, /근거: r/);
  assert.match(md, /남은 리팩터/);
  assert.match(md, /commits: 3/);
});

test('renderReport — summary 없으면 placeholder (throw X)', () => {
  const md = renderReport({ task_id: 'PROJ-002', status: 'blocked' });
  assert.match(md, /# PROJ-002 — blocked/);
  assert.match(md, /요약 없음/);
  assert.match(md, /## 변경 파일 \(0\)/);
  assert.match(md, /- \(없음\)/);
});

test('renderReport — null/빈 입력에도 안전', () => {
  const md = renderReport(null);
  assert.match(md, /# \(unknown\) — \(unknown\)/);
  assert.match(md, /요약 없음/);
});

// ─── generateReport (디스크) ──────────────────────────────

test('generateReport — status.json 있고 report.md 없으면 렌더', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    writeStatus(runsRoot, 'PROJ-001', { summary: '요약 서사' });
    const r = generateReport('PROJ-001', { runsRoot });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'rendered');
    const md = fs.readFileSync(path.join(runsRoot, 'PROJ-001', 'report.md'), 'utf8');
    assert.match(md, /요약 서사/);
    assert.match(md, /src\/a\.ts/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generateReport — 기존 report.md 존중(덮어쓰지 않음, 철학5)', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    writeStatus(runsRoot, 'PROJ-001');
    const handWritten = '# 워커 수기 리포트\n\n특수 서사 보존.\n';
    fs.writeFileSync(path.join(runsRoot, 'PROJ-001', 'report.md'), handWritten);
    const r = generateReport('PROJ-001', { runsRoot });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'skipped');
    // 원본 그대로여야 (렌더가 덮어쓰지 않음)
    assert.equal(fs.readFileSync(path.join(runsRoot, 'PROJ-001', 'report.md'), 'utf8'), handWritten);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generateReport — --force 는 기존 report.md 재렌더', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    writeStatus(runsRoot, 'PROJ-001', { summary: '재렌더 확인' });
    fs.writeFileSync(path.join(runsRoot, 'PROJ-001', 'report.md'), '# 수기\n');
    const r = generateReport('PROJ-001', { runsRoot, force: true });
    assert.equal(r.action, 'rendered');
    assert.match(fs.readFileSync(path.join(runsRoot, 'PROJ-001', 'report.md'), 'utf8'), /재렌더 확인/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generateReport — status.json 없으면 ok:false, report.md 안 만듦', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    fs.mkdirSync(path.join(runsRoot, 'PROJ-009'), { recursive: true });
    const r = generateReport('PROJ-009', { runsRoot });
    assert.equal(r.ok, false);
    assert.match(r.reason, /status\.json missing/);
    assert.equal(fs.existsSync(path.join(runsRoot, 'PROJ-009', 'report.md')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generateAll — taskIds 지정 시 각각 렌더, 결과 배열', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    writeStatus(runsRoot, 'PROJ-001');
    writeStatus(runsRoot, 'PROJ-002');
    // PROJ-002 는 수기 report 존재 → skip 되어야
    fs.writeFileSync(path.join(runsRoot, 'PROJ-002', 'report.md'), '# 수기\n한줄\n');
    const rows = generateAll({ runsRoot, taskIds: ['PROJ-001', 'PROJ-002'] });
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.task_id === 'PROJ-001').action, 'rendered');
    assert.equal(rows.find(r => r.task_id === 'PROJ-002').action, 'skipped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── CLI ──────────────────────────────────────────────────

test('CLI pact report-gen <task_id> — 렌더 후 exit 0', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    writeStatus(runsRoot, 'PROJ-001', { summary: 'cli 렌더' });
    const r = spawnSync('node', [PACT_BIN, 'report-gen', 'PROJ-001', '--project', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PROJ-001: ✓ 렌더/);
    assert.match(fs.readFileSync(path.join(runsRoot, 'PROJ-001', 'report.md'), 'utf8'), /cli 렌더/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI pact report-gen --all --json — 전체 대상 결과 JSON', () => {
  const { dir, runsRoot } = mkRuns();
  try {
    writeStatus(runsRoot, 'PROJ-001');
    writeStatus(runsRoot, 'PROJ-002');
    const r = spawnSync('node', [PACT_BIN, 'report-gen', '--all', '--json', '--project', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.results.length, 2);
    assert.ok(out.results.every(x => x.ok));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI pact report-gen — 인자 없으면 usage + exit 1', () => {
  const { dir } = mkRuns();
  try {
    const r = spawnSync('node', [PACT_BIN, 'report-gen', '--project', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: pact report-gen/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
