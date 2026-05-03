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

module.exports = {
  discoverTaskFiles,
  parseTaskFiles,
  markdownFiles,
};
