'use strict';

// pact report-gen — status.json → report.md 결정적 렌더 (SPD-5 · P1-4, 0토큰).
// <task_id> 단건 또는 --all 로 .pact/runs/* 전체. 기존 report.md 는 존중(--force 로만 재렌더).

const path = require('path');
const { generateReport, generateAll } = require('../../scripts/report-gen.js');

const HELP = [
  'pact report-gen — status.json → report.md 결정적 렌더 (0토큰)',
  '',
  '워커가 채운 status.json 의 구조화 필드(status·summary·files_changed·verify_results·',
  'decisions·blockers)를 사람이 읽는 report.md 로 렌더한다. 워커가 이미 report.md 를 손으로',
  '썼으면 존중(덮어쓰지 않음, 철학5). collect 가 머지 직전 자동 호출한다.',
  '',
  '사용법: pact report-gen <task_id> | --all [옵션]',
  '  --all              .pact/runs/* 전체 대상',
  '  --force            기존 report.md 도 재렌더(수기본 덮어씀)',
  '  --project <path>   대상 (기본: 현재 디렉토리)',
  '  --json             기계용 JSON',
  '  --help, -h         도움말',
  '',
].join('\n');

function parseArgs(args) {
  const o = { project: process.cwd(), all: false, force: false, json: false, help: false, taskId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') o.all = true;
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--project') o.project = args[++i];
    else if (!a.startsWith('-')) o.taskId = a;
  }
  return o;
}

module.exports = function reportGen(args) {
  const o = parseArgs(args);
  if (o.help) { process.stdout.write(HELP); return; }

  if (!o.all && !o.taskId) {
    process.stderr.write('Usage: pact report-gen <task_id> | --all\n');
    process.exitCode = 1;
    return;
  }

  const projectDir = path.resolve(o.project);
  const runsRoot = path.join(projectDir, '.pact/runs');

  const results = o.all
    ? generateAll({ cwd: projectDir, runsRoot, force: o.force })
    : [generateReport(o.taskId, { cwd: projectDir, runsRoot, force: o.force })];

  if (o.json) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      const tag = !r.ok
        ? `✗ ${r.reason}`
        : (r.action === 'skipped' ? '· skip (기존 report.md 존중)' : '✓ 렌더');
      process.stdout.write(`${r.task_id}: ${tag}\n`);
    }
  }

  // 단건 대상이 렌더 불가(status.json 없음/파싱 실패)면 non-zero — 스크립트 배선 오류 신호.
  if (!o.all && results[0] && !results[0].ok) process.exitCode = 2;
};
