'use strict';

// PACT-026 — Worktree manager 단위 테스트
// 실제 git 명령을 호출하므로 임시 git repo를 fixture로 사용.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
  checkEnvironment,
  createWorktree,
  removeWorktree,
  listWorktrees,
  detectBaseBranch,
  reconcileWorktree,
} = require('../scripts/worktree-manager.js');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-wt-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email t@t.t && git config user.name test',
    { cwd: dir, stdio: 'ignore', shell: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add . && git commit -m init', { cwd: dir, stdio: 'ignore', shell: true });
  return dir;
}

function cleanup(dir) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: dir, encoding: 'utf8' });
    const lines = out.split('\n').filter(l => l.startsWith('worktree '));
    for (const l of lines) {
      const wt = l.replace('worktree ', '').trim();
      if (wt !== dir && fs.existsSync(wt)) {
        try { execSync(`git worktree remove --force "${wt}"`, { cwd: dir, stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

test('checkEnvironment — 정상 git repo 통과', () => {
  const repo = makeRepo();
  try {
    const r = checkEnvironment({ cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { cleanup(repo); }
});

test('checkEnvironment — 비-git 디렉토리 실패', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-nogit-'));
  try {
    const r = checkEnvironment({ cwd: dir });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /git/i.test(e)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkEnvironment — uncommitted changes 거부', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    const r = checkEnvironment({ cwd: repo });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /uncommitted/i.test(e)));
  } finally { cleanup(repo); }
});

// H6: 모노리포 서브디렉토리에서 실행하면 산출물이 리포 루트로 조용히 머지되던 결함 — 루트가 아니면 거부.
test('checkEnvironment — 리포 서브디렉토리에서 실행 시 거부 (H6 루트 가드)', () => {
  const repo = makeRepo();
  try {
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const r = checkEnvironment({ cwd: sub });
    assert.equal(r.ok, false, '서브디렉토리 실행은 거부돼야 함');
    assert.ok(r.errors.some(e => /루트|root|서브디렉/i.test(e)), JSON.stringify(r.errors));
  } finally { cleanup(repo); }
});

test('checkEnvironment — git init 직후(첫 커밋 전)는 "첫 커밋 필요"로 안내 (M24)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-nocommit-'));
  try {
    execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
    const r = checkEnvironment({ cwd: dir });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /커밋/.test(e)), `첫 커밋 안내여야 함 — ${JSON.stringify(r.errors)}`);
    assert.ok(!r.errors.some(e => /브랜치가 없습니다/.test(e)), '브랜치 없음 오진 문구는 없어야 함');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkEnvironment — 리포 루트에서는 통과 (H6 회귀 방지)', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'packages'), { recursive: true });
    const r = checkEnvironment({ cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { cleanup(repo); }
});

test('createWorktree — 경로·branch 생성', () => {
  const repo = makeRepo();
  try {
    const r = createWorktree('TEST-001', 'main', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.branch_name, 'pact/TEST-001');
    assert.match(r.working_dir, /\.pact\/worktrees\/TEST-001$/);
    assert.ok(fs.existsSync(path.join(repo, r.working_dir)));
  } finally { cleanup(repo); }
});

test('createWorktree — task_id 형식 위반 거부', () => {
  const repo = makeRepo();
  try {
    const r = createWorktree('invalid-id', 'main', { cwd: repo });
    assert.equal(r.ok, false);
  } finally { cleanup(repo); }
});

test('createWorktree — 이미 존재 시 에러', () => {
  const repo = makeRepo();
  try {
    createWorktree('TEST-001', 'main', { cwd: repo });
    const r = createWorktree('TEST-001', 'main', { cwd: repo });
    assert.equal(r.ok, false);
  } finally { cleanup(repo); }
});

test('removeWorktree — 정리 성공 + branch 삭제', () => {
  const repo = makeRepo();
  try {
    createWorktree('TEST-001', 'main', { cwd: repo });
    const r = removeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(repo, '.pact/worktrees/TEST-001')), false);
    // branch 도 삭제됨 확인
    const out = execSync('git branch --list pact/TEST-001', { cwd: repo, encoding: 'utf8' });
    assert.equal(out.trim(), '');
  } finally { cleanup(repo); }
});

test('listWorktrees — 활성 worktree 발견 + task_id 추출', () => {
  const repo = makeRepo();
  try {
    createWorktree('TEST-001', 'main', { cwd: repo });
    createWorktree('TEST-002', 'main', { cwd: repo });
    const r = listWorktrees({ cwd: repo });
    assert.equal(r.active.length, 2);
    const ids = r.active.map(w => w.task_id).sort();
    assert.deepEqual(ids, ['TEST-001', 'TEST-002']);
  } finally { cleanup(repo); }
});

test('listWorktrees — main worktree는 제외', () => {
  const repo = makeRepo();
  try {
    const r = listWorktrees({ cwd: repo });
    assert.equal(r.active.length, 0);
  } finally { cleanup(repo); }
});

test('createWorktree — node_modules가 있으면 symlink 생성', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules/.marker'), 'main');
    const r = createWorktree('TEST-001', 'main', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    const wtNm = path.join(repo, r.working_dir, 'node_modules');
    const lst = fs.lstatSync(wtNm);
    assert.equal(lst.isSymbolicLink(), true, 'node_modules는 symlink여야');
    assert.equal(
      fs.readFileSync(path.join(wtNm, '.marker'), 'utf8'),
      'main',
      'symlink을 통해 main의 .marker가 보여야',
    );
  } finally { cleanup(repo); }
});

test('createWorktree — node_modules 없으면 symlink 생성 안 함', () => {
  const repo = makeRepo();
  try {
    const r = createWorktree('TEST-001', 'main', { cwd: repo });
    assert.equal(r.ok, true);
    assert.equal(
      fs.existsSync(path.join(repo, r.working_dir, 'node_modules')),
      false,
    );
  } finally { cleanup(repo); }
});

test('createWorktree — opts.linkNodeModules: false 시 skip', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'node_modules'));
    const r = createWorktree('TEST-001', 'main', { cwd: repo, linkNodeModules: false });
    assert.equal(r.ok, true);
    assert.equal(
      fs.existsSync(path.join(repo, r.working_dir, 'node_modules')),
      false,
    );
  } finally { cleanup(repo); }
});

test('removeWorktree — 이미 없는 worktree 는 ok:true 멱등 (거짓 실패 엔트리 방지)', () => {
  const repo = makeRepo();
  try {
    const r = removeWorktree('GONE-001', { cwd: repo });
    assert.equal(r.ok, true, '없는 worktree 정리는 성공으로 간주해야 함');
    assert.equal(r.removed, false);
  } finally { cleanup(repo); }
});

test('removeWorktree — node_modules symlink이 있어도 정리 성공', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'node_modules'));
    createWorktree('TEST-001', 'main', { cwd: repo });
    const r = removeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(repo, '.pact/worktrees/TEST-001')), false);
  } finally { cleanup(repo); }
});

// ─── detectBaseBranch (base_branch 하드코딩 제거) ──────────
test('detectBaseBranch — main 있으면 main', () => {
  const repo = makeRepo(); // git init -b main
  try {
    assert.equal(detectBaseBranch({ cwd: repo }), 'main');
  } finally { cleanup(repo); }
});

test('detectBaseBranch — main 없고 master면 master', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-wt-master-'));
  try {
    execSync('git init -b master', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email t@t.t && git config user.name test', { cwd: dir, stdio: 'ignore', shell: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
    execSync('git add . && git commit -m init', { cwd: dir, stdio: 'ignore', shell: true });
    assert.equal(detectBaseBranch({ cwd: dir }), 'master');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── reconcileWorktree (prepare 재진입 stale 자가치유, 데이터 안전) ──────
test('reconcileWorktree — worktree 없으면 clean', () => {
  const repo = makeRepo();
  try {
    const r = reconcileWorktree('PROJ-001', 'main', { cwd: repo });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'clean');
  } finally { cleanup(repo); }
});

test('reconcileWorktree — 미머지 커밋 없는 stale worktree는 회수(reclaimed)', () => {
  const repo = makeRepo();
  try {
    const first = createWorktree('PROJ-001', 'main', { cwd: repo });
    assert.equal(first.ok, true);
    // 커밋 안 함(미머지 작업 없음) → 회수 가능해야
    const r = reconcileWorktree('PROJ-001', 'main', { cwd: repo });
    assert.equal(r.ok, true, `reclaimed 실패: ${r.error}`);
    assert.equal(r.action, 'reclaimed');
    assert.equal(fs.existsSync(path.join(repo, '.pact/worktrees/PROJ-001')), false, '회수 후 dir 없어야');
    // 회수 후 재생성 성공
    const again = createWorktree('PROJ-001', 'main', { cwd: repo });
    assert.equal(again.ok, true, `재생성 실패: ${again.error}`);
  } finally { cleanup(repo); }
});

test('reconcileWorktree — 미머지 커밋 있는 worktree는 보존하고 ok:false (데이터 안전)', () => {
  const repo = makeRepo();
  try {
    const first = createWorktree('PROJ-002', 'main', { cwd: repo });
    const wtAbs = path.join(repo, first.working_dir);
    fs.writeFileSync(path.join(wtAbs, 'work.txt'), 'important\n');
    execSync('git add . && git commit -m "unmerged work"', { cwd: wtAbs, stdio: 'ignore', shell: true });
    const r = reconcileWorktree('PROJ-002', 'main', { cwd: repo });
    assert.equal(r.ok, false, '미머지 커밋 있으면 회수 거부');
    assert.equal(r.preserved, true);
    assert.ok(fs.existsSync(path.join(wtAbs, 'work.txt')), '미머지 작업 보존돼야');
    // 미머지(commit) 메시지는 dirty 메시지와 분리돼야 — "미머지"를 명시
    assert.match(r.error, /미머지/, '미머지 메시지여야');
  } finally { cleanup(repo); }
});

test('reconcileWorktree — 미커밋 작업물(untracked)만 있어도 보존 (STAB-3, 데이터 안전)', () => {
  const repo = makeRepo();
  try {
    const first = createWorktree('PROJ-003', 'main', { cwd: repo });
    const wtAbs = path.join(repo, first.working_dir);
    // 워커가 아직 커밋하지 않은 새 파일 — force-remove되면 손실되던 케이스
    fs.writeFileSync(path.join(wtAbs, 'wip.txt'), 'work-in-progress\n');
    const r = reconcileWorktree('PROJ-003', 'main', { cwd: repo });
    assert.equal(r.ok, false, '미커밋 작업물 있으면 회수 거부해야');
    assert.equal(r.preserved, true);
    assert.ok(fs.existsSync(path.join(wtAbs, 'wip.txt')), '미커밋 작업물 보존돼야');
    // dirty 메시지는 unmerged와 분리 + 수동 탈출구(git worktree remove --force) 안내
    assert.match(r.error, /미커밋/, 'dirty 메시지여야');
    assert.match(r.error, /git worktree remove --force/, '수동 탈출구 안내해야');
  } finally { cleanup(repo); }
});

test('reconcileWorktree — 추적파일 수정(미커밋)만 있어도 보존 (STAB-3)', () => {
  const repo = makeRepo();
  try {
    const first = createWorktree('PROJ-004', 'main', { cwd: repo });
    const wtAbs = path.join(repo, first.working_dir);
    fs.writeFileSync(path.join(wtAbs, 'README.md'), '# test\nlocal uncommitted edit\n');
    const r = reconcileWorktree('PROJ-004', 'main', { cwd: repo });
    assert.equal(r.ok, false, '미커밋 수정 있으면 회수 거부해야');
    assert.equal(r.preserved, true);
    assert.equal(
      fs.readFileSync(path.join(wtAbs, 'README.md'), 'utf8'),
      '# test\nlocal uncommitted edit\n',
      '미커밋 수정 내용 보존돼야',
    );
  } finally { cleanup(repo); }
});
