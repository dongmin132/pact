'use strict';

// pact sizecheck — 턴소진 위험 task 정적 사이징 (propose-only)
// 워커가 한 턴에 못 끝낼 만큼 큰 task 를 fan-out 전에 플래그 → 분해 제안.
// salvage("pact가 대신 안 해준 일")의 정적 예방 레버.

// 한 task 평가:
//  - files 명시: 그 개수 기준. > maxFiles → oversized
//  - files 미명시 + 광범위 글롭(**): 범위 무제한 → unbounded
//  - 그 외: 구체 allowed_paths 개수 기준
function assessTask(t, maxFiles = 5) {
  const files = Array.isArray(t.files) ? t.files : null;
  const allowed = Array.isArray(t.allowed_paths) ? t.allowed_paths : [];
  const concrete = allowed.filter((p) => !/[*?[\]{}]/.test(p));
  const hasBroadGlob = allowed.some((p) => p.includes('**'));
  const fileCount = files ? files.length : concrete.length;

  let risk = 'ok';
  let reason = '';
  if (fileCount > maxFiles) {
    risk = 'oversized';
    reason = `${fileCount} 파일 (> ${maxFiles}) — 분해 권장`;
  } else if (hasBroadGlob && !files) {
    risk = 'unbounded';
    reason = '광범위 글롭(**) + files 미명시 — 범위 무제한, 턴소진 위험';
  }
  return { task: t.id, file_count: fileCount, risk, reason };
}

function assessTasks(tasks = [], opt = {}) {
  const max = opt.maxFiles ?? 5;
  return tasks
    .map((t) => assessTask(t, max))
    .filter((r) => r.risk !== 'ok')
    .sort((a, b) => b.file_count - a.file_count || a.task.localeCompare(b.task));
}

function formatJson(rows, maxFiles) {
  return JSON.stringify({ max_files: maxFiles, flagged: rows }, null, 2);
}

function formatHuman(rows, project, maxFiles) {
  const L = [];
  L.push(`pact sizecheck — ${project}   (turn-risk 사이징, propose-only)`);
  L.push(`max-files=${maxFiles}`);
  L.push('');
  if (!rows.length) {
    L.push('✅  턴소진 위험 task 없음.');
  } else {
    L.push(`⚠️  턴소진 위험 task ${rows.length}개`);
    for (const r of rows) {
      L.push(`   [${r.risk}]  ${r.task}  ${r.reason}`);
    }
    L.push('');
    L.push('→ 큰 task는 /pact:plan 으로 분해 — 워커가 턴 안에 끝낼 확률 ↑ (salvage 감소).');
  }
  return L.join('\n');
}

module.exports = { assessTask, assessTasks, formatJson, formatHuman };
