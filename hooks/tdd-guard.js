#!/usr/bin/env node
'use strict';

// pact tdd-guard hook (TDD Guard 패턴 영감 — nizos/tdd-guard)
//
// 트리거: PreToolUse on Write
// 동작: 워커 worktree 안에서 tdd:true task가 코드 파일 신규 작성 시도 중인데
//       대응 테스트 파일이 worktree에 없으면 차단.
//
// 워커 worktree만 적용 (메인 repo 제외) — cwd가 .pact/worktrees/<id>/ 안일 때만.
// payload.json에서 task의 tdd 필드 read.

const fs = require('fs');
const path = require('path');

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.py$/,
  /_test\.go$/,
  /_spec\.rb$/,
  /Test\.java$/,
];

const CODE_EXTS = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|cpp|c|swift|cs|php)$/;

function isTestFile(filePath) {
  return TEST_PATTERNS.some(re => re.test(filePath));
}

function isCodeFile(filePath) {
  return CODE_EXTS.test(filePath) && !isTestFile(filePath);
}

/** 워커 worktree 안인지 + task_id 추출 */
function detectWorktreeContext(cwd) {
  const m = /\.pact\/worktrees\/([A-Z][A-Z0-9]*-\d+)(\/|$)/.exec(cwd);
  if (!m) return null;

  // worktree 루트 = cwd에서 task_id 폴더까지의 경로
  const idx = cwd.indexOf(`.pact/worktrees/${m[1]}`);
  const worktreeRoot = cwd.slice(0, idx + `.pact/worktrees/${m[1]}`.length);

  // 메인 repo의 .pact/runs/<id>/payload.json 위치
  // worktree 루트의 부모(메인 repo)에서 payload.json 찾기
  const repoRoot = cwd.slice(0, idx);
  const payloadPath = path.join(repoRoot, '.pact', 'runs', m[1], 'payload.json');

  return { task_id: m[1], worktreeRoot, payloadPath };
}

function loadTaskMetadata(payloadPath) {
  if (!fs.existsSync(payloadPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  } catch {
    return null;
  }
}

/** 코드 파일에 대응하는 테스트 파일이 worktree 안에 존재하는가 */
function hasCorrespondingTest(codePath, worktreeRoot) {
  const ext = path.extname(codePath);
  const base = codePath.slice(0, -ext.length);
  const candidates = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
    `${base}_test${ext}`,
  ];
  // 같은 디렉토리 + ../tests/ 같은 곳도 검색 (간단 휴리스틱)
  const dir = path.dirname(codePath);
  const fileName = path.basename(base);
  candidates.push(
    path.join(dir, '__tests__', `${fileName}${ext}`),
    path.join(dir, '__tests__', `${fileName}.test${ext}`),
  );

  return candidates.some(c => {
    const abs = path.isAbsolute(c) ? c : path.join(worktreeRoot, c);
    return fs.existsSync(abs);
  });
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  if (payload.tool_name !== 'Write') process.exit(0);

  const filePath = payload.tool_input && payload.tool_input.file_path;
  if (!filePath || !isCodeFile(filePath)) process.exit(0);

  // 이미 존재하는 파일이면 OK (수정은 Edit, 신규 Write만 검사)
  const cwd = payload.cwd || process.cwd();
  const absFile = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (fs.existsSync(absFile)) process.exit(0);

  // 워커 worktree 컨텍스트인가
  const wt = detectWorktreeContext(cwd);
  if (!wt) process.exit(0);  // 메인 repo면 적용 X

  const meta = loadTaskMetadata(wt.payloadPath);
  if (!meta || !meta.tdd) process.exit(0);  // tdd:false거나 메타 없음 → 통과

  // tdd:true인데 코드 파일 신규 작성 → 테스트 존재 검증
  const relCode = path.relative(wt.worktreeRoot, absFile);
  if (hasCorrespondingTest(relCode, wt.worktreeRoot)) process.exit(0);

  // 차단
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `pact TDD Guard: ${wt.task_id}는 tdd:true인데 ${relCode}에 대응하는 테스트 파일이 없습니다. ` +
        `RED 단계: 실패 테스트 먼저 작성하세요. ` +
        `(예: ${relCode.replace(CODE_EXTS, '.test$&')})`,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

module.exports = { isTestFile, isCodeFile, detectWorktreeContext, hasCorrespondingTest };

if (require.main === module) main();
