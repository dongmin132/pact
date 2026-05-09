'use strict';

// PACT-006 — TASKS.md 파서 단위 테스트
// TDD RED 단계: 이 파일이 먼저 작성되고 실패해야 함.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTasks } = require('../scripts/parse-tasks.js');

const SAMPLE = `# TASKS — sample

## frontmatter

\`\`\`yaml
educational_mode: true
prd_source: null
\`\`\`

---

## Task 작성 가이드

각 task는 다음 형식의 yaml 블록을 포함:

\`\`\`yaml
priority: P0 | P1 | P2
dependencies:
  - task_id: <id>
    kind: complete | contract_only
\`\`\`

---

## TASK-001  로그인 API

\`\`\`yaml
priority: P0
dependencies: []
allowed_paths:
  - src/api/auth/login.ts
files:
  - src/api/auth/login.ts
work:
  - 로그인 처리
done_criteria:
  - POST 200 반환
tdd: true
\`\`\`

추가 prose 설명.

---

## TASK-002  회원가입

\`\`\`yaml
priority: P0
dependencies:
  - task_id: TASK-001
    kind: complete
allowed_paths:
  - src/api/auth/signup.ts
files:
  - src/api/auth/signup.ts
work:
  - 회원가입
done_criteria:
  - POST 201 반환
contracts:
  api_endpoints: TBD
  db_tables: TBD
tdd: true
\`\`\`
`;

test('정상 TASKS.md에서 task 2개 추출', () => {
  const result = parseTasks(SAMPLE);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].id, 'TASK-001');
  assert.equal(result.tasks[0].title, '로그인 API');
  assert.equal(result.tasks[1].id, 'TASK-002');
});

test('frontmatter 파싱 — educational_mode 추출', () => {
  const result = parseTasks(SAMPLE);
  assert.equal(result.frontmatter.educational_mode, true);
  assert.equal(result.frontmatter.prd_source, null);
});

test('"Task 작성 가이드" 섹션 yaml 블록은 task로 인식 X', () => {
  const result = parseTasks(SAMPLE);
  // 가이드 섹션의 priority: P0 | P1 | P2 같은 yaml은 무시되어야 함
  const guideTask = result.tasks.find(t => t.title.includes('가이드'));
  assert.equal(guideTask, undefined);
});

test('TBD 마커 검출 — TASK-002의 contracts.* 모두 TBD', () => {
  const result = parseTasks(SAMPLE);
  const tbd = result.tbdMarkers.find(m => m.taskId === 'TASK-002');
  assert.ok(tbd, 'TASK-002에 TBD 마커가 있어야 함');
  assert.ok(tbd.fields.includes('contracts.api_endpoints'));
  assert.ok(tbd.fields.includes('contracts.db_tables'));
});

test('TASK-001은 TBD 마커 없음', () => {
  const result = parseTasks(SAMPLE);
  const tbd = result.tbdMarkers.find(m => m.taskId === 'TASK-001');
  assert.equal(tbd, undefined);
});

test('의존성 객체 형식 파싱 — TASK-002는 TASK-001에 complete 의존', () => {
  const result = parseTasks(SAMPLE);
  const t2 = result.tasks.find(t => t.id === 'TASK-002');
  assert.equal(t2.dependencies.length, 1);
  assert.equal(t2.dependencies[0].task_id, 'TASK-001');
  assert.equal(t2.dependencies[0].kind, 'complete');
});

test('빈 의존성 배열 — TASK-001', () => {
  const result = parseTasks(SAMPLE);
  const t1 = result.tasks.find(t => t.id === 'TASK-001');
  assert.deepEqual(t1.dependencies, []);
});

test('파일 누락 같은 게 아니라 yaml 자체가 깨진 task — 명시적 에러', () => {
  const broken = `## TASK-001  깨진 yaml

\`\`\`yaml
priority: [unbalanced
\`\`\`
`;
  const result = parseTasks(broken);
  assert.equal(result.tasks.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].taskId, 'TASK-001');
  assert.match(result.errors[0].error, /yaml/i);
});

test('task 헤더는 있는데 yaml 블록이 없으면 에러', () => {
  const noYaml = `## TASK-001  yaml 없음

그냥 prose만 있음.
`;
  const result = parseTasks(noYaml);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /yaml block/i);
});

test('빈 입력 — 빈 결과 반환', () => {
  const result = parseTasks('');
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.tbdMarkers, []);
  assert.deepEqual(result.errors, []);
});

test('task ID 형식 — PACT-001, AUTH-042 등 다양한 prefix 지원', () => {
  const md = `## PACT-042  pact task

\`\`\`yaml
priority: P0
dependencies: []
files: [a.ts]
work: [test]
done_criteria: [done]
tdd: false
\`\`\`

## AUTH-001  auth task

\`\`\`yaml
priority: P1
dependencies: []
files: [b.ts]
work: [test]
done_criteria: [done]
tdd: false
\`\`\`
`;
  const result = parseTasks(md);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].id, 'PACT-042');
  assert.equal(result.tasks[1].id, 'AUTH-001');
});

test('회귀: yaml의 status:done이 default todo로 덮어씌워지지 않음 (v0.5.0 BOOT-001 무한루프 fix)', () => {
  const md = `## BOOT-001  완료된 task

\`\`\`yaml
priority: P0
dependencies: []
files: [a.ts]
work: [test]
done_criteria: [done]
tdd: false
status: done
retry_count: 1
\`\`\`

## BOOT-002  새 task

\`\`\`yaml
priority: P0
dependencies: []
files: [b.ts]
work: [test]
done_criteria: [done]
tdd: false
\`\`\`
`;
  const result = parseTasks(md);
  const t1 = result.tasks.find(t => t.id === 'BOOT-001');
  const t2 = result.tasks.find(t => t.id === 'BOOT-002');
  assert.equal(t1.status, 'done', 'yaml status:done이 보존되어야 batch가 다시 안 뽑음');
  assert.equal(t1.retry_count, 1, 'yaml retry_count도 보존');
  assert.equal(t2.status, 'todo', 'yaml에 status 없으면 default todo');
  assert.equal(t2.retry_count, 0, 'yaml에 retry_count 없으면 default 0');
});

test('회귀: yaml에 id 박혀도 헤더 ID가 진실 (오타 방어)', () => {
  const md = `## BOOT-001  헤더가 진실

\`\`\`yaml
id: WRONG-999
title: yaml에 박힌 가짜 title
priority: P0
dependencies: []
files: [a.ts]
work: [test]
done_criteria: [done]
tdd: false
\`\`\`
`;
  const result = parseTasks(md);
  assert.equal(result.tasks[0].id, 'BOOT-001', '헤더 ID가 yaml id 덮음');
  assert.equal(result.tasks[0].title, '헤더가 진실', '헤더 title이 yaml title 덮음');
});
