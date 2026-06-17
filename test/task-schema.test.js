'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTasksAgainstSchema } = require('../scripts/parse-tasks.js');

const VALID = {
  id: 'PACT-001',
  title: '로그인 API',
  priority: 'P0',
  dependencies: [],
  allowed_paths: ['src/api/auth/login.ts'],
  done_criteria: ['POST 200 반환'],
  tdd: true,
};

test('validateTasksAgainstSchema — 정상 task 통과', () => {
  const r = validateTasksAgainstSchema([VALID]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('필수 필드 누락 (done_criteria 빈 배열) → 거부', () => {
  const r = validateTasksAgainstSchema([{ ...VALID, done_criteria: [] }]);
  assert.equal(r.ok, false);
});

test('files 5개 초과 → 거부', () => {
  const r = validateTasksAgainstSchema([{
    ...VALID,
    files: ['a','b','c','d','e','f'],
  }]);
  assert.equal(r.ok, false);
});

test('priority enum 위반 거부', () => {
  const r = validateTasksAgainstSchema([{ ...VALID, priority: 'critical' }]);
  assert.equal(r.ok, false);
});

test('id 형식 위반 (소문자) 거부', () => {
  const r = validateTasksAgainstSchema([{ ...VALID, id: 'pact-001' }]);
  assert.equal(r.ok, false);
});

test('dependencies 객체 형식 통과', () => {
  const r = validateTasksAgainstSchema([{
    ...VALID,
    dependencies: [{ task_id: 'PACT-000', kind: 'complete' }],
  }]);
  assert.equal(r.ok, true);
});

test('dependencies kind enum 위반 거부', () => {
  const r = validateTasksAgainstSchema([{
    ...VALID,
    dependencies: [{ task_id: 'PACT-000', kind: 'soft' }],
  }]);
  assert.equal(r.ok, false);
});

test('task.schema — loop_until 선택 필드 허용 (count + max_iterations)', () => {
  // 긍정 round-trip: loop_until 포함 task가 실제 validator를 통과하는지 확인
  const r = validateTasksAgainstSchema([{
    ...VALID,
    loop_until: { count: 'rg -c foo src/x.ts', max_iterations: 4 },
  }]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));

  // 구조 확인: validator는 loop_until 내부 required를 강제하지 않는(shallow) 커스텀 구현이므로
  // 스키마 파일에서 직접 선언 구조를 검증한다.
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'task.schema.json'), 'utf8'));
  assert.ok(schema.properties.loop_until, 'loop_until 프로퍼티 정의되어야 함');
  assert.equal(schema.properties.loop_until.properties.count.type, 'string');
  assert.equal(schema.properties.loop_until.properties.max_iterations.type, 'integer');
  assert.ok(!schema.required.includes('loop_until'), 'loop_until은 선택 필드여야 함');
});
