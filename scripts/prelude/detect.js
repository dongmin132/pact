'use strict';

// pact prelude — detect.js
// tasks 의 allowed_paths 에서 공유표면을 찾는다.
// freeze 후보 = 구체파일(글롭 아님)이 ≥ minShare task 에 공유.
// shard 후보 = 글롭 디렉토리가 ≥ minShare task 에 공유 (표시만, freeze 안 함).

const isGlob = (p) => /[*?[\]{}]/.test(p);
// .md 는 append형(문서·로그·task-def·계약·DECISIONS/PROGRESS) — 소비형 아님 → freeze 제외.
const isFreezable = (p) => !/\.md$/i.test(p);

function detectFreezeCandidates(tasks = [], minShare = 3) {
  const concrete = new Map(); // path -> Set(taskId)
  const globs = new Map();
  for (const t of tasks) {
    for (const p of t.allowed_paths || []) {
      if (isGlob(p)) {
        if (!globs.has(p)) globs.set(p, new Set());
        globs.get(p).add(t.id);
      } else if (isFreezable(p)) {
        if (!concrete.has(p)) concrete.set(p, new Set());
        concrete.get(p).add(t.id);
      }
    }
  }
  const collect = (m) =>
    [...m.entries()]
      .filter(([, s]) => s.size >= minShare)
      .map(([path, s]) => ({ path, tasks: [...s].sort() }))
      .sort((a, b) => b.tasks.length - a.tasks.length || a.path.localeCompare(b.path));
  return { freeze: collect(concrete), shardCandidates: collect(globs) };
}

module.exports = { detectFreezeCandidates, isGlob, isFreezable };
