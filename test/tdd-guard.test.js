'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  isTestFile,
  isCodeFile,
  detectWorktreeContext,
  hasCorrespondingTest,
} = require('../hooks/tdd-guard.js');

test('isTestFile — *.test.ts 인식', () => {
  assert.equal(isTestFile('src/foo.test.ts'), true);
  assert.equal(isTestFile('src/foo.spec.js'), true);
  assert.equal(isTestFile('test_foo.py'), false);  // _test.py만 인식
  assert.equal(isTestFile('foo_test.py'), true);
});

test('isCodeFile — 코드 파일이지만 테스트 아닌 것만', () => {
  assert.equal(isCodeFile('src/foo.ts'), true);
  assert.equal(isCodeFile('src/foo.test.ts'), false);
  assert.equal(isCodeFile('README.md'), false);
});

test('detectWorktreeContext — worktree path에서 task_id 추출', () => {
  const r = detectWorktreeContext('/tmp/repo/.pact/worktrees/PACT-042/src');
  assert.equal(r.task_id, 'PACT-042');
  assert.match(r.worktreeRoot, /\.pact\/worktrees\/PACT-042$/);
});

test('detectWorktreeContext — worktree 밖이면 null', () => {
  assert.equal(detectWorktreeContext('/tmp/repo/src'), null);
});

test('hasCorrespondingTest — 동일 디렉토리에 .test 파일', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-tdd-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/foo.test.ts'), '');
    assert.equal(hasCorrespondingTest('src/foo.ts', dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasCorrespondingTest — __tests__/ 폴더', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-tdd-'));
  try {
    fs.mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/__tests__/foo.test.ts'), '');
    assert.equal(hasCorrespondingTest('src/foo.ts', dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasCorrespondingTest — 테스트 없으면 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-tdd-'));
  try {
    assert.equal(hasCorrespondingTest('src/foo.ts', dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
