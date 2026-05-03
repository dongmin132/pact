'use strict';

// pact slice — TASKS.md에서 슬라이스 추출 (큰 파일 통째 read 회피)
//
// 사용:
//   pact slice                           → 모든 task (= cat 같은 효과)
//   pact slice --status todo             → status=todo 만
//   pact slice --status todo,in_progress → 여러 status
//   pact slice --priority P0             → priority=P0 만
//   pact slice --ids INFRA-001,DB-002    → 명시 ID만
//   pact slice --tbd                     → TBD 마커 있는 task만
//   pact slice --headers                 → 헤더·title만 (TOC)

const fs = require('fs');
const path = require('path');

function parseArgs(args) {
  const opts = { status: null, priority: null, ids: null, tbd: false, headers: false, file: 'TASKS.md' };
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

  if (!fs.existsSync(opts.file)) {
    console.error(`${opts.file} not found`);
    process.exit(2);
  }

  const { parseTasks } = require(path.join(__dirname, '..', '..', 'scripts', 'parse-tasks.js'));
  const md = fs.readFileSync(opts.file, 'utf8');
  const parsed = parseTasks(md);

  // headers 모드 — TOC만
  if (opts.headers) {
    console.log(`# TASKS — ${parsed.tasks.length} task (TOC)`);
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
      console.log(`- ${t.id}  [${prio}/${status}]  ${t.title}`);
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

  // 원본 마크다운에서 해당 task 섹션만 추출
  const filteredIds = new Set(filtered.map(t => t.id));
  const lines = md.split('\n');
  const out = [];
  let inTaskSection = false;
  let currentTaskMatches = false;
  let preTaskLines = [];

  for (const line of lines) {
    const taskHeader = line.match(/^#{2,3} ([A-Z][A-Z0-9]*-\d+)\s+(.+)$/);
    if (taskHeader) {
      inTaskSection = true;
      currentTaskMatches = filteredIds.has(taskHeader[1]);
      if (currentTaskMatches) {
        // task heading 이전의 frontmatter·guide 한 번만 박기
        if (preTaskLines.length > 0) {
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

  // task 0개면 frontmatter만 출력
  if (out.length === 0 && preTaskLines.length > 0) {
    console.log(preTaskLines.join('\n'));
    console.error(`(필터 통과 task 0개. 전체 ${parsed.tasks.length}개 중)`);
    return;
  }

  console.log(out.join('\n'));
  console.error(`✓ ${filtered.length}/${parsed.tasks.length} task (${filtered.map(t => t.id).join(', ')})`);
};
