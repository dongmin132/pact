'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverTaskFiles, parseTaskFiles, setTaskStatus } = require('../scripts/task-sources.js');

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

test('setTaskStatus — yaml에 status 라인 없으면 append (BOOT-001 머지 후 done 박기)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    fs.writeFileSync(path.join(dir, 'tasks', 'boot.md'), TASK_BLOCK('BOOT-001'));

    const r = setTaskStatus('BOOT-001', 'done', { cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'appended');
    assert.equal(r.file, 'tasks/boot.md');

    const md = fs.readFileSync(path.join(dir, 'tasks', 'boot.md'), 'utf8');
    assert.match(md, /status: done/);

    // round-trip — parseTaskFiles로 재읽기 시 status:done 보존
    const parsed = parseTaskFiles(['tasks/boot.md'], { cwd: dir });
    assert.equal(parsed.tasks[0].status, 'done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setTaskStatus — yaml에 status 라인 있으면 replace (todo → done)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    const md = `## BOOT-001  task

\`\`\`yaml
priority: P0
status: todo
dependencies: []
files: [a.ts]
work: [w]
done_criteria: [d]
tdd: false
\`\`\`
`;
    fs.writeFileSync(path.join(dir, 'tasks', 'boot.md'), md);

    const r = setTaskStatus('BOOT-001', 'done', { cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'replaced');

    const after = fs.readFileSync(path.join(dir, 'tasks', 'boot.md'), 'utf8');
    assert.match(after, /status: done/);
    assert.doesNotMatch(after, /status: todo/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setTaskStatus — task 없으면 ok:false', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), TASK_BLOCK('OTHER-001'));

    const r = setTaskStatus('MISSING-999', 'done', { cwd: dir });
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setTaskStatus — legacy TASKS.md도 지원', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'TASKS.md'), TASK_BLOCK('LEG-001'));

    const r = setTaskStatus('LEG-001', 'done', { cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.file, 'TASKS.md');

    const md = fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf8');
    assert.match(md, /status: done/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setTaskStatus — 다른 task의 yaml 블록 침범 X (첫 헤더 다음 첫 yaml만)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    const md = TASK_BLOCK('A-001') + '\n' + TASK_BLOCK('A-002');
    fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), md);

    const r = setTaskStatus('A-001', 'done', { cwd: dir });
    assert.equal(r.ok, true);

    const parsed = parseTaskFiles(['tasks/a.md'], { cwd: dir });
    const a1 = parsed.tasks.find(t => t.id === 'A-001');
    const a2 = parsed.tasks.find(t => t.id === 'A-002');
    assert.equal(a1.status, 'done');
    assert.equal(a2.status, 'todo', 'A-002는 영향 없어야 함');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
