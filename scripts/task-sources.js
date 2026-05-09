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
    // 헤더 다음 영역에서 첫 yaml 블록만 처리 (다른 task 침범 X)
    const after = md.slice(headerStart);
    const yamlBlockRe = /```yaml\s*\n([\s\S]*?)\n```/;
    const yamlMatch = after.match(yamlBlockRe);
    if (!yamlMatch) {
      return { ok: false, error: `no yaml block found under ${taskId} in ${file}` };
    }

    const yamlBody = yamlMatch[1];
    const statusLineRe = /^status:[ \t]*\S.*$/m;
    let newYamlBody;
    let action;
    if (statusLineRe.test(yamlBody)) {
      newYamlBody = yamlBody.replace(statusLineRe, `status: ${status}`);
      action = 'replaced';
    } else {
      // 기존 마지막 라인 끝에 \n 보장
      newYamlBody = yamlBody.replace(/\s*$/, '') + `\nstatus: ${status}`;
      action = 'appended';
    }

    const newAfter = after.replace(yamlBlockRe, '```yaml\n' + newYamlBody + '\n```');
    const newMd = md.slice(0, headerStart) + newAfter;

    try {
      fs.writeFileSync(fullPath, newMd);
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
