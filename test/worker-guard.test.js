'use strict';

// worker-guard — 헤드리스 드라이버 canUseTool 의 단일 소스 가드.
// pre-tool-guard 의 glob/SOT 로직을 재사용해 인터랙티브 hook 과 동일 규칙 보장.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { guardToolUse } = require('../scripts/lib/worker-guard.js');

const WD = '/repo/.pact/worktrees/PROJ-001';

test('Write — allowed_paths(glob) 안이면 allow', () => {
  const r = guardToolUse('Write', { file_path: path.join(WD, 'src/a/b.ts') },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Write — allowed_paths 밖이면 deny (glob, prefix 아님)', () => {
  const r = guardToolUse('Write', { file_path: path.join(WD, 'lib/x.ts') },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /allowed_paths/);
});

test('Write — worktree 외부(절대경로)면 deny', () => {
  const r = guardToolUse('Write', { file_path: '/etc/passwd' },
    { workingDir: WD, allowedPaths: ['**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /worktree/);
});

test('Read — 긴 SOT 원문(ARCHITECTURE.md)이면 deny', () => {
  const r = guardToolUse('Read', { file_path: path.join(WD, 'ARCHITECTURE.md') }, { workingDir: WD });
  assert.equal(r.allow, false);
  assert.match(r.reason, /SOT/);
});

test('Read — 허용 문서(tasks/x.md)면 allow', () => {
  const r = guardToolUse('Read', { file_path: path.join(WD, 'tasks/auth.md') }, { workingDir: WD });
  assert.equal(r.allow, true);
});

test('Bash — 파괴적 명령(rm -rf)이면 deny', () => {
  const r = guardToolUse('Bash', { command: 'rm -rf /' }, { workingDir: WD });
  assert.equal(r.allow, false);
});

test('Bash — 일반 명령이면 allow', () => {
  const r = guardToolUse('Bash', { command: 'npm test' }, { workingDir: WD });
  assert.equal(r.allow, true);
});

test('allowed_paths 없으면 worktree 안의 쓰기는 allow', () => {
  const r = guardToolUse('Edit', { file_path: path.join(WD, 'anything.ts') }, { workingDir: WD });
  assert.equal(r.allow, true);
});
