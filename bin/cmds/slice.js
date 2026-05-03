'use strict';

// pact slice — TASKS.md에서 슬라이스 추출 (큰 파일 통째 read 회피)
//
// 사용:
//   pact slice                           → 기본 task source(TASKS.md or tasks/*.md)
//   pact slice --status todo             → status=todo 만
//   pact slice --status todo,in_progress → 여러 status
//   pact slice --priority P0             → priority=P0 만
//   pact slice --ids INFRA-001,DB-002    → 명시 ID만
//   pact slice --tbd                     → TBD 마커 있는 task만
//   pact slice --headers                 → 헤더·title만 (TOC)

const fs = require('fs');
const path = require('path');

function parseArgs(args) {
  const opts = { status: null, priority: null, ids: null, tbd: false, headers: false, file: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--status') opts.status = args[++i].split(',');
    else if (a === '--priority') opts.priority = args[++i].split(',');
    else if (a === '--ids') opts.ids = args[++i].split(',');
    else if (a === '--tbd') opts.tbd = true;
    else if (a === '--headers') opts.headers = true;
    else if (a === '--file') opts.file = args[++i];
  }
  return opts;
}

module.exports = function slice(args) {
  const opts = parseArgs(args);

  const { discoverTaskFiles, parseTaskFiles } = require(path.join(__dirname, '..', '..', 'scripts', 'task-sources.js'));
  const taskFiles = discoverTaskFiles({ file: opts.file });
  if (taskFiles.length === 0) {
    console.error(`${opts.file || 'TASKS.md 또는 tasks/*.md'} not found`);
    process.exit(2);
  }

  const { parseTasks } = require(path.join(__dirname, '..', '..', 'scripts', 'parse-tasks.js'));
  const parsed = parseTaskFiles(taskFiles);

  // headers 모드 — TOC만
  if (opts.headers) {
    console.log(`# TASKS — ${parsed.tasks.length} task (TOC)`);
    console.log();
    console.log(`sources: ${taskFiles.join(', ')}`);
    console.log();
    if (parsed.frontmatter) {
      console.log('## frontmatter');
      console.log('```yaml');
      for (const [k, v] of Object.entries(parsed.frontmatter)) {
        console.log(`${k}: ${JSON.stringify(v)}`);
      }
      console.log('```');
      console.log();
    }
    for (const t of parsed.tasks) {
      const prio = t.priority || '?';
      const status = t.status || 'todo';
      console.log(`- ${t.id}  [${prio}/${status}]  ${t.title}  (${t.source_file})`);
    }
    return;
  }

  // 필터링
  let filtered = parsed.tasks;
  if (opts.status) filtered = filtered.filter(t => opts.status.includes(t.status || 'todo'));
  if (opts.priority) filtered = filtered.filter(t => opts.priority.includes(t.priority));
  if (opts.ids) filtered = filtered.filter(t => opts.ids.includes(t.id));
  if (opts.tbd) {
    const tbdIds = new Set(parsed.tbdMarkers.map(m => m.taskId));
    filtered = filtered.filter(t => tbdIds.has(t.id));
  }

  const filteredIds = new Set(filtered.map(t => t.id));
  const out = [];

  for (const file of taskFiles) {
    const md = fs.readFileSync(file, 'utf8');
    const fileParsed = parseTasks(md);
    const fileIds = new Set(fileParsed.tasks.map(t => t.id).filter(id => filteredIds.has(id)));
    if (fileIds.size === 0) continue;

    out.push(`\n<!-- source: ${file} -->`);
    const lines = md.split('\n');
    let inTaskSection = false;
    let currentTaskMatches = false;
    let preTaskLines = [];

    for (const line of lines) {
      const taskHeader = line.match(/^#{2,3} ([A-Z][A-Z0-9]*-\d+)\s+(.+)$/);
      if (taskHeader) {
        inTaskSection = true;
        currentTaskMatches = fileIds.has(taskHeader[1]);
        if (currentTaskMatches) {
          if (preTaskLines.length > 0 && out.length <= 1) {
            out.push(...preTaskLines);
            preTaskLines = [];
          }
          out.push(line);
        }
        continue;
      }
      if (inTaskSection && currentTaskMatches) {
        out.push(line);
      } else if (!inTaskSection) {
        preTaskLines.push(line);
      }
    }
  }

  if (out.length === 0) {
    console.error(`(필터 통과 task 0개. 전체 ${parsed.tasks.length}개 중)`);
    return;
  }

  console.log(out.join('\n'));
  console.error(`✓ ${filtered.length}/${parsed.tasks.length} task (${filtered.map(t => t.id).join(', ')})`);
};
