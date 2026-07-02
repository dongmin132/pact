'use strict';

// pact scopecheck — done_criteria ⊄ allowed_paths 계약모순 검출 (propose-only, read-only)
// tasks/*.md 를 읽어 done_criteria 가 allowed_paths 밖 파일 생성을 의무화하는 task 를 플래그한다.

const path = require('path');
const { readTasks } = require('../../scripts/metrics/collect.js');
const { assessTasks, formatHuman, formatJson } = require('../../scripts/scopecheck.js');

const HELP = [
  'pact scopecheck — done_criteria ⊄ allowed_paths 계약모순 (propose-only)',
  '',
  'done_criteria 가 allowed_paths 밖 파일 생성을 의무화하면, 워커는 task 를 충실히',
  '이행하지만 merge 게이트가 범위 밖 파일을 거부한다(작업 통째 유실). 이 계약모순을',
  'fan-out 전에 정적으로 잡아 분해·수정을 제안한다.',
  '',
  '사용법: pact scopecheck [옵션]',
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

module.exports = function scopecheck(args) {
  const o = parseArgs(args);
  if (o.help) { process.stdout.write(HELP); return; }

  const projectDir = path.resolve(o.project);
  const { tasks } = readTasks(projectDir);
  if (!tasks.length) {
    process.stderr.write(`pact scopecheck: ${projectDir} 에 tasks/*.md task 없음.\n`);
    process.exitCode = 2;
    return;
  }

  const rows = assessTasks(tasks);
  process.stdout.write(
    (o.json ? formatJson(rows) : formatHuman(rows, path.basename(projectDir))) + '\n',
  );
};
