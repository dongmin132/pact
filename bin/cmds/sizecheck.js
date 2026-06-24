'use strict';

// pact sizecheck — 턴소진 위험 task 사이징 (propose-only, read-only)
// tasks/*.md 를 읽어 너무 큰 task(워커가 한 턴에 못 끝낼)를 플래그한다.

const path = require('path');
const { readTasks } = require('../../scripts/metrics/collect.js');
const { assessTasks, formatHuman, formatJson } = require('../../scripts/sizecheck.js');

const HELP = [
  'pact sizecheck — 턴소진 위험 task 사이징 (propose-only)',
  '',
  '워커가 한 턴에 못 끝낼 만큼 큰 task 를 fan-out 전에 플래그 → 분해 제안.',
  '',
  '사용법: pact sizecheck [옵션]',
  '  --project <path>    대상 (기본: 현재 디렉토리)',
  '  --max-files=N       파일 임계 (기본 5)',
  '  --json              기계용 JSON',
  '  --help, -h          도움말',
  '',
].join('\n');

function parseArgs(args) {
  const o = { project: process.cwd(), maxFiles: 5, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--project') o.project = args[++i];
    else if (a.startsWith('--max-files=')) o.maxFiles = parseInt(a.slice(12), 10);
    else if (a === '--max-files') o.maxFiles = parseInt(args[++i], 10);
  }
  if (!Number.isFinite(o.maxFiles) || o.maxFiles < 1) o.maxFiles = 5;
  return o;
}

module.exports = function sizecheck(args) {
  const o = parseArgs(args);
  if (o.help) { process.stdout.write(HELP); return; }

  const projectDir = path.resolve(o.project);
  const { tasks } = readTasks(projectDir);
  if (!tasks.length) {
    process.stderr.write(`pact sizecheck: ${projectDir} 에 tasks/*.md task 없음.\n`);
    process.exitCode = 2;
    return;
  }

  const rows = assessTasks(tasks, { maxFiles: o.maxFiles });
  process.stdout.write(
    (o.json ? formatJson(rows, o.maxFiles) : formatHuman(rows, path.basename(projectDir), o.maxFiles)) + '\n',
  );
};
