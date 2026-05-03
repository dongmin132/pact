'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverTaskFiles, parseTaskFiles } = require('../scripts/task-sources.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pact-task-src-'));
}

const TASK_BLOCK = (id, prio = 'P0') => `## ${id}  task ${id}

\`\`\`yaml
priority: ${prio}
dependencies: []
allowed_paths: [src/x.ts]
files: [src/x.ts]
work: [w]
done_criteria: [d]
tdd: false
\`\`\`
`;

const FRONTMATTER = (mode) => `## frontmatter

\`\`\`yaml
educational_mode: ${mode}
\`\`\`

`;

test('discoverTaskFiles — tasks/*.md 있으면 우선', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    fs.writeFileSync(path.join(dir, 'tasks', 'auth.md'), TASK_BLOCK('AUTH-001'));
    fs.writeFileSync(path.join(dir, 'TASKS.md'), TASK_BLOCK('LEGACY-001'));
    const files = discoverTaskFiles({ cwd: dir });
    assert.deepEqual(files, ['tasks/auth.md']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseTaskFiles — 첫 번째 frontmatter만 채택, 충돌은 error로 보고', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    fs.writeFileSync(path.join(dir, 'tasks', 'a-auth.md'), FRONTMATTER('true') + TASK_BLOCK('AUTH-001'));
    fs.writeFileSync(path.join(dir, 'tasks', 'b-meetup.md'), FRONTMATTER('false') + TASK_BLOCK('MEETUP-001'));

    const result = parseTaskFiles(['tasks/a-auth.md', 'tasks/b-meetup.md'], { cwd: dir });
    assert.equal(result.frontmatter.educational_mode, true);
    assert.equal(result.frontmatterSource, 'tasks/a-auth.md');
    const conflict = result.errors.find(e => /frontmatter key/.test(e.error));
    assert.ok(conflict, 'expected frontmatter conflict error');
    assert.equal(conflict.file, 'tasks/b-meetup.md');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseTaskFiles — 동일 task id가 두 shard에 있으면 duplicate error', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), TASK_BLOCK('SHARED-001'));
    fs.writeFileSync(path.join(dir, 'tasks', 'b.md'), TASK_BLOCK('SHARED-001'));

    const result = parseTaskFiles(['tasks/a.md', 'tasks/b.md'], { cwd: dir });
    assert.equal(result.tasks.length, 1);
    assert.ok(result.errors.some(e => /duplicate task id/.test(e.error)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
