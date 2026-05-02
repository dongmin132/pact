#!/usr/bin/env node
'use strict';

// pact post-edit-doc-sync hook
// 트리거: PostToolUse (Write/Edit) — 차단 불가, 알림만
// 동작: 코드 변경 시 PROGRESS.md/ARCHITECTURE.md 갱신 필요성 알림

const fs = require('fs');
const path = require('path');

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const tool = payload.tool_name;
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) process.exit(0);

  const filePath = payload.tool_input && payload.tool_input.file_path;
  if (!filePath) process.exit(0);

  // 코드 파일만 — 문서·설정은 제외
  const codeExts = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|cpp|c|h|swift|cs|php)$/;
  if (!codeExts.test(filePath)) process.exit(0);

  // PROGRESS.md / ARCHITECTURE.md 존재 확인
  const cwd = payload.cwd || process.cwd();
  const progress = path.join(cwd, 'PROGRESS.md');
  const arch = path.join(cwd, 'ARCHITECTURE.md');
  if (!fs.existsSync(progress) && !fs.existsSync(arch)) process.exit(0);

  // systemMessage로 가벼운 알림 (차단 X)
  const out = {
    systemMessage: `📝 코드 변경 감지: ${filePath}. cycle 종료 시 PROGRESS.md / ARCHITECTURE.md 갱신 필요한지 확인하세요.`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main();
