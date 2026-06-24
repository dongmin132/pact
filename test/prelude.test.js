'use strict';

// pact prelude — detect(공유표면 탐지) + propose(계획변형) 순수함수 테스트.

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFreezeCandidates } = require('../scripts/prelude/detect.js');
const { proposePreludes } = require('../scripts/prelude/propose.js');

// ── detect ──────────────────────────────────────────────────────
test('detectFreezeCandidates: 구체파일 ≥min = freeze, 글롭 = shard후보, <min 제외', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['src/types/auth.ts', 'src/a.ts'] },
    { id: 'B', allowed_paths: ['src/types/auth.ts', 'src/b.ts'] },
    { id: 'C', allowed_paths: ['src/types/auth.ts', 'components/ui/**'] },
    { id: 'D', allowed_paths: ['components/ui/**'] },
    { id: 'E', allowed_paths: ['components/ui/**'] },
    { id: 'F', allowed_paths: ['src/pair.ts'] },
    { id: 'G', allowed_paths: ['src/pair.ts'] }, // 2개만 — 제외(min 3)
  ];
  const { freeze, shardCandidates } = detectFreezeCandidates(tasks, 3);

  assert.equal(freeze.length, 1, '구체파일 freeze 1개');
  assert.equal(freeze[0].path, 'src/types/auth.ts');
  assert.deepEqual(freeze[0].tasks, ['A', 'B', 'C']);

  assert.equal(shardCandidates.length, 1, '글롭 shard후보 1개');
  assert.equal(shardCandidates[0].path, 'components/ui/**');
  assert.deepEqual(shardCandidates[0].tasks, ['C', 'D', 'E']);
});

test('detectFreezeCandidates: .md(append형 메타/문서)는 freeze 제외', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['DECISIONS.md', 'PROGRESS.md', 'src/x.ts'] },
    { id: 'B', allowed_paths: ['DECISIONS.md', 'PROGRESS.md', 'src/x.ts'] },
    { id: 'C', allowed_paths: ['DECISIONS.md', 'PROGRESS.md', 'src/x.ts'] },
  ];
  const { freeze } = detectFreezeCandidates(tasks, 3);
  assert.deepEqual(freeze.map((f) => f.path), ['src/x.ts'], '.md 제외, 코드파일만');
});

// ── propose ─────────────────────────────────────────────────────
test('proposePreludes: parent dir 클러스터 → prelude + 의존 재작성', () => {
  const tasks = [
    { id: 'A', allowed_paths: ['src/types/auth.ts', 'src/types/user.ts', 'src/a.ts'] },
    { id: 'B', allowed_paths: ['src/types/auth.ts', 'src/types/user.ts'] },
    { id: 'C', allowed_paths: ['src/types/auth.ts', 'supabase/functions/_shared/x.ts'] },
    { id: 'D', allowed_paths: ['supabase/functions/_shared/x.ts'] },
    { id: 'E', allowed_paths: ['supabase/functions/_shared/x.ts'] },
  ];
  const { freeze } = detectFreezeCandidates(tasks, 3);
  // auth.ts(A,B,C)=3, _shared/x.ts(C,D,E)=3 freeze. user.ts(A,B)=2 제외.
  const { preludes, rewrites } = proposePreludes(tasks, freeze);

  assert.equal(preludes.length, 2, '두 parent dir → prelude 2개');
  assert.equal(preludes[0].id, 'PRELUDE-001');
  assert.equal(preludes[0].dir, 'src/types');
  assert.deepEqual(preludes[0].allowed_paths, ['src/types/auth.ts']);
  assert.equal(preludes[1].id, 'PRELUDE-002');
  assert.equal(preludes[1].dir, 'supabase/functions/_shared');

  const byTask = Object.fromEntries(rewrites.map((r) => [r.task, r]));
  assert.deepEqual(byTask.C.deps, ['PRELUDE-001', 'PRELUDE-002'], 'C는 두 prelude 의존');
  assert.deepEqual(byTask.C.removed_paths, ['src/types/auth.ts', 'supabase/functions/_shared/x.ts']);
  assert.deepEqual(byTask.A.removed_paths, ['src/types/auth.ts'], 'user.ts는 freeze 아니라 안 빠짐');
  assert.ok(!byTask.A.removed_paths.includes('src/types/user.ts'));
});

test('proposePreludes: freeze 없으면 빈 제안', () => {
  const { preludes, rewrites } = proposePreludes([{ id: 'A', allowed_paths: ['src/a.ts'] }], []);
  assert.deepEqual(preludes, []);
  assert.deepEqual(rewrites, []);
});
