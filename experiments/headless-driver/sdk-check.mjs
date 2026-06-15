#!/usr/bin/env node
// SDK preflight — `--real` 실행 전 1회 점검. 미충족이면 exit 4(설정 오류) + 안내.
// 실제 토큰 검증은 워커 1회 실행이 필요하므로 여기선 "설치/경로/인증 가능성"까지만 확인한다.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const problems = [];

// 1) Agent SDK 설치 확인 + 버전 노출 (버전 드리프트 시 옵션 키 재확인용)
let sdkVersion = null;
try {
  sdkVersion = require('@anthropic-ai/claude-agent-sdk/package.json').version;
} catch {
  problems.push('@anthropic-ai/claude-agent-sdk 미설치 → cd experiments/headless-driver && npm i @anthropic-ai/claude-agent-sdk');
}

// 2) claude CLI 확인 (SDK가 내부적으로 사용 + 인증 매개)
let claudeVersion = null;
try {
  claudeVersion = execSync('claude --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  problems.push('claude CLI 미설치/PATH 없음 → Claude Code 설치 후 `claude` 로그인 필요');
}

const ok = problems.length === 0;
process.stdout.write(JSON.stringify({ ok, sdkVersion, claudeVersion, problems }, null, 2) + '\n');
if (!ok) {
  process.stderr.write('\n[sdk-check] --real 불가. 위 problems 해결 후 재시도.\n');
}
process.exit(ok ? 0 : 4);
