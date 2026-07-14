'use strict';

// dogfood 발견 #3 — init 이 생성하는 tasks/example.md 의 placeholder(EXAMPLE-001)가
// 진짜 task 로 파싱되면 TBD 마커(contracts.*) 때문에 `pact batch`/prepare 가 전부 막힌다.
// 신규 사용자가 /pact:init → /pact:plan → /pact:parallel 첫 여정에서 원인 불명의
// "TBD 마커 잔존: EXAMPLE-001" 을 맞는 함정. 예시는 **형식 문서**여야지 task 여선 안 된다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseTasks } = require('../scripts/parse-tasks.js');

test('templates/tasks-example.md — placeholder 는 task 로 파싱되지 않는다(파이프라인 차단 금지)', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'tasks-example.md'), 'utf8');
  const r = parseTasks(md);
  assert.equal((r.tasks || []).length, 0,
    `예시 파일이 실제 task 를 만들면 TBD 게이트가 첫 사이클을 막는다 — 파싱된 task: ${JSON.stringify((r.tasks || []).map(t => t.id))}`);
});

test('templates/tasks-example.md — 사용자가 배울 실제 heading 형식은 안내 문구로 존재', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'tasks-example.md'), 'utf8');
  assert.match(md, /## <PREFIX>-<번호>|## [A-Z]+-\d+`/, '올바른 heading 형식 안내가 있어야 함');
});
