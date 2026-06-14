'use strict';

// Task source discovery for context-light pact projects.
//
// v1.0 compatibility:
// - Legacy projects may keep all tasks in TASKS.md.
// - Context-light projects may shard tasks into tasks/*.md.
// - If tasks/*.md exists, it becomes the default SOT and TASKS.md is treated
//   as an optional index, not as another task source.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./lib/atomic-write.js');

function markdownFiles(dir, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const fullDir = path.join(cwd, dir);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return [];

  return fs.readdirSync(fullDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => path.join(dir, f));
}

function discoverTaskFiles(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  if (opts.file) {
    return fs.existsSync(path.join(cwd, opts.file)) ? [opts.file] : [];
  }

  const shards = markdownFiles('tasks', { cwd });
  if (shards.length > 0) return shards;

  return fs.existsSync(path.join(cwd, 'TASKS.md')) ? ['TASKS.md'] : [];
}

function parseTaskFiles(files, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const { parseTasks } = require('./parse-tasks.js');

  const tasks = [];
  const tbdMarkers = [];
  const errors = [];
  let frontmatter = null;
  let frontmatterSource = null;
  const seen = new Map();

  for (const file of files) {
    let md;
    try {
      md = fs.readFileSync(path.join(cwd, file), 'utf8');
    } catch (e) {
      errors.push({ file, taskId: null, error: `read failed: ${e.message}` });
      continue;
    }

    const parsed = parseTasks(md);
    // 첫 번째 non-empty frontmatter만 채택. 다른 shard에 충돌 키가 있으면 경고.
    if (parsed.frontmatter && Object.keys(parsed.frontmatter).length > 0) {
      if (frontmatter === null) {
        frontmatter = parsed.frontmatter;
        frontmatterSource = file;
      } else {
        for (const k of Object.keys(parsed.frontmatter)) {
          if (k in frontmatter && JSON.stringify(frontmatter[k]) !== JSON.stringify(parsed.frontmatter[k])) {
            errors.push({
              file,
              taskId: null,
              error: `frontmatter key "${k}" conflicts with ${frontmatterSource}; ignored`,
            });
          }
        }
      }
    }

    for (const e of parsed.errors) errors.push({ file, ...e });
    for (const t of parsed.tasks) {
      if (seen.has(t.id)) {
        errors.push({
          file,
          taskId: t.id,
          error: `duplicate task id; first seen in ${seen.get(t.id)}`,
        });
        continue;
      }
      seen.set(t.id, file);
      tasks.push({ ...t, source_file: file });
    }
    for (const m of parsed.tbdMarkers) tbdMarkers.push({ file, ...m });
  }

  return { tasks, tbdMarkers, frontmatter: frontmatter || {}, frontmatterSource, errors, files };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 단일 task의 status 필드를 source file의 yaml 블록에 박는다.
 * - tasks/*.md 또는 legacy TASKS.md를 자동 검색
 * - yaml 블록에 status 라인이 있으면 replace, 없으면 append
 * - 머지 성공 후 batch-builder가 done task를 다시 잡지 않게 하기 위함
 *
 * @param {string} taskId
 * @param {'todo'|'done'|'failed'|'blocked'} status
 * @param {{cwd?: string}} [opts]
 * @returns {{ok: boolean, file?: string, action?: 'replaced'|'appended', error?: string}}
 */
function setTaskStatus(taskId, status, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const files = discoverTaskFiles({ cwd });
  if (files.length === 0) {
    return { ok: false, error: 'no task source files found' };
  }

  const headerRe = new RegExp(`^(##+)\\s+${escapeRegex(taskId)}(?=\\s|$)`, 'm');

  for (const file of files) {
    const fullPath = path.join(cwd, file);
    let md;
    try {
      md = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const headerMatch = headerRe.exec(md);
    if (!headerMatch) continue;

    const headerStart = headerMatch.index;
    const level = headerMatch[1].length;
    // 이 task 섹션 = 헤더부터 다음 동일/상위 레벨 헤더 직전까지 (없으면 EOF).
    // 반드시 bound 해야 yaml 블록 없는 task 가 다음 task 의 yaml 을 침범하지 않음 (버그 A).
    const bodyStart = headerStart + headerMatch[0].length;
    const nextHeader = new RegExp(`^#{1,${level}}\\s`, 'm').exec(md.slice(bodyStart));
    const sectionEnd = nextHeader ? bodyStart + nextHeader.index : md.length;
    // 이 섹션 안에서만 첫 yaml 블록 처리
    const after = md.slice(headerStart, sectionEnd);
    const yamlBlockRe = /```yaml\s*\n([\s\S]*?)\n```/;
    const yamlMatch = after.match(yamlBlockRe);
    if (!yamlMatch) {
      return { ok: false, error: `no yaml block found under ${taskId} in ${file}` };
    }

    const yamlBody = yamlMatch[1];
    const bodyLines = yamlBody.split('\n');
    const statusLines = bodyLines.filter((l) => /^status:[ \t]*/.test(l));
    const curStatus = statusLines.length
      ? (statusLines[0].match(/^status:[ \t]*(\S+)/) || [])[1]
      : undefined;
    // 멱등: status 라인이 정확히 1개이고 이미 목표값이면 쓰기 자체를 건너뜀.
    // (중복 라인이 있으면 noop 하지 않고 아래에서 자가치유한다.)
    if (statusLines.length === 1 && curStatus === status) {
      return { ok: true, file, action: 'noop' };
    }
    // 기존 status 라인을 전부 제거한 뒤 정확히 1줄 append → 중복 status 자가치유 (버그 B 생산자측).
    const kept = bodyLines.filter((l) => !/^status:[ \t]*/.test(l));
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    const newYamlBody = kept.join('\n') + `\nstatus: ${status}`;
    const action = statusLines.length ? 'replaced' : 'appended';

    const newAfter = after.replace(yamlBlockRe, '```yaml\n' + newYamlBody + '\n```');
    // 섹션을 bound 했으므로 섹션 뒤(다음 task 이후)를 반드시 다시 이어붙인다.
    const newMd = md.slice(0, headerStart) + newAfter + md.slice(sectionEnd);

    try {
      writeFileAtomic(fullPath, newMd); // 원자적 — source .md 절단 방지
    } catch (e) {
      return { ok: false, error: `write failed: ${e.message}` };
    }
    return { ok: true, file, action };
  }

  return { ok: false, error: `task ${taskId} not found in any source file` };
}

module.exports = {
  discoverTaskFiles,
  parseTaskFiles,
  markdownFiles,
  setTaskStatus,
};
