#!/usr/bin/env node
'use strict';

// pact stop-verify hook
// 트리거: Stop — 메인 Claude 응답 종료 시 (async, 차단 X)
// 동작:
//   1. 코드 변경 있으면 verify 권유
//   2. 코드 변경은 있는데 contracts/PROGRESS 변경 0개면 "문서 표류 가능" 별도 알림

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CODE_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|cpp|c|swift|cs|php)$/;
const DOCS_RE = /^(contracts\/|PROGRESS\.md$|MODULE_OWNERSHIP\.md$|API_CONTRACT\.md$|DB_CONTRACT\.md$|tasks\/)/;

/** git status --porcelain 출력에서 경로 추출 ("XY path" 형식). */
function extractPath(line) {
  // porcelain: 2글자 status + 공백 + 경로. rename은 "A -> B"라 마지막만.
  const m = line.match(/^.{2,3}\s+(.+?)(?:\s->\s(.+))?$/);
  if (!m) return null;
  return m[2] || m[1];
}

/**
 * git status 출력에서 코드/문서 변경 카운트.
 * @returns {{codeChanges: number, docsChanges: number, codeFiles: string[]}}
 */
function classifyChanges(porcelainOutput) {
  // trim()은 라인 시작 공백(porcelain의 'XY' status 첫 글자)을 깎으므로 X.
  // split + filter(Boolean)으로 빈 줄만 제거.
  const lines = porcelainOutput.split('\n').filter(Boolean);
  let codeChanges = 0;
  let docsChanges = 0;
  const codeFiles = [];
  for (const line of lines) {
    const p = extractPath(line);
    if (!p) continue;
    if (CODE_RE.test(p)) {
      codeChanges++;
      codeFiles.push(p);
    } else if (DOCS_RE.test(p)) {
      docsChanges++;
    }
  }
  return { codeChanges, docsChanges, codeFiles };
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) process.exit(0);

  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) process.exit(0);

  const { codeChanges, docsChanges } = classifyChanges(r.stdout);
  if (codeChanges === 0) process.exit(0);

  let msg = `⚙️ uncommitted 코드 변경 ${codeChanges}개. /pact:verify 또는 /pact:parallel 진행 권장.`;
  if (docsChanges === 0) {
    msg += `\n📝 contracts/PROGRESS 변경 0개 — 문서 표류 가능. /pact:reflect 또는 직접 갱신 검토.`;
  }

  const out = { systemMessage: msg };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

module.exports = { classifyChanges, extractPath, CODE_RE, DOCS_RE };

if (require.main === module) main();
