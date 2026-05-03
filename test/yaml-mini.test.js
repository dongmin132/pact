'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/lib/yaml-mini.js');

test('빈 입력 → null', () => {
  assert.equal(load(''), null);
  assert.equal(load(null), null);
});

test('스칼라 — string·number·bool·null', () => {
  assert.deepEqual(load('a: hello\nb: 42\nc: 1.5\nd: true\ne: null'), {
    a: 'hello', b: 42, c: 1.5, d: true, e: null,
  });
});

test('따옴표 string', () => {
  assert.deepEqual(load('a: "with: colon"\nb: \'single\''), {
    a: 'with: colon', b: 'single',
  });
});

test('inline array·object', () => {
  assert.deepEqual(load('a: [1, 2, 3]\nb: {k: v, x: 1}'), {
    a: [1, 2, 3],
    b: { k: 'v', x: 1 },
  });
});

test('block array of scalars', () => {
  assert.deepEqual(load('items:\n  - a\n  - b\n  - c'), {
    items: ['a', 'b', 'c'],
  });
});

test('block array of objects', () => {
  assert.deepEqual(load(
    'deps:\n  - task_id: A-1\n    kind: complete\n  - task_id: B-2\n    kind: contract_only'
  ), {
    deps: [
      { task_id: 'A-1', kind: 'complete' },
      { task_id: 'B-2', kind: 'contract_only' },
    ],
  });
});

test('nested mapping', () => {
  assert.deepEqual(load('cross_review:\n  adapter: codex\n  mode: auto'), {
    cross_review: { adapter: 'codex', mode: 'auto' },
  });
});

test('주석 제거', () => {
  assert.deepEqual(load('a: 1   # 코멘트\nb: 2 # x'), { a: 1, b: 2 });
});

test('실제 task 블록', () => {
  const yaml = `priority: P0
dependencies:
  - task_id: TASK-001
    kind: complete
allowed_paths:
  - src/api/auth/login.ts
  - src/types/auth.ts
files:
  - src/api/auth/login.ts
work:
  - 로그인 처리
done_criteria:
  - POST 200 반환
contracts:
  api_endpoints: TBD
  db_tables: []
tdd: true
context_budget_tokens: 20000`;
  const r = load(yaml);
  assert.equal(r.priority, 'P0');
  assert.equal(r.dependencies.length, 1);
  assert.equal(r.dependencies[0].task_id, 'TASK-001');
  assert.equal(r.dependencies[0].kind, 'complete');
  assert.equal(r.allowed_paths.length, 2);
  assert.equal(r.contracts.api_endpoints, 'TBD');
  assert.deepEqual(r.contracts.db_tables, []);
  assert.equal(r.tdd, true);
  assert.equal(r.context_budget_tokens, 20000);
});

test('frontmatter 같은 단순 형태', () => {
  assert.deepEqual(load('educational_mode: false\nprd_source: null'), {
    educational_mode: false, prd_source: null,
  });
});

test('module ownership 형태', () => {
  const yaml = `module: auth
owner_paths:
  - src/api/auth/**
  - src/types/auth.ts
shared_with: []
related_tasks:
  - PROJ-001`;
  const r = load(yaml);
  assert.equal(r.module, 'auth');
  assert.equal(r.owner_paths.length, 2);
  assert.deepEqual(r.shared_with, []);
});
