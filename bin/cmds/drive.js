'use strict';

// pact drive — 헤드리스 멀티사이클 드라이버의 1급 CLI 런처.
//
// 인터랙티브 /pact:parallel 은 메인 LLM 이 오케스트레이터라 워커 복귀마다 컨텍스트를
// 재독해 토큰 세금(~190M)을 문다. pact drive 는 그 루프를 결정적 스크립트로 돌려
// 오케스트레이션 토큰을 0 으로 만들고, 워커만 Claude Agent SDK 로 헤드리스 spawn 한다.
//
// 구현(driver.mjs)은 ESM + Agent SDK 의존이라 별도 프로세스로 실행한다. 이 런처는 CJS.
// SDK 는 pact 의 필수 의존이 아니다(opt-in) — --real 일 때만 설치 확인.

const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const DRIVER = path.join(PLUGIN_ROOT, 'experiments', 'headless-driver', 'driver.mjs');
const DRIVER_DIR = path.dirname(DRIVER);

function sdkInstalled() {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [DRIVER_DIR] });
    return true;
  } catch {
    return false;
  }
}

const HELP = [
  'pact drive — 헤드리스 멀티사이클 드라이버 (오케스트레이터 토큰 0)',
  '',
  '인터랙티브 /pact:parallel 은 메인 LLM 이 오케스트레이터라 워커 복귀마다 컨텍스트를 재독해',
  '토큰 세금을 문다. pact drive 는 그 루프를 결정적 스크립트로 돌려 오케스트레이션 토큰을 0 으로',
  '만들고 워커만 SDK 로 헤드리스 spawn 한다. (사실 보고는 collect 가, 자연어는 필요할 때만.)',
  '',
  '사용법: pact drive [옵션]',
  '  (옵션 없으면 mock+demo — 토큰 0, 루프/안전장치만 확인)',
  '',
  '  --real          실제 Agent SDK 로 워커 spawn (SDK 설치 + claude 로그인 필요)',
  '  --pact          pact run-cycle prepare/collect 연동 (현 디렉토리 = pact 프로젝트)',
  '  --max=N         사이클당 워커 수 (기본 3)',
  '  --cycles=N      사이클 반복 (기본 1)',
  '  --model=NAME    워커 모델 (기본 sonnet)',
  '  --budget=USD    누적 비용 상한 — 넘으면 정지 (기본 10)',
  '  --timeout=SEC   워커 hang 백스톱 (기본 1200 — 작업 안 자름, 진짜 cap 은 budget)',
  '  (loop task) loop_until.count 가 0 될 때까지 fresh 워커 재투입, 정체·cap·budget 시 위임',
  '',
  '예) pact drive                        # 무료 데모(mock)',
  '    pact drive --real --max=1            # 실제 워커 1개 (SDK 통합 확인)',
  '    pact drive --real --pact --max=2     # 실제 무인 사이클 (테스트 pact 프로젝트에서)',
  '',
  '종료코드: 0 정상 / 3 위임·정지(사람 개입 필요) / 4 설정오류(SDK 미설치 등)',
  '',
].join('\n');

module.exports = function drive(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  // --real 인데 SDK 미설치면 친절히 안내 후 종료(설정 오류 4). SDK 는 opt-in 의존.
  if (args.includes('--real') && !sdkInstalled()) {
    process.stderr.write(
      'pact drive --real 에는 Claude Agent SDK 가 필요합니다(opt-in 의존).\n' +
      `  설치: (cd ${DRIVER_DIR} && npm i @anthropic-ai/claude-agent-sdk)\n` +
      `  점검: node ${path.join(DRIVER_DIR, 'sdk-check.mjs')}\n`,
    );
    process.exitCode = 4;
    return;
  }

  // 드라이버를 별도 프로세스로 실행. cwd 는 사용자 프로젝트(=현재 디렉토리).
  const r = spawnSync('node', [DRIVER, ...args], { cwd: process.cwd(), stdio: 'inherit' });
  process.exitCode = (r.status == null) ? 1 : r.status;
};
