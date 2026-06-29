'use strict';

// pact testguard — test-as-law: 워커가 자기 판정 테스트를 약화 못 하게.
// 정적 분석(propose-only): 구현+자기검증 테스트를 같은 task가 소유하면 플래그.

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessTestGuard, isTestPath } = require('../scripts/testguard.js');

test('isTestPath: 테스트 경로 패턴 인식', () => {
  for (const p of ['src/a.test.ts', 'src/a.spec.js', 'tests/x.ts', 'test/x.ts', 'src/__tests__/x.ts', 'pkg/specs/y.ts']) {
    assert.ok(isTestPath(p), `${p} 는 테스트`);
  }
  for (const p of ['src/a.ts', 'src/api/login.ts', 'src/testimony.ts', 'src/latest.ts']) {
    assert.ok(!isTestPath(p), `${p} 는 테스트 아님`);
  }
});

test('assessTestGuard: 구현+자기테스트 같은 task = 위반, 분리는 OK', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['src/a.ts', 'src/a.test.ts'] },   // 위반: 구현+테스트
    { id: 'B', allowed_paths: ['src/b.ts'] },                    // 구현만 OK
    { id: 'TESTS', allowed_paths: ['tests/**'] },                // 테스트만 = author OK
  ];
  const out = assessTestGuard(tasks);
  assert.equal(out.length, 1, 'A만 위반');
  assert.equal(out[0].task, 'A');
  assert.deepEqual(out[0].test_paths, ['src/a.test.ts']);
  assert.equal(out[0].severity, 'violation');
});

test('assessTestGuard: 광범위 글롭은 테스트 포함 가능 = 약한 경고', () => {
  const tasks = [{ id: 'C', allowed_paths: ['src/feature/**'] }]; // **가 테스트 쓸어담을 수 있음
  const out = assessTestGuard(tasks);
  assert.equal(out.length, 1);
  assert.equal(out[0].task, 'C');
  assert.equal(out[0].severity, 'warn');
});
