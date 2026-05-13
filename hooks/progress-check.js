#!/usr/bin/env node
'use strict';

// pact progress-check hook
// 트리거: SessionEnd — 차단 불가, 알림만
// 동작: PROGRESS.md mtime이 오래됐고 코드는 수정됐으면 사용자에게 갱신 권장

const fs = require('fs');
const path = require('path');

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();

  // 멀티세션 lock 정리 (v0.6.0) — 죽은 PID 잡은 lock 일괄 해제.
  // Claude Code 세션 종료 시 그 세션의 자식 PID(pact claim 한 프로세스)도 회수되었을 것.
  try {
    const { cleanStaleLocks } = require(path.join(__dirname, '..', 'scripts', 'lock.js'));
    cleanStaleLocks({ cwd });
  } catch { /* lock.js 없거나 .pact 미초기화 — skip */ }

  const progressFile = path.join(cwd, 'PROGRESS.md');
  if (!fs.existsSync(progressFile)) process.exit(0);

  const progressMtime = fs.statSync(progressFile).mtimeMs;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  if (progressMtime > oneHourAgo) process.exit(0);  // 최근에 갱신됨

  // 코드 mtime 비교 — 이번 세션 동안 수정된 파일이 있나
  // 단순 휴리스틱: src/ 디렉토리 mtime이 PROGRESS.md보다 새것이면 OK 신호
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) process.exit(0);

  const srcMtime = fs.statSync(srcDir).mtimeMs;
  if (srcMtime <= progressMtime) process.exit(0);

  const out = {
    systemMessage: `📊 PROGRESS.md가 코드 변경보다 오래됐습니다. 다음 세션 시작 전 /pact:status로 확인하거나 직접 갱신하세요.`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main();
