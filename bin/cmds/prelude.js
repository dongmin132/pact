'use strict';

// pact prelude — 공유표면 freeze 추출 (propose-only, read-only)
//
// fan-out 전에 여러 task 가 공유하는 구체 파일을 찾아, 그걸 먼저 고정할
// prelude task + 의존 task 재작성을 "제안"한다. tasks/*.md 를 고치지 않는다
// (철학 5번: 자동 반영 X, 제안까지만). 적용은 사람이/`/pact:plan` 이.

const path = require('path');
const { readTasks } = require('../../scripts/metrics/collect.js');
const { buildProposal, formatHuman, formatJson } = require('../../scripts/prelude/format.js');

const HELP = [
  'pact prelude — 공유표면 freeze 추출 (propose-only)',
  '',
  '여러 task 가 공유하는 구체 파일을 찾아 prelude(먼저 고정) + 의존 재작성을 제안.',
  'tasks/*.md 를 고치지 않음 — 제안만 출력.',
  '',
  '사용법: pact prelude [옵션]',
  '  --project <path>   대상 (기본: 현재 디렉토리)',
  '  --min=N            공유 task 임계 (기본 3)',
  '  --json             기계용 JSON',
  '  --help, -h         도움말',
  '',
  '예) pact prelude --project ../brewdy',
  '    pact prelude --min=2 --json',
  '',
].join('\n');

function parseArgs(args) {
  const o = { project: process.cwd(), min: 3, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--project') o.project = args[++i];
    else if (a.startsWith('--min=')) o.min = parseInt(a.slice(6), 10);
    else if (a === '--min') o.min = parseInt(args[++i], 10);
  }
  if (!Number.isFinite(o.min) || o.min < 2) o.min = 3;
  return o;
}

module.exports = function prelude(args) {
  const o = parseArgs(args);
  if (o.help) { process.stdout.write(HELP); return; }

  const projectDir = path.resolve(o.project);
  const { tasks } = readTasks(projectDir);
  if (!tasks.length) {
    process.stderr.write(`pact prelude: ${projectDir} 에 tasks/*.md task 없음.\n`);
    process.exitCode = 2;
    return;
  }

  const proposal = buildProposal(tasks, o.min);
  process.stdout.write((o.json ? formatJson(proposal) : formatHuman(proposal, path.basename(projectDir))) + '\n');
};
