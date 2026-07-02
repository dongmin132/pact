'use strict';

// pact scopecheck — done_criteria ⊄ allowed_paths 계약모순 정적 검출 (propose-only) 테스트.
//
// 근거 사례(brewdy CLEANUP-029): allowed_paths=apps/mobile/components/meetup/** 인데
// done_criteria 가 `docs/ui/cleanup-011-review.md` **생성**을 의무화 → 워커가 task 충실
// 이행 → merge 게이트가 files_attempted_outside_scope 로 통째 거부 → 16분·$3.91 낭비.
// scopecheck 는 그 계약모순을 fan-out 전에 정적으로 잡는다.

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessTask, assessTasks, summarizeByDir } = require('../scripts/scopecheck.js');

test('assessTask: 생성 동사 + allowed_paths 밖 파일 = scope_contradiction (029 실사례)', () => {
  const r = assessTask({
    id: 'CLEANUP-029',
    allowed_paths: ['apps/mobile/components/meetup/**'],
    done_criteria: [
      'eslint components/meetup/HostGuestListModal.tsx --max-warnings=0 exit 0',
      'git diff --stat HEAD 가 이 chunk files 외 변경 0',
      'typecheck exit 0',
      'review gate: raw-hex 수정 시 `docs/ui/cleanup-011-review.md` 생성 의무. 필수 필드 4종.',
    ],
  });
  assert.equal(r.risk, 'scope_contradiction');
  assert.equal(r.violations.length, 1, '생성 의무 1건만');
  assert.equal(r.violations[0].path, 'docs/ui/cleanup-011-review.md');
});

test('assessTask: 검증-only path 언급(생성 동사 없음)은 오탐 아님', () => {
  // 029 #1 — components/meetup/*.tsx 는 apps/mobile/** 밖처럼 보이지만 eslint 실행일 뿐.
  const r = assessTask({
    id: 'VERIFY-ONLY',
    allowed_paths: ['apps/mobile/components/meetup/**'],
    done_criteria: [
      'eslint components/meetup/HostGuestListModal.tsx --max-warnings=0 exit 0',
    ],
  });
  assert.equal(r.risk, 'ok');
});

test('assessTask: 생성 동사 + allowed_paths 안쪽 파일 = ok', () => {
  const r = assessTask({
    id: 'IN-SCOPE',
    allowed_paths: ['docs/ui/**'],
    done_criteria: ['`docs/ui/dark-mode-strategy.md` 산출 완료'],
  });
  assert.equal(r.risk, 'ok');
});

test('assessTask: path 없는 자연어 criteria = ok', () => {
  const r = assessTask({
    id: 'NO-PATH',
    allowed_paths: ['src/**'],
    done_criteria: ['POST 200 반환', 'typecheck exit 0'],
  });
  assert.equal(r.risk, 'ok');
});

test('assessTask: 구체 allowed_paths 가 생성 파일을 정확히 커버하면 ok', () => {
  const r = assessTask({
    id: 'EXACT',
    allowed_paths: ['docs/report.md'],
    done_criteria: ['`docs/report.md` 작성'],
  });
  assert.equal(r.risk, 'ok');
});

test('assessTask: 한 task 에 위반 여러 건', () => {
  const r = assessTask({
    id: 'MULTI',
    allowed_paths: ['src/**'],
    done_criteria: [
      '`docs/a-review.md` 생성',
      '`reports/b.md` 산출 완료',
    ],
  });
  assert.equal(r.risk, 'scope_contradiction');
  assert.equal(r.violations.length, 2);
});

test('assessTask: done_criteria 없으면 ok', () => {
  const r = assessTask({ id: 'BARE', allowed_paths: ['src/**'] });
  assert.equal(r.risk, 'ok');
});

test('assessTask: allowed_paths 없으면 ok (검사 대상 아님)', () => {
  const r = assessTask({ id: 'NOALLOW', done_criteria: ['`docs/x.md` 생성'] });
  assert.equal(r.risk, 'ok');
});

test('assessTasks: 위반 task 만 필터, id 정렬', () => {
  const tasks = [
    { id: 'B-002', allowed_paths: ['src/**'], done_criteria: ['`docs/x.md` 생성'] },
    { id: 'A-001', allowed_paths: ['src/**'], done_criteria: ['POST 200'] },
    { id: 'C-003', allowed_paths: ['src/**'], done_criteria: ['`out/y.md` 작성'] },
  ];
  const out = assessTasks(tasks);
  assert.equal(out.length, 2, 'A-001 은 위반 없음 → 제외');
  assert.deepEqual(out.map((r) => r.task), ['B-002', 'C-003']);
});

test('summarizeByDir: 같은 밖-디렉토리 계약모순을 시스템 패턴으로 롤업 (educational-mode 실사례)', () => {
  // brewdy: 37개 task 가 docs/learning/<id>.md 를 allowed_paths 밖에서 생성 의무화.
  const rows = [
    { task: 'AUTH-001', risk: 'scope_contradiction', violations: [{ path: 'docs/learning/AUTH-001.md', criterion: 'x' }] },
    { task: 'AUTH-002', risk: 'scope_contradiction', violations: [{ path: 'docs/learning/AUTH-002.md', criterion: 'x' }] },
    { task: 'CHAT-001', risk: 'scope_contradiction', violations: [
      { path: 'docs/learning/CHAT-001.md', criterion: 'x' },
      { path: 'reports/chat.md', criterion: 'y' },
    ] },
  ];
  const g = summarizeByDir(rows);
  const learning = g.find((x) => x.dir === 'docs/learning');
  assert.ok(learning, 'docs/learning 그룹 존재');
  assert.equal(learning.count, 3, '3개 task 가 docs/learning 밖 생성');
  // count 내림차순 정렬 → 시스템 패턴이 맨 위
  assert.equal(g[0].dir, 'docs/learning');
});
