'use strict';

// pact testguard — test-as-law 정적 체크 (propose-only, read-only)
// 워커가 자기 판정 테스트를 약화 못 하게: 구현+자기검증 테스트를 같은 task가
// 소유하는 경우를 플래그하고 분리를 제안한다.

const path = require('path');
const { readTasks } = require('../../scripts/metrics/collect.js');
const { assessTestGuard, formatHuman, formatJson } = require('../../scripts/testguard.js');

const HELP = [
  'pact testguard — test-as-law (propose-only)',
  '',
  '구현과 자기검증 테스트를 같은 task가 소유하면 플래그 → 테스트 분리 제안.',
  '"테스트 통과 안 하면 머지 불가"를 워커가 우회 못 하게.',
  '',
  '사용법: pact testguard [옵션]',
  '  --project <path>   대상 (기본: 현재 디렉토리)',
  '  --json             기계용 JSON',
  '  --help, -h         도움말',
  '',
].join('\n');

function parseArgs(args) {
  const o = { project: process.cwd(), json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--project') o.project = args[++i];
  }
  return o;
}

module.exports = function testguard(args) {
  const o = parseArgs(args);
  if (o.help) { process.stdout.write(HELP); return; }

  const projectDir = path.resolve(o.project);
  const { tasks } = readTasks(projectDir);
  if (!tasks.length) {
    process.stderr.write(`pact testguard: ${projectDir} 에 tasks/*.md task 없음.\n`);
    process.exitCode = 2;
    return;
  }

  const rows = assessTestGuard(tasks);
  process.stdout.write((o.json ? formatJson(rows) : formatHuman(rows, path.basename(projectDir))) + '\n');
};
