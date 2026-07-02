'use strict';

// pact report-gen — status.json → report.md 결정적 렌더 (SPD-5 · P1-4, 0토큰).
//
// 왜: 워커가 report.md prose 를 손으로 쓰던 종료 ceremony 는 실 LLM 턴이었고, 그 핵심
// 필드(무엇을/문제/결정/verify)는 이미 status.json 의 구조화 필드와 중복이었다. 워커는
// status.json(어차피 머지 게이트라 100% 작성) 만 채우고, report.md 는 이 CLI 가 그
// status.json 에서 결정적으로 파생해 렌더한다 → 별도 prose write 제거 + 과소작성 reject 소거.
//
// 철학5(자동 반영 금지) 정합: 워커가 이미 report.md 를 손으로 썼으면 존중(덮어쓰지 않음).
//   status.json 은 워커 자신이 authored 한 것이고, 여기서 파생 아티팩트를 렌더할 뿐이다
//   (merge-result.json 자동 생성과 동일 범주 — 자동 머지/cross-review 적용이 아님).

const fs = require('fs');
const path = require('path');

// status.json 구조화 필드를 사람이 읽는 report.md 마크다운으로 렌더. 순수 함수(사이드이펙트 X).
function renderReport(status) {
  const s = status && typeof status === 'object' ? status : {};
  const L = [];

  const taskId = s.task_id || '(unknown)';
  const st = s.status || '(unknown)';
  L.push(`# ${taskId} — ${st}`);
  L.push('');
  L.push('> status.json 에서 `pact report-gen` 이 결정적으로 렌더 (워커 수기 작성 아님).');
  L.push('');

  // 요약 — 워커가 status.json.summary 에 남긴 2~4문장 자유 서술(서사 보존). 없으면 명시.
  L.push('## 요약');
  const summary = s.summary != null ? String(s.summary).trim() : '';
  L.push(summary || '(요약 없음 — status.json 에 summary 미작성)');
  L.push('');

  // 변경 파일
  const files = Array.isArray(s.files_changed) ? s.files_changed : [];
  L.push(`## 변경 파일 (${files.length})`);
  if (files.length) files.forEach((f) => L.push(`- ${f}`));
  else L.push('- (없음)');
  L.push('');

  // 검증 결과 (verify_results: lint/typecheck/test/build → pass/fail/skip)
  L.push('## 검증 결과');
  const vr = s.verify_results && typeof s.verify_results === 'object' ? s.verify_results : {};
  const vkeys = Object.keys(vr);
  if (vkeys.length) vkeys.forEach((k) => L.push(`- ${k}: ${vr[k]}`));
  else L.push('- (없음)');
  L.push('');

  // 결정 (DECISIONS.md ADR 후보) — object {topic,choice,rationale} 렌더, 방어적 string 폴백.
  const decisions = Array.isArray(s.decisions) ? s.decisions : [];
  L.push(`## 결정 (${decisions.length})`);
  if (decisions.length) {
    for (const d of decisions) {
      if (d && typeof d === 'object') {
        L.push(`- **${d.topic || ''}** → ${d.choice || ''}`);
        if (d.rationale) L.push(`  - 근거: ${d.rationale}`);
      } else {
        L.push(`- ${String(d)}`);
      }
    }
  } else {
    L.push('- (없음)');
  }
  L.push('');

  // 블로커
  const blockers = Array.isArray(s.blockers) ? s.blockers : [];
  L.push(`## 블로커 (${blockers.length})`);
  if (blockers.length) blockers.forEach((b) => L.push(`- ${b}`));
  else L.push('- (없음)');
  L.push('');

  // 메타
  L.push('## 메타');
  L.push(`- branch: ${s.branch_name || '(없음)'}`);
  L.push(`- commits: ${s.commits_made != null ? s.commits_made : '(미상)'}`);
  if (s.completed_at) L.push(`- completed_at: ${s.completed_at}`);
  L.push('');

  return L.join('\n');
}

// 단일 task 의 status.json → report.md 렌더(디스크 write). 기존 report.md 는 존중(skip).
// @returns {{task_id, ok, action?, reason?, report_path?}}
function generateReport(taskId, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runsRoot = opts.runsRoot || path.join(cwd, '.pact/runs');
  const force = !!opts.force;

  const dir = path.join(runsRoot, taskId);
  const statusPath = path.join(dir, 'status.json');
  const reportPath = path.join(dir, 'report.md');

  if (!fs.existsSync(statusPath)) {
    // status.json 없으면 렌더 불가 — merge 게이트가 별도로 reject 한다(여기선 no-op).
    return { task_id: taskId, ok: false, reason: 'status.json missing' };
  }
  // 워커 수기 report.md 존중 — 자동 덮어쓰기 금지(철학5). --force 로만 재렌더.
  if (!force && fs.existsSync(reportPath)) {
    return { task_id: taskId, ok: true, action: 'skipped', reason: 'report.md exists' };
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch (e) {
    return { task_id: taskId, ok: false, reason: `status.json parse: ${e.message}` };
  }

  const md = renderReport(status);
  fs.writeFileSync(reportPath, md.endsWith('\n') ? md : md + '\n');
  return { task_id: taskId, ok: true, action: 'rendered', report_path: reportPath };
}

// 배치 전체(또는 runs/* 전량) 대상 렌더. 없는 report.md 만 생성.
function generateAll(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runsRoot = opts.runsRoot || path.join(cwd, '.pact/runs');

  let ids = opts.taskIds;
  if (!ids) {
    if (!fs.existsSync(runsRoot)) return [];
    ids = fs.readdirSync(runsRoot).filter((d) => {
      try { return fs.statSync(path.join(runsRoot, d)).isDirectory(); } catch { return false; }
    });
  }
  return ids.map((id) => generateReport(id, { cwd, runsRoot, force: opts.force }));
}

module.exports = { renderReport, generateReport, generateAll };
