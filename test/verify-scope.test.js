'use strict';

// H7 — verify-scope: /pact:verify 의 docs-only 판별이 HEAD~1 단일 커밋이라, 표준 사이클의
// 트레일링 bookkeeping/status(md-only) 커밋에 코드 머지가 가려져 Code 축이 항상 skip 되던
// 결함(C-4)을 결정적 CLI 로 대체한 것의 회귀 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { cycleCodeChanges } = require('../scripts/verify-scope.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-vscope-'));
  git(d, 'init', '-b', 'main');
  git(d, 'config', 'user.email', 't@t.t');
  git(d, 'config', 'user.name', 'test');
  return d;
}

function commit(d, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(d, 'add', '-A');
  git(d, 'commit', '-m', msg);
}

test('코드 머지 뒤 bookkeeping 커밋이 붙어도 code_changed=true (핵심 결함)', () => {
  const d = repo();
  try {
    commit(d, { 'README.md': '# base\n' }, 'init');
    // 이번 사이클: 코드 머지 → status 커밋 → bookkeeping 커밋 (표준 순서)
    commit(d, { 'src/auth.js': 'export const x = 1\n' }, 'Merge task AUTH-1');
    commit(d, { 'tasks/auth.md': '## done\n' }, 'pact: cycle status updates');
    commit(d, { 'PROGRESS.md': '# progress\n' }, 'pact: cycle bookkeeping');

    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.ok, true);
    assert.equal(r.code_changed, true, 'bookkeeping 에 가려지지 않고 코드 변경을 봐야 함');
    assert.ok(r.files.includes('src/auth.js'), `코드 파일이 잡혀야 함 — ${JSON.stringify(r.files)}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('진짜 docs-only 사이클은 code_changed=false (스킵 정당)', () => {
  const d = repo();
  try {
    commit(d, { 'README.md': '# base\n' }, 'init');
    commit(d, { 'docs/guide.md': '# guide\n' }, 'Merge task DOC-1');
    commit(d, { 'tasks/doc.md': '## done\n' }, 'pact: cycle status updates');
    commit(d, { 'PROGRESS.md': '# progress\n' }, 'pact: cycle bookkeeping');

    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.code_changed, false, 'docs/md 만 바뀐 사이클은 skip 가능해야 함');
    assert.equal(r.files.length, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('여러 task 머지(코드+docs 혼합) 사이클도 코드 변경을 놓치지 않는다', () => {
  const d = repo();
  try {
    commit(d, { 'README.md': '# base\n' }, 'init');
    commit(d, { 'src/a.js': 'a\n' }, 'Merge task A');          // 코드
    commit(d, { 'docs/b.md': 'b\n' }, 'Merge task B');         // docs
    commit(d, { 'tasks/x.md': '## done\n' }, 'pact: cycle status updates');
    commit(d, { 'PROGRESS.md': '# p\n' }, 'pact: cycle bookkeeping');

    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.code_changed, true, '사이클 앞쪽 코드 머지(task A)도 범위에 포함돼야 함');
    assert.ok(r.files.includes('src/a.js'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('bookkeeping 커밋 없이 코드 커밋만 있어도 code_changed=true', () => {
  const d = repo();
  try {
    commit(d, { 'README.md': '# base\n' }, 'init');
    commit(d, { 'src/a.js': 'a\n' }, 'Merge task A');
    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.code_changed, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('인터랙티브 파이프라인: 머지마다 status 커밋이 끼어도 앞쪽 코드 머지를 놓치지 않는다 (H7-2)', () => {
  const d = repo();
  try {
    commit(d, { 'README.md': '# base\n' }, 'init');
    // 인터랙티브: 코드 task 먼저 머지 → collect-one status 커밋 → 문서 task 머지 → status 커밋 → bookkeeping
    commit(d, { 'src/auth.js': 'code\n' }, 'Merge task AUTH-1');
    commit(d, { 'tasks/auth.md': '## done\n' }, 'pact: cycle status updates');   // 사이클 중간 status 커밋
    commit(d, { 'docs/note.md': 'note\n' }, 'Merge task DOC-2');
    commit(d, { 'tasks/doc.md': '## done\n' }, 'pact: cycle status updates');
    commit(d, { 'PROGRESS.md': '# p\n' }, 'pact: cycle bookkeeping');

    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.code_changed, true, '중간 status 커밋을 경계로 오인해 앞쪽 코드 머지를 놓치면 안 됨');
    assert.ok(r.files.includes('src/auth.js'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('이전 bookkeeping 경계로 직전 사이클을 정확히 배제 — 이번 사이클이 docs-only면 false (H7-2)', () => {
  const d = repo();
  try {
    commit(d, { 'README.md': '# base\n' }, 'init');
    // 이전 사이클: 코드 머지 + bookkeeping 경계
    commit(d, { 'src/old.js': 'old\n' }, 'Merge task OLD-1');
    commit(d, { 'PROGRESS.md': '# p1\n' }, 'pact: cycle bookkeeping');
    // 이번 사이클: 문서만
    commit(d, { 'docs/new.md': 'new\n' }, 'Merge task DOC-2');
    commit(d, { 'PROGRESS.md': '# p2\n' }, 'pact: cycle bookkeeping');

    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.code_changed, false, '이번 사이클이 docs-only면 직전 사이클의 코드 머지에 오염되면 안 됨');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('window 안에서 이전 bookkeeping 경계를 못 찾으면 fail-safe code_changed=true (H7-2)', () => {
  const d = repo();
  try {
    // bookkeeping 경계 없이 코드 커밋만 (첫 사이클 또는 window 초과 시뮬)
    commit(d, { 'README.md': '# base\n' }, 'init');
    commit(d, { 'src/a.js': 'a\n' }, 'Merge task A');
    const r = cycleCodeChanges({ cwd: d, window: 2 });  // 작은 window 로 경계 못 찾는 상황 강제
    assert.equal(r.code_changed, true, '경계 불확실 시 skip 하지 말고 Code 축 실행');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('git 저장소 아니면 fail-safe 로 code_changed=true(false-skip 금지)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-vscope-nogit-'));
  try {
    const r = cycleCodeChanges({ cwd: d });
    assert.equal(r.ok, false);
    assert.equal(r.code_changed, true, 'git 실패 시 skip 하지 말고 Code 축을 돌려야 안전');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
