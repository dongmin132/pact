'use strict';

// DOG-2: prompts/worker-system.md 의 status.json 최소 skeleton 예시가 실제 스키마와 정합인지 고정.
// 실측 결함: 실워커 2/3 이 verify_results:"skip"(문자열)·changed_paths(오필드)·clean_for_merge
// 누락으로 머지 게이트에 반복 거부(재투입 3회 낭비). skeleton 예시를 문서에 넣되, 예시가 스키마와
// drift 나면(예: 필드명·타입이 어긋나면) 이 테스트가 잡는다 — 문서=계약 정합의 회귀 봉쇄.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateStatus } = require('../scripts/validate-status.js');

const DOC = path.join(__dirname, '..', 'prompts', 'worker-system.md');

function extractSkeleton() {
  const md = fs.readFileSync(DOC, 'utf8');
  const anchor = md.indexOf('최소 skeleton');
  assert.ok(anchor >= 0, 'worker-system.md 에 "최소 skeleton" 절이 있어야 함');
  const m = md.slice(anchor).match(/```json\s*([\s\S]*?)```/);
  assert.ok(m, 'skeleton 절 뒤에 ```json 예시 블록이 있어야 함');
  // 렌더러(spawn-worker.js)가 {{task_id}} 를 실제 task_id 로 치환하듯 치환 후 파싱·검증.
  return m[1].replace(/\{\{task_id\}\}/g, 'PROJ-001');
}

test('doc-lint(DOG-2): worker-system.md status.json skeleton 이 validate-mini 통과 (스키마 정합)', () => {
  const raw = extractSkeleton();
  let obj;
  assert.doesNotThrow(() => { obj = JSON.parse(raw); }, 'skeleton 은 valid JSON 이어야 함');
  const r = validateStatus(obj);
  assert.equal(r.ok, true, `skeleton 이 스키마 위반: ${JSON.stringify(r.errors)}`);
});

test('doc-lint(DOG-2): 워커가 자주 틀리던 필드가 정확한 이름·타입으로 예시에 존재', () => {
  const obj = JSON.parse(extractSkeleton());
  // 실측 오류 3종을 정확한 형태로 못박는다.
  assert.ok('files_changed' in obj, "정확한 필드명 'files_changed' (changed_paths 아님)");
  assert.ok(!('changed_paths' in obj), "오필드 'changed_paths' 는 예시에 없어야");
  assert.equal(typeof obj.clean_for_merge, 'boolean', 'clean_for_merge 는 boolean');
  assert.ok(
    obj.verify_results && typeof obj.verify_results === 'object' && !Array.isArray(obj.verify_results),
    'verify_results 는 object (문자열 "skip" 아님)',
  );
});
