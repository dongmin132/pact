'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyChanges, extractPath } = require('../hooks/stop-verify.js');

test('extractPath — 일반 modify 라인', () => {
  assert.equal(extractPath(' M src/api/login.ts'), 'src/api/login.ts');
  assert.equal(extractPath('?? new.ts'), 'new.ts');
  assert.equal(extractPath('A  contracts/api/auth.md'), 'contracts/api/auth.md');
});

test('extractPath — rename 라인은 새 경로 추출', () => {
  assert.equal(extractPath('R  old.ts -> new.ts'), 'new.ts');
});

test('classifyChanges — 코드만 변경 (docs drift 감지 케이스)', () => {
  // porcelain 라인은 첫 글자가 'XY' status code (공백 가능). trim 금지.
  const out = ' M src/api/login.ts\n M src/lib/auth.ts\n';
  const r = classifyChanges(out);
  assert.equal(r.codeChanges, 2);
  assert.equal(r.docsChanges, 0);
  assert.deepEqual(r.codeFiles.sort(), ['src/api/login.ts', 'src/lib/auth.ts']);
});

test('classifyChanges — 코드 + contracts 둘 다 변경 (drift 없음)', () => {
  const out = ' M src/api/login.ts\n M contracts/api/auth.md\n';
  const r = classifyChanges(out);
  assert.equal(r.codeChanges, 1);
  assert.equal(r.docsChanges, 1);
});

test('classifyChanges — PROGRESS.md / MODULE_OWNERSHIP.md / tasks/ 도 docs로 카운트', () => {
  const out = ' M src/x.ts\n M PROGRESS.md\n M MODULE_OWNERSHIP.md\n M tasks/auth.md\n';
  const r = classifyChanges(out);
  assert.equal(r.codeChanges, 1);
  assert.equal(r.docsChanges, 3);
});

test('classifyChanges — README·기타 .md는 docs로 카운트 X (특정 패턴만)', () => {
  const out = ' M src/x.ts\n M README.md\n M docs/random.md\n';
  const r = classifyChanges(out);
  assert.equal(r.codeChanges, 1);
  assert.equal(r.docsChanges, 0, 'README/docs/random은 pact docs 정의에 없음');
});

test('classifyChanges — 빈 출력', () => {
  const r = classifyChanges('');
  assert.equal(r.codeChanges, 0);
  assert.equal(r.docsChanges, 0);
});
