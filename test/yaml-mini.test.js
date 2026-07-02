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

test('기존 주석 동작 회귀 — key: val # comment (STAB-8)', () => {
  assert.deepEqual(load('key: val # comment'), { key: 'val' });
  // 전체 줄 주석, flow 값 뒤 주석
  assert.deepEqual(load('# full line comment\nk: v'), { k: 'v' });
  assert.deepEqual(load('db_tables: []  # none'), { db_tables: [] });
});

test('따옴표 안 # 은 값의 일부로 보존 (STAB-8)', () => {
  // allowed_paths 류 glob 안의 # (공백 없이 붙은 경우)
  assert.deepEqual(load('a: "src/**/*.c#"'), { a: 'src/**/*.c#' });
  // 공백 뒤 # 라도 따옴표 안이면 절단 금지 (기존 regex 는 여기서 오염)
  assert.deepEqual(load('a: "foo # bar"'), { a: 'foo # bar' });
  // block sequence 아이템 안의 따옴표 # 도 보존
  assert.deepEqual(load('allowed_paths:\n  - "a/b #c/d.ts"'), {
    allowed_paths: ['a/b #c/d.ts'],
  });
});

test('공백 없이 붙은 # 은 주석 아님 — 값 보존 (STAB-8)', () => {
  // "a: C#" — # 앞이 공백이 아니므로 주석이 아니라 값
  assert.deepEqual(load('a: C#'), { a: 'C#' });
  assert.deepEqual(load('lang: C#'), { lang: 'C#' });
});

test('flow([...]) 안 # 은 값의 일부로 보존 (STAB-8)', () => {
  // 기존 regex 는 여기서 ` # y", z]` 를 잘라 unclosed inline array 로 throw
  assert.deepEqual(load('a: ["x # y", z]'), { a: ['x # y', 'z'] });
});

test('unterminated quote 에서 throw 안 함 — fail-open 방지 (STAB-8)', () => {
  // readOwnership catch 와 결합 시 allow-all 되므로 stripComment 는 절대 throw X.
  // 애매한 입력이라도 관대하게 원문 유지 방향.
  assert.doesNotThrow(() => load('a: "unterminated # x'));
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

test('중복 키는 throw (버그 B — silent last-wins 방지)', () => {
  // 같은 키가 두 번 나오면 조용히 마지막 값을 채택하지 말고 에러로 표면화
  assert.throws(() => load('status: done\nstatus: todo'), /duplicate key: status/);
  // 정상(중복 없음)은 영향 없어야 함
  assert.deepEqual(load('a: 1\nb: 2'), { a: 1, b: 2 });
});
