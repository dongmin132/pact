'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  matchesGlob,
  checkPath,
  readOwnership,
  countOwnershipParseErrors,
  detectWorktreeContext,
  isInsideWorktree,
  isBlockedLongSotRel,
  checkWorkerRead,
  checkBashWrite,
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

test('readOwnership — contracts/modules/*.md shard와 legacy 합집합 (ADR-018)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'MODULE_OWNERSHIP.md'), `## legacy
\`\`\`yaml
module: legacy
owner_paths:
  - src/legacy/**
\`\`\`
`);
    fs.mkdirSync(path.join(tmpDir, 'contracts/modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'contracts/modules/auth.md'), `## auth
\`\`\`yaml
module: auth
owner_paths:
  - src/auth/**
\`\`\`
`);
    fs.writeFileSync(path.join(tmpDir, 'contracts/modules/meetup.md'), `## meetup
\`\`\`yaml
module: meetup
owner_paths:
  - src/meetup/**
\`\`\`
`);

    const r = readOwnership(tmpDir);
    assert.deepEqual(r.sort(), [
      'src/auth/**',
      'src/legacy/**',
      'src/meetup/**',
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readOwnership — shard만 있고 legacy 없어도 동작', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'contracts/modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'contracts/modules/auth.md'), `\`\`\`yaml
module: auth
owner_paths:
  - src/auth/**
\`\`\`
`);
    const r = readOwnership(tmpDir);
    assert.deepEqual(r, ['src/auth/**']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── STAB-9: 손상 ownership fail-open 진단 ───

test('countOwnershipParseErrors — 손상 yaml은 parseErrors>0 + ownerCount 0', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    // duplicate key → yaml-mini throw → 블록 skip → owner_paths 0건
    fs.writeFileSync(path.join(tmpDir, 'MODULE_OWNERSHIP.md'), `## auth

\`\`\`yaml
module: auth
module: dup
owner_paths:
  - src/auth/**
\`\`\`
`);
    const diag = countOwnershipParseErrors(tmpDir);
    assert.equal(diag.sources, 1);
    assert.ok(diag.parseErrors > 0, `parseErrors=${diag.parseErrors}`);
    assert.equal(diag.ownerCount, 0);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('countOwnershipParseErrors — 정상 파일은 parseErrors 0 + ownerCount>0', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'MODULE_OWNERSHIP.md'), `## auth
\`\`\`yaml
module: auth
owner_paths:
  - src/auth/**
\`\`\`
`);
    const diag = countOwnershipParseErrors(tmpDir);
    assert.equal(diag.parseErrors, 0);
    assert.ok(diag.ownerCount > 0);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('countOwnershipParseErrors — 소스 없으면 sources 0', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-'));
  try {
    const diag = countOwnershipParseErrors(tmpDir);
    assert.equal(diag.sources, 0);
    assert.equal(diag.parseErrors, 0);
    assert.equal(diag.ownerCount, 0);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
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

test('isBlockedLongSotRel — legacy SOT와 긴 spec 원문 차단 대상', () => {
  assert.equal(isBlockedLongSotRel('TASKS.md'), true);
  assert.equal(isBlockedLongSotRel('API_CONTRACT.md'), true);
  assert.equal(isBlockedLongSotRel('DB_CONTRACT.md'), true);
  assert.equal(isBlockedLongSotRel('ARCHITECTURE.md'), true);
  assert.equal(isBlockedLongSotRel('DECISIONS.md'), true);
  assert.equal(isBlockedLongSotRel('docs/coffeechat_dev_spec.md'), true);
});

test('checkWorkerRead — ARCHITECTURE.md 통째 Read 차단 + rg/sed 안내', () => {
  const r = checkWorkerRead(
    'ARCHITECTURE.md',
    '/repo/.pact/worktrees/MEETUP-004',
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /rg|sed|섹션/);
});

test('checkWorkerRead — DECISIONS.md 통째 Read 차단', () => {
  const r = checkWorkerRead(
    'DECISIONS.md',
    '/repo/.pact/worktrees/MEETUP-004',
  );
  assert.equal(r.allowed, false);
});

test('isBlockedLongSotRel — shard/context-map/context bundle은 허용', () => {
  assert.equal(isBlockedLongSotRel('tasks/meetup.md'), false);
  assert.equal(isBlockedLongSotRel('contracts/api/meetup.md'), false);
  assert.equal(isBlockedLongSotRel('contracts/db/meetup.md'), false);
  assert.equal(isBlockedLongSotRel('contracts/modules/meetup.md'), false);
  assert.equal(isBlockedLongSotRel('docs/context-map.md'), false);
  assert.equal(isBlockedLongSotRel('.pact/runs/MEETUP-004/context.md'), false);
});

test('checkWorkerRead — 워커의 긴 SOT 원문 Read 차단', () => {
  const r = checkWorkerRead(
    'TASKS.md',
    '/repo/.pact/worktrees/MEETUP-004',
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /긴 SOT 원문/);
  assert.match(r.reason, /context\.md/);
});

test('checkWorkerRead — 워커의 shard Read 허용', () => {
  const r = checkWorkerRead(
    'tasks/meetup.md',
    '/repo/.pact/worktrees/MEETUP-004',
  );
  assert.equal(r.allowed, true);
});

test('checkWorkerRead — 메인 worktree에서는 Read 차단하지 않음', () => {
  const r = checkWorkerRead('TASKS.md', '/repo');
  assert.equal(r.allowed, true);
});

// --- Bash allowed_paths 우회 차단 (parallel hook 패리티, CLEANUP-029 회귀) ------

const WT = '/repo/.pact/worktrees/PROJ-001';

test('checkBashWrite — 범위 밖(워크트리 내) 리다이렉션 deny (029 패턴)', () => {
  const r = checkBashWrite('cat > docs/ui/cleanup-011-review.md <<EOF\nverdict\nEOF',
    { worktreeRoot: WT, allowedPaths: ['apps/mobile/components/meetup/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /allowed_paths/);
});

test('checkBashWrite — 범위 안이면 allow', () => {
  const r = checkBashWrite('cat > apps/mobile/components/meetup/X.tsx',
    { worktreeRoot: WT, allowedPaths: ['apps/mobile/components/meetup/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — /dev/null 은 쓰기 아님 (allow)', () => {
  const r = checkBashWrite('pnpm typecheck > /dev/null 2>&1', { worktreeRoot: WT, allowedPaths: ['apps/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — 워크트리 밖 .pact/runs(status.json) allow', () => {
  const r = checkBashWrite('cat > /repo/.pact/runs/PROJ-001/status.json <<EOF\n{}\nEOF',
    { worktreeRoot: WT, allowedPaths: ['apps/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — 따옴표 안 > 오탐 안 함', () => {
  const r = checkBashWrite('echo "a > b"', { worktreeRoot: WT, allowedPaths: ['apps/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — heredoc 본문 =>·> 오탐 안 함 (in-scope 코드)', () => {
  const r = checkBashWrite('cat > apps/a.ts <<EOF\nconst f = (x) => x > 1 ? a : b\nEOF',
    { worktreeRoot: WT, allowedPaths: ['apps/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — allowedPaths 없으면 검사 안 함 (allow)', () => {
  const r = checkBashWrite('cat > docs/x.md', { worktreeRoot: WT, allowedPaths: [] });
  assert.equal(r.allowed, true);
});

// --- STAB-4: worktree 경계 밖 쓰기 경계 분류 ---

test('checkBashWrite — 형제 worktree(../OTHER-1) 쓰기 deny', () => {
  const r = checkBashWrite('echo x > ../OTHER-1/src/f.js',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /worktree/);
});

test('checkBashWrite — 본체 트리(worktree 밖, repoRoot 아래) 쓰기 deny', () => {
  const r = checkBashWrite('cat > ../../../src/leak.js',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /본체 트리|worktree 밖/);
});

test('checkBashWrite — 레포 밖(홈, ~/.zshrc) 쓰기 deny', () => {
  const r = checkBashWrite('cat > ~/.zshrc',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — /tmp 절대경로 쓰기 allow (임시파일 회귀 방지)', () => {
  const r = checkBashWrite('echo x > /tmp/pact-x',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — heredoc 본문 뒤 줄 리다이렉션은 검사 (본문 > 는 스킵)', () => {
  // line0: 자기 worktree 내 in-scope 쓰기, heredoc body 의 > 는 스킵,
  // heredoc 종료 후 줄의 형제 WT 탈출은 잡힌다.
  const r = checkBashWrite('cat > src/a.ts <<EOF\nconst x = a > b\nEOF\ncat > ../OTHER-2/x.js',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /worktree/);
});

// --- hook main() 통합: parallel 워커 Bash 쓰기를 실제로 deny 하는지 (stdin 호출) ---

const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-guard.js');
function runHook(payload) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
}
function makeWtRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-bash-'));
  const wt = path.join(repo, '.pact/worktrees/PROJ-001');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(repo, '.pact/runs/PROJ-001'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.pact/runs/PROJ-001/payload.json'),
    JSON.stringify({ task_id: 'PROJ-001', allowed_paths: ['apps/**'] }));
  return { repo, wt };
}

test('hook 통합 — parallel 워커가 Bash로 범위 밖 쓰기 시 deny (parallel 보호 실증)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'cat > docs/ui/review.md <<EOF\nx\nEOF' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
    assert.match(r.stdout, /allowed_paths/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 범위 안 Bash 쓰기는 통과 (빈 출력)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo hi > apps/log.txt' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /deny/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 워커가 형제 worktree(../OTHER-1)로 Bash 쓰기 시 deny (STAB-4)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo x > ../OTHER-1/src/f.js' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
    assert.match(r.stdout, /worktree/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- STAB-9: 손상 ownership → 비차단 경고 (조용한 fail-open 방지, 차단은 안 함) ---

test('hook 통합 — 손상 MODULE_OWNERSHIP는 경고만 표면화하고 차단 안 함 (STAB-9)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-own-'));
  try {
    fs.writeFileSync(path.join(repo, 'MODULE_OWNERSHIP.md'), `## auth

\`\`\`yaml
module: auth
module: dup
owner_paths:
  - src/auth/**
\`\`\`
`);
    const r = runHook({ tool_name: 'Write', tool_input: { file_path: 'src/auth/login.ts' }, cwd: repo });
    assert.equal(r.status, 0, r.stderr);
    // 차단은 안 함
    assert.doesNotMatch(r.stdout, /deny/);
    // 경고 신호가 stdout(systemMessage) 또는 stderr 에 표면화
    const surfaced = r.stdout + r.stderr;
    assert.match(surfaced, /MODULE_OWNERSHIP|fail-open|파싱|owner_paths/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 정상 ownership + 소유 경로 편집은 경고/차단 없음 (STAB-9 회귀)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-own-'));
  try {
    fs.writeFileSync(path.join(repo, 'MODULE_OWNERSHIP.md'), `## auth
\`\`\`yaml
module: auth
owner_paths:
  - src/auth/**
\`\`\`
`);
    const r = runHook({ tool_name: 'Write', tool_input: { file_path: 'src/auth/login.ts' }, cwd: repo });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /deny/);
    assert.doesNotMatch(r.stdout + r.stderr, /fail-open/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 정상 ownership + 비소유 경로 편집은 여전히 deny (STAB-9 회귀)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-own-'));
  try {
    fs.writeFileSync(path.join(repo, 'MODULE_OWNERSHIP.md'), `## auth
\`\`\`yaml
module: auth
owner_paths:
  - src/api/**
\`\`\`
`);
    const r = runHook({ tool_name: 'Write', tool_input: { file_path: 'src/components/x.ts' }, cwd: repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
    assert.match(r.stdout, /MODULE_OWNERSHIP/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
