'use strict';

// 워커-완료 2.2 — fresh-worker 재개 (resume).
// 워커가 턴/예산 소진으로 미완 종료 = 실패 아님. 부분작업이 worktree 에 보존되므로,
// FRESH 워커가 "처음부터 다시"가 아니라 "이어서" 마저 끝낼 수 있다. 사람 salvage 제거.
// 결정 로직은 순수(여기), 실제 재투입은 드라이버가 같은 worktree 에 spawn.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RESUME = 2; // 회로차단기(철학): 동일 task 재개 ≤ 2회, 초과 시 위임

// 재개할까? 미완(턴/예산 소진)이고 재개 횟수가 cap 미만일 때만.
function shouldResume(result, resumeCount, maxResume = DEFAULT_MAX_RESUME) {
  return !!(result && result.incomplete) && resumeCount < maxResume;
}

// 실 SDK 워커 결과를 {ok, incomplete, reason}로 분류한다.
// incomplete=true = "실패 아니라 미완(부분작업 보존·resume 대상)". incomplete=false = 일시에러(retry).
//
// ⚠️ 라이브 --real 로 발견한 실버그: SDK 는 abort/timeout 시 throw 하지 않고
// subtype='error_during_execution' 인 result 를 **반환**한다 → runWorkerReal 의 catch(=timeout→
// incomplete 의도)가 우회되고, subtype 기반 조건(error_max_*)에도 안 걸려 incomplete=false 로
// 오분류 → resume 대신 retry(같은 timeout 반복) + 부분작업 미보존. 따라서 timedOut/aborted 를
// subtype 보다 우선해 incomplete 로 잡는다.
function classifyRealResult({ subtype, timedOut = false, aborted = false } = {}) {
  if (subtype === 'success') return { ok: true, incomplete: false, reason: 'success' };
  if (timedOut || aborted) return { ok: false, incomplete: true, reason: 'timeout' };
  const incomplete = subtype === 'error_max_budget_usd' || subtype === 'error_max_turns';
  return { ok: false, incomplete, reason: subtype };
}

// DOG-3: 재개 사유를 두 유형으로 구분한다.
//  - 턴/예산 소진(=고칠 것 없음, 그냥 이어서 완료): timeout/max_turns/max_budget/dirty 등.
//  - 게이트·검증 거부(=바로잡을 사유가 있음): schema 위반·clean_for_merge=false·status.json missing 등.
// 후자면 [직전 거부 사유] 한 줄을 접어 넣어 재투입 워커가 뭘 고칠지 알게 한다(실측: 사유가
// continuationPrompt 에 없어 메인이 수동 주입해야 했음). 드라이버가 넘기는 사유는 전부 턴소진형
// 이라 서사·출력이 종전과 동일(회귀 없음).
const TURN_EXHAUSTION_RE = /timeout|max_turns|max_budget|budget|\bturn\b|소진|예산|dirty|미완/i;

function isGateRejection(reason) {
  return typeof reason === 'string' && reason.trim() !== '' && !TURN_EXHAUSTION_RE.test(reason);
}

// fresh 워커용 연속 프롬프트 — "처음부터 다시 X, 부분작업 이어서".
// reason(선택): 직전 거부/미완 사유. 게이트 거부면 서사 분기 + [직전 거부 사유] 한 줄.
function continuationPrompt(task, n, reason = null) {
  const orig = task.task_prompt || '';
  const wt = task.working_dir || '현재';
  const gate = isGateRejection(reason);
  const lead = gate
    ? `[RESUME ${n}] 직전 산출물이 게이트/검증에서 거부됐다 — 턴 소진이 아니라 고쳐야 할 사유가 있다. 부분 작업은 이 worktree(${wt})에 그대로 보존돼 있다.`
    : `[RESUME ${n}] 이전 워커가 턴/예산 소진으로 미완 종료했다. 부분 작업이 이 worktree(${wt})에 그대로 보존돼 있다.`;
  const lines = [lead];
  if (gate) lines.push(`[직전 거부 사유] ${reason} — 이것부터 바로잡아라.`);
  lines.push(
    '처음부터 다시 하지 말 것. 먼저 `git status` + 변경 파일을 확인해 어디까지 됐는지 파악한 뒤,',
    '남은 done_criteria 만 이어서 마저 완료하라. allowed_paths 경계는 동일하게 지킨다.',
    '',
    '--- 원 task ---',
    orig,
  );
  return lines.join('\n');
}

// 연속 프롬프트로 교체한 task 클론 (원본 불변). reason 은 continuationPrompt 로 전달.
function withContinuation(task, n, reason = null) {
  return { ...task, task_prompt: continuationPrompt(task, n, reason), _resume: n };
}

// ---- 영속 회로차단기 (STR-2 / P2-A) ----
// 인터랙티브 /pact:parallel 의 재개 카운트가 LLM 기억에 의존하면 신뢰 불가 → 파일 기반으로 영속.
// .pact/runs/<id>/resume.json 에 누적. 조회(readResumeCount)와 소비(consumeResume)를 분리해
// CLI 가 "몇 번 재개했나"를 부수효과 없이 물어볼 수 있게 한다. 드라이버(driver.mjs)는 이 헬퍼를
// 쓰지 않고 in-loop 카운터로 동작하므로 여기 추가는 드라이버 동작 불변.

// 재개 카운트 영속 경로.
function resumeStatePath(cwd, taskId) {
  return path.join(cwd, '.pact', 'runs', taskId, 'resume.json');
}

// 영속된 재개 횟수 조회 (파일 없거나 손상이면 0). 조회는 부수효과 없음 (파일 생성 X).
function readResumeCount(cwd, taskId) {
  try {
    const j = JSON.parse(fs.readFileSync(resumeStatePath(cwd, taskId), 'utf8'));
    return Number.isInteger(j.count) && j.count >= 0 ? j.count : 0;
  } catch {
    return 0;
  }
}

// 재개 1회 소비 — 카운트 증가 후 영속, 새 카운트 반환.
// cap(maxResume) 도달 시 증가하지 않고 현재 카운트 그대로 반환(회로차단기: 소비 거부 = 위임 신호).
function consumeResume(cwd, taskId, maxResume = DEFAULT_MAX_RESUME) {
  const cur = readResumeCount(cwd, taskId);
  if (cur >= maxResume) return cur;
  const next = cur + 1;
  const p = resumeStatePath(cwd, taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ task_id: taskId, count: next, updated_at: new Date().toISOString() }, null, 2) + '\n');
  return next;
}

// 남은 재개 횟수 (cap - 소비, 음수는 0 clamp).
function resumesRemaining(count, maxResume = DEFAULT_MAX_RESUME) {
  return Math.max(0, maxResume - count);
}

module.exports = {
  shouldResume, classifyRealResult, continuationPrompt, withContinuation, DEFAULT_MAX_RESUME,
  resumeStatePath, readResumeCount, consumeResume, resumesRemaining,
};
