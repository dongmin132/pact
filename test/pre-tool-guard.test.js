'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  matchesGlob,
  checkPath,
  readOwnership,
  detectWorktreeContext,
  isInsideWorktree,
} = require('../hooks/pre-tool-guard.js');

test('matchesGlob — 정확 매칭', () => {
  assert.equal(matchesGlob('src/api/auth/login.ts', 'src/api/auth/login.ts'), true);
});

test('matchesGlob — ** 재귀', () => {
  assert.equal(matchesGlob('src/api/auth/login.ts', 'src/api/**'), true);
  assert.equal(matchesGlob('src/api/auth/deep/nested.ts', 'src/api/**'), true);
});

test('matchesGlob — * 단일 segment만', () => {
  assert.equal(matchesGlob('src/foo.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/foo/bar.ts', 'src/*.ts'), false);
});

test('checkPath — 어느 owner_path에도 안 맞으면 deny', () => {
  const r = checkPath('src/components/x.ts', ['src/api/**', 'src/types/**']);
  assert.equal(r.allowed, false);
});

test('checkPath — 하나라도 맞으면 allow', () => {
  const r = checkPath('src/api/auth/login.ts', ['src/api/**', 'src/types/**']);
  assert.equal(r.allowed, true);
});

test('checkPath — 빈 owner_paths는 allow (강제 X)', () => {
  assert.equal(checkPath('any/path.ts', []).allowed, true);
});

test('readOwnership — MODULE_OWNERSHIP.md에서 owner_paths 추출', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'MODULE_OWNERSHIP.md'), `# ownership

## auth

\`\`\`yaml
module: auth
owner_paths:
  - src/api/auth/**
  - src/types/auth.ts
\`\`\`

## users

\`\`\`yaml
module: users
owner_paths:
  - src/api/users/**
\`\`\`
`);
    const r = readOwnership(tmpDir);
    assert.deepEqual(r.sort(), [
      'src/api/auth/**',
      'src/api/users/**',
      'src/types/auth.ts',
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readOwnership — 파일 없으면 null (강제 X)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    assert.equal(readOwnership(tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectWorktreeContext — worktree 안에서 task_id 추출', () => {
  const r = detectWorktreeContext('/repo/.pact/worktrees/PACT-042/src');
  assert.equal(r.task_id, 'PACT-042');
});

test('detectWorktreeContext — worktree 밖이면 null', () => {
  assert.equal(detectWorktreeContext('/repo/src'), null);
});

test('isInsideWorktree — worktree 안의 파일은 true', () => {
  assert.equal(
    isInsideWorktree('/repo/.pact/worktrees/PACT-042/src/foo.ts', '/repo/.pact/worktrees/PACT-042'),
    true,
  );
});

test('isInsideWorktree — worktree 밖의 파일은 false', () => {
  assert.equal(
    isInsideWorktree('/repo/src/foo.ts', '/repo/.pact/worktrees/PACT-042'),
    false,
  );
});
