'use strict';

// pact prelude — propose.js
// freeze 후보 → 계획 변형 제안 (propose-only, 여기선 데이터만 생성).
//   - freeze 파일을 parent dir 로 클러스터링 → 클러스터당 prelude task 1개
//   - 그 파일을 declare 한 task = 의존: prelude 에 complete dep + 파일 제거(→forbidden)

function parentDir(p) {
  const d = p.split('/').slice(0, -1).join('/');
  return d || '.';
}

function proposePreludes(tasks = [], freeze = []) {
  // 1) freeze 파일을 parent dir 로 클러스터
  const byDir = new Map(); // dir -> [path]
  for (const f of freeze) {
    const d = parentDir(f.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f.path);
  }

  // 2) 클러스터당 prelude task (PRELUDE-001..)
  const dirs = [...byDir.keys()].sort();
  const preludes = [];
  const frozenToPrelude = new Map(); // path -> preludeId
  dirs.forEach((d, i) => {
    const id = `PRELUDE-${String(i + 1).padStart(3, '0')}`;
    const paths = byDir.get(d).slice().sort();
    preludes.push({ id, dir: d, allowed_paths: paths });
    for (const p of paths) frozenToPrelude.set(p, id);
  });

  // 3) 의존 task 재작성 (freeze 파일을 declare 한 task)
  const rewriteMap = new Map(); // taskId -> {task, deps:Set, removed:Set}
  for (const t of tasks) {
    for (const p of t.allowed_paths || []) {
      const pid = frozenToPrelude.get(p);
      if (!pid || t.id === pid) continue;
      if (!rewriteMap.has(t.id)) rewriteMap.set(t.id, { task: t.id, deps: new Set(), removed: new Set() });
      rewriteMap.get(t.id).deps.add(pid);
      rewriteMap.get(t.id).removed.add(p);
    }
  }
  const rewrites = [...rewriteMap.values()]
    .map((r) => ({ task: r.task, deps: [...r.deps].sort(), removed_paths: [...r.removed].sort() }))
    .sort((a, b) => a.task.localeCompare(b.task));

  return { preludes, rewrites };
}

module.exports = { proposePreludes, parentDir };
