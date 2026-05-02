#!/usr/bin/env node
'use strict';

// pact stop-verify hook
// 트리거: Stop — 메인 Claude 응답 종료 시
// 동작: 코드 변경 있으면 verify 권유. 강제 차단 X (사용자 흐름 방해 X).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) process.exit(0);

  // git status로 uncommitted 코드 변경 확인
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) process.exit(0);

  // 코드 변경 lines만 (문서·설정 제외)
  const lines = r.stdout.trim().split('\n');
  const codeChanges = lines.filter(l => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb)$/.test(l));
  if (codeChanges.length === 0) process.exit(0);

  // 알림만 (차단 X)
  const out = {
    systemMessage: `⚙️ uncommitted 코드 변경 ${codeChanges.length}개. /pact:verify 또는 /pact:parallel 진행 권장.`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main();
