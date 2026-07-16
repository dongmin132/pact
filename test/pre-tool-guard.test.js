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

test('checkBashWrite — here-string(<<<)은 heredoc 오프너 아님 → 다음 줄 탈출 검사 (LG-2)', () => {
  // `<<< "EOF"` here-string 을 heredoc 오프너로 오탐하면 다음 줄이 본문으로 스킵돼
  // 경계 밖 쓰기가 fail-open 된다. here-string 은 본문이 없으므로 다음 줄을 검사해야 한다.
  const r = checkBashWrite('grep x <<< "EOF"\necho x > ~/.zshrc',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — 정상 heredoc(<<EOF) 은 여전히 본문 스킵 (회귀)', () => {
  // 진짜 heredoc 은 본문 안 > 를 오탐하면 안 된다(LG-2 fix 가 정상 경로를 깨지 않는지).
  const r = checkBashWrite('cat > src/a.ts <<EOF\necho leak > ~/.zshrc\nEOF',
    { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

// --- P1-#4: 리다이렉션이 아닌 "인자로 파일을 쓰는" 명령(cp/mv/install/sed -i/dd/ln) 경계 ---
// 구코드는 리다이렉션만 추출해 cp/mv/sed -i 목적지가 안 잡혀 홈·형제 worktree 손상이 통과됐다.

test('checkBashWrite — cp 로 홈(~/.zshrc) 쓰기 deny (P1-#4)', () => {
  const r = checkBashWrite('cp /tmp/x ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — mv 로 형제 worktree(../OTHER-2) 쓰기 deny (P1-#4)', () => {
  const r = checkBashWrite('mv /tmp/x ../OTHER-2/pwned', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /worktree/);
});

test('checkBashWrite — sed -i 로 홈 쓰기 deny (P1-#4)', () => {
  const r = checkBashWrite('sed -i s/x/y/ ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — sed --in-place 로 홈 쓰기 deny (P1-#4)', () => {
  const r = checkBashWrite("sed --in-place 's/a/b/' ~/.zshrc", { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — install 로 홈 쓰기 deny (값 플래그 -m 처리, P1-#4)', () => {
  const r = checkBashWrite('install -m 0755 /tmp/x ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — dd of= 로 홈 쓰기 deny (P1-#4)', () => {
  const r = checkBashWrite('dd if=/tmp/x of=~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — ln -sf 로 홈 심링크 생성 deny (P1-#4)', () => {
  const r = checkBashWrite('ln -sf /tmp/evil ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — cp -t DIR 목적지 디렉터리도 경계 검사 (P1-#4)', () => {
  const r = checkBashWrite('cp -t ~/ /tmp/x', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — && 로 이어진 cp 홈 탈출도 세그먼트 검사 (P1-#4)', () => {
  const r = checkBashWrite('echo hi && cp /tmp/x ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — cp 목적지가 워크트리 안 in-scope 면 allow (P1-#4 회귀)', () => {
  const r = checkBashWrite('cp src/a.ts src/b.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — mv 목적지가 /tmp 면 allow (임시파일, P1-#4 회귀)', () => {
  const r = checkBashWrite('mv build/x /tmp/y', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — sed -i 가 in-scope 파일이면 allow (P1-#4 회귀)', () => {
  const r = checkBashWrite("sed -i 's/a/b/' src/a.ts", { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — sed -n(비 in-place) 은 파일 쓰기 아님 → allow (P1-#4 회귀)', () => {
  const r = checkBashWrite("sed -n '1,5p' DECISIONS.md", { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — npm install·git mv 서브커맨드는 cp/mv 오탐 안 함 (P1-#4 회귀)', () => {
  assert.equal(checkBashWrite('npm install', { worktreeRoot: WT, allowedPaths: ['src/**'] }).allowed, true);
  assert.equal(checkBashWrite('git mv src/a.ts src/b.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] }).allowed, true);
});

// --- P1-#4 잔여(적대 검증): cp/mv/sed 파서 미봉 3종 ---
// (1) 별도인자 없는 플래그(--backup/-Z/--context)가 소스 토큰 과소비 → dest 미검사 우회
// (2) 번들 short -ft(=-f -t) target-dir 미인식 → 홈 target-dir 우회
// (3) BSD/macOS sed -i .bak(분리 suffix) 과차단 → 정상 in-scope 편집 오차단

test('checkBashWrite — cp --backup 가 소스 과소비 없이 홈 dest deny (잔여1)', () => {
  const r = checkBashWrite('cp --backup /tmp/x ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — cp -Z(별도인자 없음) 홈 dest deny (잔여1)', () => {
  const r = checkBashWrite('cp -Z /tmp/x ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — mv --backup 홈 dest deny (잔여1)', () => {
  const r = checkBashWrite('mv --backup /tmp/x ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — cp --backup 워크트리 내 allowed_paths 밖 우회 deny (잔여1)', () => {
  const r = checkBashWrite('cp --backup /tmp/x forbidden/secret.js', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /allowed_paths/);
});

test('checkBashWrite — cp -ft ~/ (번들 target-dir) 홈 쓰기 deny (잔여2)', () => {
  const r = checkBashWrite('cp -ft ~/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — sed -i .bak(macOS BSD 분리 suffix) in-scope 편집 allow (잔여3 과차단)', () => {
  const r = checkBashWrite("sed -i .bak 's/a/b/' src/a.ts", { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
});

test('checkBashWrite — sed -i .bak 라도 홈 편집은 여전히 deny (잔여3, fail-open 아님)', () => {
  const r = checkBashWrite('sed -i .bak s/x/y/ ~/.zshrc', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

// --- P1-#4 잔여(2차 적대 재검증): 부착/번들 short target-directory ---
// getopt 는 arg-요구 옵션 t 뒤 클러스터 나머지를 값으로 취급 → `-tDIR`·`-ftDIR` 는 target-directory.
// 1차 수리는 분리형(-t DIR)·번들 분리형(-ft DIR)·= 롱(--target-directory=DIR)만 잡고
// 부착형(-t<DIR>, -X...t<DIR>)을 놓쳐 절대경로·형제 worktree 탈출이 fail-open 됐다.

test('checkBashWrite — cp -t<abs> 부착 target-dir 레포 밖 탈출 deny (잔여4)', () => {
  const r = checkBashWrite('cp -t/Users/victim/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — cp -ft<abs> 번들 부착 target-dir deny (잔여4)', () => {
  const r = checkBashWrite('cp -ft/Users/victim/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('checkBashWrite — cp -avt<abs> 다중 클러스터 부착 target-dir deny (잔여4)', () => {
  const r = checkBashWrite('cp -avt/Users/victim/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — mv -t<abs> 부착 target-dir deny (잔여4)', () => {
  const r = checkBashWrite('mv -t/Users/victim/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — install -Dt<abs> 부착 target-dir deny (잔여4)', () => {
  const r = checkBashWrite('install -Dt/Users/victim/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
});

test('checkBashWrite — cp -t<형제WT> 부착 형제 worktree 탈출 deny (잔여4)', () => {
  const r = checkBashWrite('cp -t../OTHER-9/ src/a.ts', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /worktree/);
});

test('checkBashWrite — 부착형 t 없는 다중 플래그 cp 는 오탐 안 함 (잔여4 회귀)', () => {
  // -rv 클러스터는 t 를 포함하지 않으니 target-dir 로 오인해선 안 된다 (마지막 positional=dest).
  const r = checkBashWrite('cp -rv src/a src/b', { worktreeRoot: WT, allowedPaths: ['src/**'] });
  assert.equal(r.allowed, true);
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

test('hook 통합 — 워커가 cp 로 형제 worktree(../OTHER-1) 쓰기 시 deny (P1-#4)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'cp /tmp/x ../OTHER-1/src/f.js' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
    assert.match(r.stdout, /worktree/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 워커가 sed -i 로 홈(~/.zshrc) 쓰기 시 deny (P1-#4)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'sed -i s/x/y/ ~/.zshrc' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- H5: 인터랙티브 hook 도 워크트리 밖 rm 삭제를 boundary 로 deny (rm 이 checkBashWrite 밖이던 구멍) ---

test('hook 통합 — 워커가 rm 으로 형제 worktree(../OTHER-1) 삭제 시 deny (H5)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm ../OTHER-1/src/f.js' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
    assert.match(r.stdout, /worktree|삭제/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 워커가 rm -rf 로 홈 삭제 시 deny (H5)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~/.ssh' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deny/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook 통합 — 워크트리 내 rm(격리)은 통과 (H5 회귀 방지)', () => {
  const { repo, wt } = makeWtRepo();
  try {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm apps/stale.log' }, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /deny/);
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

test('hook 통합 — ownership 정의돼도 메인 세션의 PROGRESS.md 편집은 허용 (M11 /pact:wrap 충돌 해소)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-hook-own-'));
  try {
    fs.writeFileSync(path.join(repo, 'MODULE_OWNERSHIP.md'),
      '## auth\n\n```yaml\nmodule: auth\nowner_paths:\n  - src/auth/**\n```\n');
    for (const doc of ['PROGRESS.md', 'DECISIONS.md', 'tasks/auth.md', 'docs/x.md']) {
      const r = runHook({ tool_name: 'Edit', tool_input: { file_path: doc }, cwd: repo });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /deny/, `${doc} 편집은 ownership 에 막히면 안 됨`);
    }
    // 반면 ownership 밖의 실제 코드 파일은 여전히 deny
    const code = runHook({ tool_name: 'Edit', tool_input: { file_path: 'src/other/x.ts' }, cwd: repo });
    assert.match(code.stdout, /deny/, '모듈 밖 코드 파일은 여전히 차단');
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
