#!/usr/bin/env node
// SDK preflight — `--real` 실행 전 1회 점검. 미충족이면 exit 4(설정 오류) + 안내.
// 실제 토큰 검증은 워커 1회 실행이 필요하므로 여기선 "설치/경로/인증 가능성"까지만 확인한다.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const problems = [];

// 1) Agent SDK 설치 확인 + 버전 노출 (버전 드리프트 시 옵션 키 재확인용)
// 주의: SDK 의 package.json "exports" 가 ./package.json 서브패스를 막으므로
// require('.../package.json') 는 ERR_PACKAGE_PATH_NOT_EXPORTED 로 실패한다.
// 설치 확인은 require.resolve(메인 entry), 버전은 fs 로 직접 읽는다.
let sdkVersion = null;
try {
  const main = require.resolve('@anthropic-ai/claude-agent-sdk');
  try {
    const i = main.indexOf('@anthropic-ai/claude-agent-sdk');
    const dir = main.slice(0, i + '@anthropic-ai/claude-agent-sdk'.length);
    sdkVersion = JSON.parse(require('fs').readFileSync(dir + '/package.json', 'utf8')).version;
  } catch { sdkVersion = 'installed (version unknown)'; }
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
