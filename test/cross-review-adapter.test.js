'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../scripts/cross-review/registry.js');
const { createMockAdapter } = require('../scripts/cross-review/adapter.js');

test.beforeEach(() => registry.clear());

test('register — adapter 등록·조회', () => {
  const a = createMockAdapter('test');
  registry.register('test', a);
  assert.equal(registry.get('test'), a);
});

test('register — 인터페이스 미구현 거부', () => {
  assert.throws(() => registry.register('bad', {}));
  assert.throws(() => registry.register('bad', { check_available: () => true }));  // call_review 없음
});

test('register — 동일 이름 중복 거부', () => {
  registry.register('a', createMockAdapter('a'));
  assert.throws(() => registry.register('a', createMockAdapter('a')));
});

test('unregister — 어댑터 제거', () => {
  registry.register('a', createMockAdapter('a'));
  assert.equal(registry.unregister('a'), true);
  assert.equal(registry.get('a'), null);
});

test('listAdapters — 등록된 이름 목록', () => {
  registry.register('codex', createMockAdapter('codex'));
  registry.register('gemini', createMockAdapter('gemini'));
  assert.deepEqual(registry.listAdapters().sort(), ['codex', 'gemini']);
});

test('createMockAdapter — call_review가 미리 정한 findings 반환', async () => {
  const a = createMockAdapter('m', [
    { file: 'src/foo.ts', line: 10, severity: 'warn', message: '주의' },
  ]);
  const r = await a.call_review({ target: 'plan', artifacts: [], context: '' });
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'warn');
});
