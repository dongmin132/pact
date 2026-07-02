'use strict';

// context-bundle — worker context.md 빌더.
// 핵심 회귀: anchor 없는 tasks ref 가 파일 전체(147KB/2458줄)를 번들해 워커 토큰 세금을 폭증시키던 문제
// (실측 CLEANUP-029). anchor 없으면 task_id 섹션만 자동 슬라이스.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderContextBundle, readContextRef, writeContextBundle } = require('../scripts/context-bundle.js');

function tmpWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-ctx-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const TASKS_MD = [
  '## CLEANUP-029  HostGuestListModal token 매핑',
  '',
  'allowed_paths: [components/meetup/**]',
  'AAA-only-marker',
  '',
  '## CLEANUP-030  LocationPicker token 매핑',
  '',
  'BBB-other-task-marker',
  '',
].join('\n');

test('context bundle — anchor 없는 tasks ref 는 task_id 섹션만 자동 슬라이스 (029 bloat 회귀)', () => {
  const dir = tmpWith({ 'tasks/cleanup.md': TASKS_MD });
  const out = renderContextBundle(
    { task_id: 'CLEANUP-029', context_refs: ['tasks/cleanup.md'] },
    { cwd: dir });
  assert.match(out, /AAA-only-marker/);              // 내 섹션은 포함
  assert.doesNotMatch(out, /BBB-other-task-marker/); // 다른 task 섹션은 제외 (전체 번들 방지)
  assert.match(out, /자동 슬라이스/);                // slice 표식
});

test('context bundle — task_id heading 없으면 전체 포함 (계약 shard fallback 유지)', () => {
  const dir = tmpWith({ 'contracts/api/auth.md': '# Auth API\nPOST /login\nCONTRACT-BODY\n' });
  const out = renderContextBundle(
    { task_id: 'CLEANUP-029', context_refs: ['contracts/api/auth.md'] },
    { cwd: dir });
  assert.match(out, /CONTRACT-BODY/); // task_id·anchor 매칭 없음 → 통째 (계약은 통독 의도)
});

test('context bundle — 명시 #anchor 는 그 섹션만 (기존 동작 유지)', () => {
  const dir = tmpWith({ 'contracts/api/auth.md': '# Auth\n## Login\nLOGIN-SEC\n## Logout\nLOGOUT-SEC\n' });
  const out = renderContextBundle(
    { task_id: 'T1', context_refs: ['contracts/api/auth.md#Login'] },
    { cwd: dir });
  assert.match(out, /LOGIN-SEC/);
  assert.doesNotMatch(out, /LOGOUT-SEC/);
});

test('readContextRef — anchor 없고 task_id 매칭 시 auto_sliced 플래그', () => {
  const dir = tmpWith({ 'tasks/cleanup.md': TASKS_MD });
  const r = readContextRef('tasks/cleanup.md', { cwd: dir, taskId: 'CLEANUP-029' });
  assert.equal(r.ok, true);
  assert.equal(r.auto_sliced, true);
  assert.match(r.content, /AAA-only-marker/);
  assert.doesNotMatch(r.content, /BBB-other-task-marker/);
});

// ─── TOK-4: context_refs 3중 나열 제거 — Slices 를 canonical SOT 로 ───

test('TOK-4 — 잉여 "## Context refs" 리스트 제거, Slices canonical 유지', () => {
  const dir = tmpWith({ 'tasks/cleanup.md': TASKS_MD });
  const out = renderContextBundle(
    { task_id: 'CLEANUP-029', context_refs: ['tasks/cleanup.md'] },
    { cwd: dir });
  assert.doesNotMatch(out, /## Context refs/); // 잉여 리스트 블록 삭제
  assert.match(out, /## Slices/);              // canonical 위치는 유지
  assert.match(out, /### tasks\/cleanup\.md/); // ref 는 Slices 헤딩에 1회만
  assert.match(out, /AAA-only-marker/);        // 슬라이스 내용 손실 없음
});

// ─── TOK-3(1부): anchor 없는 대형 shard 를 bundle_warnings 로 가시화 ───

const BIG_SHARD = ['# Big Contract'].concat(
  Array.from({ length: 250 }, (_, i) => `line ${i}`)).join('\n');

test('TOK-3 — anchor 없이 통째 포함된 대형 shard 는 bundle_warnings 에 집계', () => {
  const dir = tmpWith({ 'contracts/api/big.md': BIG_SHARD });
  const outPath = path.join(dir, 'out', 'context.md');
  const res = writeContextBundle(
    { task_id: 'CLEANUP-029', context_refs: ['contracts/api/big.md'] },
    outPath, { cwd: dir });
  assert.ok(Array.isArray(res.bundle_warnings));
  assert.equal(res.bundle_warnings.length, 1);
  assert.equal(res.bundle_warnings[0].ref, 'contracts/api/big.md');
  assert.equal(res.bundle_warnings[0].reason, 'no_anchor_full_include');
  assert.ok(res.bundle_warnings[0].lines > 200);
});

test('TOK-3 — 자동 슬라이스/앵커 ref 는 bundle_warnings 없음 (비파괴 반환)', () => {
  const dir = tmpWith({ 'tasks/cleanup.md': TASKS_MD });
  const outPath = path.join(dir, 'out', 'context.md');
  const res = writeContextBundle(
    { task_id: 'CLEANUP-029', context_refs: ['tasks/cleanup.md'] },
    outPath, { cwd: dir });
  assert.equal(res.path, outPath);       // 기존 필드 유지
  assert.equal(typeof res.content, 'string');
  assert.deepEqual(res.bundle_warnings, []);
});
