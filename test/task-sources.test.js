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

test('setTaskStatus — 대상 task에 yaml 블록이 없으면 다음 task를 침범하지 않고 ok:false (버그 A)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    // NOYAML-116 은 헤더만 있고 yaml 블록 없음. 그 뒤에 yaml 가진 NEXT-017.
    const noYaml = `## NOYAML-116  yaml 블록 없는 task\n\n설명만 있음.\n\n`;
    const md = noYaml + TASK_BLOCK('NEXT-017');
    fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), md);

    const r = setTaskStatus('NOYAML-116', 'done', { cwd: dir });

    // 1) 대상에 yaml이 없으니 거짓 성공이 아니라 ok:false 여야 함
    assert.equal(r.ok, false, 'yaml 블록 없는 task는 ok:false 여야 함');

    // 2) 다음 task NEXT-017 의 yaml 블록이 손상되면 안 됨
    const after = fs.readFileSync(path.join(dir, 'tasks', 'a.md'), 'utf8');
    assert.doesNotMatch(after, /status: done/, 'NEXT-017 의 yaml 에 status:done 이 박히면 안 됨');
    const parsed = parseTaskFiles(['tasks/a.md'], { cwd: dir });
    const next = parsed.tasks.find(t => t.id === 'NEXT-017');
    assert.ok(next, 'NEXT-017 은 파싱돼야 함');
    assert.notEqual(next.status, 'done', 'NEXT-017 status 가 손상되면 안 됨');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setTaskStatus — 중복 status 라인 자가치유 (정확히 1줄)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    const md = `## DUP-001  task

\`\`\`yaml
priority: P0
status: todo
files: [a.ts]
status: blocked
\`\`\`
`;
    fs.writeFileSync(path.join(dir, 'tasks', 'd.md'), md);
    const r = setTaskStatus('DUP-001', 'done', { cwd: dir });
    assert.equal(r.ok, true);
    const after = fs.readFileSync(path.join(dir, 'tasks', 'd.md'), 'utf8');
    assert.equal((after.match(/^status:/mg) || []).length, 1, 'status 라인 정확히 1개');
    assert.match(after, /status: done/);
    const parsed = parseTaskFiles(['tasks/d.md'], { cwd: dir });
    assert.equal(parsed.errors.length, 0, 'yaml-mini 중복키 에러 없어야 함');
    assert.equal(parsed.tasks[0].status, 'done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setTaskStatus — 이미 목표 status면 noop (멱등, 쓰기 안 함)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'tasks'));
    const md = `## IDEM-001  task

\`\`\`yaml
priority: P0
status: done
files: [a.ts]
\`\`\`
`;
    fs.writeFileSync(path.join(dir, 'tasks', 'i.md'), md);
    const before = fs.readFileSync(path.join(dir, 'tasks', 'i.md'), 'utf8');
    const r = setTaskStatus('IDEM-001', 'done', { cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'noop');
    assert.equal(fs.readFileSync(path.join(dir, 'tasks', 'i.md'), 'utf8'), before, '쓰기 없음');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
