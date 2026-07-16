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

// --- H5: rm -rf 동등 변형이 정적 차단을 우회하던 구멍 봉쇄 (플래그 순서·철자 무관) ---

for (const cmd of [
  'rm -fr /tmp/x',
  'rm -r -f build',
  'rm -Rf dist',
  'rm --recursive --force node_modules',
  'rm -rf ../sibling',
  'find . -delete',
  "find . -name '*.log' -exec rm {} \\;",
  'sudo rm -fr /',
]) {
  test(`Bash — 파괴 삭제 변형 deny: ${cmd}`, () => {
    const r = guardToolUse('Bash', { command: cmd }, { workingDir: WD, allowedPaths: ['**'] });
    assert.equal(r.allow, false, `"${cmd}" 는 차단돼야 함`);
  });
}

test('Bash — 워크트리 밖(형제 WT) 단순 rm 삭제도 boundary 로 deny', () => {
  const r = guardToolUse('Bash', { command: 'rm ../OTHER-1/src/f.js' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /worktree|삭제|밖/);
});

test('Bash — 홈 디렉토리 파일 rm 삭제도 deny', () => {
  const r = guardToolUse('Bash', { command: 'rm ~/.ssh/id_rsa' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — 워크트리 내 단순 rm(격리, diff 로 드러남)은 allow (회귀 방지)', () => {
  const r = guardToolUse('Bash', { command: 'rm src/foo.ts' },
    { workingDir: WD, allowedPaths: ['src/**'] });
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

// --- P1-#4: 인자로 파일을 쓰는 명령(cp/mv/install/sed -i/ln) 경계 (리다이렉션만 보던 구멍) ---
// dd·sudo 는 worker-guard DESTRUCTIVE 로 이미 전면 차단되므로 여기선 cp/mv/sed 계열을 확인.

test('Bash — cp 로 홈(~/.zshrc) 쓰기면 deny (P1-#4)', () => {
  const r = guardToolUse('Bash', { command: 'cp /tmp/x ~/.zshrc' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /레포 밖|홈/);
});

test('Bash — mv 로 형제 worktree(../OTHER-2) 쓰기면 deny (P1-#4)', () => {
  const r = guardToolUse('Bash', { command: 'mv /tmp/x ../OTHER-2/pwned' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /worktree/);
});

test('Bash — sed -i 로 홈 쓰기면 deny (P1-#4)', () => {
  const r = guardToolUse('Bash', { command: 'sed -i s/x/y/ ~/.zshrc' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — install 로 홈 쓰기면 deny (P1-#4)', () => {
  const r = guardToolUse('Bash', { command: 'install -m 0755 /tmp/x ~/.zshrc' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — ln -sf 로 홈 심링크 생성이면 deny (P1-#4)', () => {
  const r = guardToolUse('Bash', { command: 'ln -sf /tmp/evil ~/.zshrc' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — cp/mv/sed -i 목적지가 in-scope 면 allow (P1-#4 회귀)', () => {
  assert.equal(guardToolUse('Bash', { command: 'cp src/a.ts src/b.ts' },
    { workingDir: WD, allowedPaths: ['src/**'] }).allow, true);
  assert.equal(guardToolUse('Bash', { command: 'mv build/x /tmp/y' },
    { workingDir: WD, allowedPaths: ['src/**'] }).allow, true);
  assert.equal(guardToolUse('Bash', { command: "sed -i 's/a/b/' src/a.ts" },
    { workingDir: WD, allowedPaths: ['src/**'] }).allow, true);
});

test('Bash — npm install·git mv 서브커맨드는 cp/mv 오탐 안 함 (P1-#4 회귀)', () => {
  assert.equal(guardToolUse('Bash', { command: 'npm install' },
    { workingDir: WD, allowedPaths: ['src/**'] }).allow, true);
  assert.equal(guardToolUse('Bash', { command: 'git mv src/a.ts src/b.ts' },
    { workingDir: WD, allowedPaths: ['src/**'] }).allow, true);
});

// --- P1-#4 잔여(적대 검증): cp/mv/sed 파서 미봉 3종 (단일 소스 checkBashWrite 재확인) ---

test('Bash — cp --backup 가 소스 과소비 없이 홈 dest deny (잔여1)', () => {
  const r = guardToolUse('Bash', { command: 'cp --backup /tmp/x ~/.zshrc' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — cp -ft ~/ (번들 target-dir) 홈 쓰기 deny (잔여2)', () => {
  const r = guardToolUse('Bash', { command: 'cp -ft ~/ src/a.ts' },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, false);
});

test('Bash — sed -i .bak(macOS BSD 분리 suffix) in-scope 편집 allow (잔여3 과차단)', () => {
  const r = guardToolUse('Bash', { command: "sed -i .bak 's/a/b/' src/a.ts" },
    { workingDir: WD, allowedPaths: ['src/**'] });
  assert.equal(r.allow, true);
});

// ─── dogfood #9: 워커의 서브에이전트 spawn 차단 ────────────────────────────
// 라이브 실측: 도구가 전부 거부되자 워커가 Agent 도구로 서브에이전트를 spawn 시도.
// 워커는 일회용 단일 task 실행자(ARCHITECTURE §14.2 nesting 금지) — 서브에이전트는
// 가드·예산 통제 밖 비용 폭주 벡터다. SDK 경로의 단일 관문인 worker-guard 가 deny.
test('guardToolUse — Agent/Task(서브에이전트 spawn)는 deny', () => {
  for (const tool of ['Agent', 'Task']) {
    const r = guardToolUse(tool, { prompt: 'x' }, { workingDir: '/tmp/wt', allowedPaths: ['**'] });
    assert.equal(r.allow, false, `${tool} 은 워커에서 금지`);
    assert.match(r.reason || '', /서브에이전트|중첩|spawn/);
  }
});

test('guardToolUse — 미지 무해 도구(TodoWrite 등)는 여전히 allow (기본 fail-open 유지)', () => {
  const r = guardToolUse('TodoWrite', { todos: [] }, { workingDir: '/tmp/wt', allowedPaths: ['**'] });
  assert.equal(r.allow, true);
});

// ─── dogfood #11: 워커 자기 보고영역(.pact/runs/<id>/) Write 허용 ────────────
// status.json 은 종료 프로토콜인데 worktree 밖이라 Write 분기가 거부 → 워커가
// 보고 직전에 사망(라이브 실측: LC-001 3세대 전멸, stop_reason=tool_use).
// checkBashWrite 는 자기 runs 를 allow 하는데 Write 분기만 비대칭이던 구멍
// (headless-driver 메모리의 latent edge 가 shadow 제거로 실현된 것).
test('guardToolUse — 자기 .pact/runs/<task_id>/ 쓰기(Write/Edit)는 allow (보고 프로토콜)', () => {
  const wd = '/repo/.pact/worktrees/LC-001';
  for (const f of ['status.json', 'report.md']) {
    const r = guardToolUse('Write', { file_path: `/repo/.pact/runs/LC-001/${f}`, content: '{}' }, { workingDir: wd, allowedPaths: ['src/**'] });
    assert.equal(r.allow, true, `자기 runs/${f} 는 허용: ${r.reason || ''}`);
  }
});

test('guardToolUse — 다른 task 의 runs 나 그 밖 worktree 밖 쓰기는 여전히 deny', () => {
  const wd = '/repo/.pact/worktrees/LC-001';
  const other = guardToolUse('Write', { file_path: '/repo/.pact/runs/LC-002/status.json', content: '{}' }, { workingDir: wd, allowedPaths: ['src/**'] });
  assert.equal(other.allow, false, '남의 보고영역 위조 금지');
  const outside = guardToolUse('Write', { file_path: '/repo/src/evil.js', content: 'x' }, { workingDir: wd, allowedPaths: ['src/**'] });
  assert.equal(outside.allow, false, '본체 트리 쓰기 금지 유지');
});
