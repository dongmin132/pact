'use strict';

// pact drift — reflect 의 드리프트 사전수집을 결정적으로 (A-3, read-only).
//
// 왜: /pact:reflect 는 매번 planner(LLM)를 호출했다. 그런데 "마지막 머지 이후 아무것도 안
// 변했고 실패도 없다"는 판단이 아니라 결정적 사실이다 → 그 사실 산출은 CLI 가 0토큰으로.
// reflect 는 이 결과가 clean 이면 planner 호출을 통째 건너뛴다(깨끗한 사이클 회고 비용 ~3M→0).
//
// metrics/scopecheck/sizecheck/testguard 와 같은 read-only·propose-only 패밀리.
// git 은 log(읽기 전용)만 호출한다.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// reflect.md 단계 1.5 와 동일 분류 기준 (단일소스화를 위해 여기로 이동)
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb)$/;
const SOT_RE = /^(contracts\/|tasks\/|docs\/.*\.md$|PROGRESS\.md|ARCHITECTURE\.md|CLAUDE\.md)/;

/**
 * 마지막 머지 이후의 드리프트·실패 사실을 결정적으로 계산한다.
 * @param {{cwd?:string}} [opts]
 * @returns {{ok:boolean, clean:boolean, no_cycle?:boolean, standalone_merge?:boolean,
 *   last_merge_ts?:string|null, code_changed?:string[], docs_changed?:string[],
 *   failures?:Array, rejected_count?:number, verify_fails?:string[],
 *   verification_summary?:object, decisions_to_record?:Array, error?:string}}
 */
function computeDrift(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const mrPath = path.join(cwd, '.pact', 'merge-result.json');

  if (!fs.existsSync(mrPath)) {
    // 사이클 전 — 드리프트 기준점(마지막 머지)이 없어 판단 불가. clean 이 아니라고 보고
    // reflect 가 기존 경로(planner)로 가게 한다 (fail-open: LLM skip 은 확실할 때만).
    return { ok: true, no_cycle: true, clean: false };
  }

  let mr;
  try { mr = JSON.parse(fs.readFileSync(mrPath, 'utf8')); }
  catch (e) { return { ok: false, clean: false, error: `merge-result.json parse: ${e.message}` }; }

  const ts = typeof mr.timestamp === 'string' ? mr.timestamp : null;
  const failures = Array.isArray(mr.failures) ? mr.failures : [];
  const rejected = Array.isArray(mr.rejected) ? mr.rejected : [];
  const verification = (mr.verification_summary && typeof mr.verification_summary === 'object') ? mr.verification_summary : {};
  const verifyFails = Object.entries(verification).filter(([, v]) => v === 'fail').map(([k]) => k);
  const decisions = Array.isArray(mr.decisions_to_record) ? mr.decisions_to_record : [];
  // standalone `pact merge` 경로엔 요약 필드가 없다 → planner 가 status.json 폴백(reflect 단계 1.6 규약)
  const standaloneMerge = !('failures' in mr) && !('verification_summary' in mr) && !('decisions_to_record' in mr);

  // 마지막 머지 이후 커밋된 변경 파일 (git log — 읽기 전용)
  let changed = [];
  if (ts) {
    const r = spawnSync('git', ['log', `--since=${ts}`, '--name-only', '--pretty=format:'], { cwd, encoding: 'utf8' });
    if (r.status === 0) {
      changed = [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
    }
  }
  const codeChanged = changed.filter((f) => CODE_RE.test(f));
  const docsChanged = changed.filter((f) => SOT_RE.test(f));

  const clean = codeChanged.length === 0
    && failures.length === 0
    && rejected.length === 0
    && verifyFails.length === 0;

  return {
    ok: true,
    clean,
    ...(standaloneMerge ? { standalone_merge: true } : {}),
    last_merge_ts: ts,
    code_changed: codeChanged,
    docs_changed: docsChanged,
    failures,
    rejected_count: rejected.length,
    verify_fails: verifyFails,
    verification_summary: verification,
    decisions_to_record: decisions,
  };
}

module.exports = { computeDrift };
