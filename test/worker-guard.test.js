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

// --- Bash 리다이렉션 allowed_paths 우회 차단 (CLEANUP-029 회귀) ---------------

test('Bash 리다이렉션 — allowed_paths 밖(워크트리 내) 쓰기면 deny (029 패턴)', () => {
  const r = guardToolUse('Bash',
    { command: 'cat > docs/ui/cleanup-011-review.md <<EOF\nverdict\nEOF' },
    { workingDir: WD, allowedPaths: ['apps/mobile/components/meetup/**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /allowed_paths|Bash/);
});

test('Bash >> append — 범위 밖이면 deny', () => {
  const r = guardToolUse('Bash', { command: 'echo x >> docs/notes.md' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash tee — 범위 밖이면 deny', () => {
  const r = guardToolUse('Bash', { command: 'echo x | tee docs/x.md' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash 리다이렉션 — allowed_paths 안이면 allow', () => {
  const r = guardToolUse('Bash', { command: 'cat > src/foo.ts <<EOF\nx\nEOF' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — /dev/null 리다이렉션은 쓰기 아님 (allow)', () => {
  const r = guardToolUse('Bash', { command: 'npm test > /dev/null 2>&1' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — status.json(워크트리 밖 .pact/runs)은 allow', () => {
  const r = guardToolUse('Bash',
    { command: 'cat > /repo/.pact/runs/PROJ-001/status.json <<EOF\n{}\nEOF' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — 따옴표 안의 > 오탐 안 함 (echo "a > b")', () => {
  const r = guardToolUse('Bash', { command: 'echo "a > b"' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — heredoc 본문의 =>·> 오탐 안 함 (in-scope 코드 쓰기)', () => {
  const r = guardToolUse('Bash',
    { command: 'cat > src/a.ts <<EOF\nconst f = (x) => x > 1 ? a : b\nEOF' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — allowed_paths 없으면 리다이렉션 검사 안 함 (allow)', () => {
  const r = guardToolUse('Bash', { command: 'cat > docs/x.md' }, { workingDir: WD });
  assert.equal(r.allow, true);
});

test('Bash — demo allowed_paths(**)면 어떤 쓰기도 allow', () => {
  const r = guardToolUse('Bash', { command: 'cat > anything/x.md' },
    { workingDir: WD, allowedPaths: ['**'] });
  assert.equal(r.allow, true);
});

// --- STAB-4: worktree 경계 밖 쓰기 경계 분류 (형제 WT deny · temp allow · heredoc-aware) ---

test('Bash — 형제 worktree(../OTHER-1) 쓰기면 deny (형제 WT 오염)', () => {
  const r = guardToolUse('Bash', { command: 'echo x > ../OTHER-1/src/f.js' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /worktree/);
});

test('Bash — 워크트리 밖 /tmp 쓰기는 allow (임시파일)', () => {
  const r = guardToolUse('Bash', { command: 'echo x > /tmp/pact-x' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — 자기 runs/<id>/status.json 절대경로 쓰기는 allow (보고 회귀 방지)', () => {
  const r = guardToolUse('Bash',
    { command: 'echo "{}" > /repo/.pact/runs/PROJ-001/status.json' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

test('Bash — 둘째 줄 홈 탈출(cmd1\\ncat > ~/.zshrc)이면 deny (레포 밖)', () => {
  const r = guardToolUse('Bash', { command: 'cmd1\ncat > ~/.zshrc' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — heredoc 본문의 > 는 allow지만 heredoc 뒤 줄 리다이렉션은 검사(본체 트리 deny)', () => {
  const r = guardToolUse('Bash',
    { command: 'cat > src/a.ts <<EOF\nx > y\nEOF\ncat > ../../../src/leak.js' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});
