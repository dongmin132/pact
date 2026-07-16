'use strict';

// A-3 — pact drift: reflect 의 드리프트 사전수집(단계 1.5/1.6)을 결정적 CLI 로.
// clean(코드변경 0 + failures 0 + rejected 0 + verify fail 0)이면 reflect 가
// planner(LLM, ~3M 토큰) 호출을 건너뛴다 — "결정적 작업 = CLI, 판단 = LLM".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { computeDrift } = require('../scripts/drift.js');

function sh(cmd, opts) { return execSync(cmd, { stdio: 'ignore', shell: true, ...opts }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-drift-'));
  sh('git init -b main', { cwd: dir });
  sh('git config user.email t@t.t && git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n');
  sh('git add . && git commit -m init', { cwd: dir });
  return dir;
}

function writeMergeResult(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pact/merge-result.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    merged: ['T-1'],
    rejected: [],
    failures: [],
    verification_summary: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
    decisions_to_record: [],
    ...extra,
  }, null, 2));
}

test('drift — merge-result 없으면 no_cycle (clean 아님 — planner 폴백)', () => {
  const dir = makeRepo();
  try {
    const r = computeDrift({ cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.no_cycle, true);
    assert.equal(r.clean, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — 머지 후 변경 없음 + 실패 없음 → clean:true (reflect LLM skip 대상)', () => {
  const dir = makeRepo();
  try {
    writeMergeResult(dir);
    const r = computeDrift({ cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.clean, true, JSON.stringify(r));
    assert.deepEqual(r.code_changed, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — 머지 후 코드 파일 직접 수정 → clean:false + code_changed 포착', async () => {
  const dir = makeRepo();
  try {
    // git log --since 는 초 단위 분해능 — 머지 timestamp 를 1초 과거로 박아 경계 오탐 제거
    writeMergeResult(dir, { timestamp: new Date(Date.now() - 1000).toISOString() });
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
    sh('git add . && git commit -m "user hotfix"', { cwd: dir });
    const r = computeDrift({ cwd: dir });
    assert.equal(r.clean, false);
    assert.ok(r.code_changed.includes('app.ts'), JSON.stringify(r));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — SOT 문서 변경은 docs_changed 로 분류', () => {
  const dir = makeRepo();
  try {
    writeMergeResult(dir, { timestamp: new Date(Date.now() - 1000).toISOString() });
    fs.mkdirSync(path.join(dir, 'contracts/api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'contracts/api/auth.md'), '# auth\n');
    sh('git add . && git commit -m "contract edit"', { cwd: dir });
    const r = computeDrift({ cwd: dir });
    assert.ok(r.docs_changed.includes('contracts/api/auth.md'), JSON.stringify(r));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — failures/rejected/verify fail 있으면 clean:false', () => {
  const dir = makeRepo();
  try {
    writeMergeResult(dir, { failures: [{ task_id: 'T-9', reason: 'blocked' }] });
    assert.equal(computeDrift({ cwd: dir }).clean, false);
    writeMergeResult(dir, { rejected: [{ task_id: 'T-9', reason: 'verify fail' }] });
    assert.equal(computeDrift({ cwd: dir }).clean, false);
    writeMergeResult(dir, { verification_summary: { lint: 'pass', test: 'fail' } });
    const r = computeDrift({ cwd: dir });
    assert.equal(r.clean, false);
    assert.deepEqual(r.verify_fails, ['test']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — standalone pact merge 산출물(요약 필드 없음)은 standalone_merge:true 신호', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pact/merge-result.json'), JSON.stringify({
      timestamp: new Date().toISOString(), merged: ['T-1'], rejected: [],
    }));
    const r = computeDrift({ cwd: dir });
    assert.equal(r.standalone_merge, true, 'planner 가 status.json 폴백해야 함을 신호');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — head_sha 있으면 오래된 날짜의 새 커밋도 토폴로지로 감지 (M17 false-clean 수리)', () => {
  const dir = makeRepo();
  try {
    // 머지 시점 HEAD 기록
    const headSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    writeMergeResult(dir, { head_sha: headSha });
    // 머지 후, 커밋 날짜를 과거로 백데이트한 코드 커밋(옛 브랜치 수동 머지 시뮬)
    fs.writeFileSync(path.join(dir, 'src.js'), 'code\n');
    sh('git add . && GIT_AUTHOR_DATE="2020-01-01T00:00:00" GIT_COMMITTER_DATE="2020-01-01T00:00:00" git commit -m old', { cwd: dir });
    const r = computeDrift({ cwd: dir });
    assert.equal(r.clean, false, '오래된 날짜라도 head_sha 이후 커밋은 drift 로 잡혀야 함(--since 날짜 함정 회피)');
    assert.ok(r.code_changed.includes('src.js'), JSON.stringify(r.code_changed));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drift — head_sha == HEAD(변경 없음)이면 clean', () => {
  const dir = makeRepo();
  try {
    const headSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    writeMergeResult(dir, { head_sha: headSha });
    const r = computeDrift({ cwd: dir });
    assert.equal(r.clean, true);
    assert.deepEqual(r.code_changed, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
