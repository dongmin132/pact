'use strict';

// 워커-완료 2.2 — fresh-worker 재개 (resume).
// 워커가 턴/예산 소진으로 미완 종료 = 실패 아님. 부분작업이 worktree 에 보존되므로,
// FRESH 워커가 "처음부터 다시"가 아니라 "이어서" 마저 끝낼 수 있다. 사람 salvage 제거.
// 결정 로직은 순수(여기), 실제 재투입은 드라이버가 같은 worktree 에 spawn.

const DEFAULT_MAX_RESUME = 2; // 회로차단기(철학): 동일 task 재개 ≤ 2회, 초과 시 위임

// 재개할까? 미완(턴/예산 소진)이고 재개 횟수가 cap 미만일 때만.
function shouldResume(result, resumeCount, maxResume = DEFAULT_MAX_RESUME) {
  return !!(result && result.incomplete) && resumeCount < maxResume;
}

// fresh 워커용 연속 프롬프트 — "처음부터 다시 X, 부분작업 이어서".
function continuationPrompt(task, n) {
  const orig = task.task_prompt || '';
  return [
    `[RESUME ${n}] 이전 워커가 턴/예산 소진으로 미완 종료했다. 부분 작업이 이 worktree(${task.working_dir || '현재'})에 그대로 보존돼 있다.`,
    '처음부터 다시 하지 말 것. 먼저 `git status` + 변경 파일을 확인해 어디까지 됐는지 파악한 뒤,',
    '남은 done_criteria 만 이어서 마저 완료하라. allowed_paths 경계는 동일하게 지킨다.',
    '',
    '--- 원 task ---',
    orig,
  ].join('\n');
}

// 연속 프롬프트로 교체한 task 클론 (원본 불변).
function withContinuation(task, n) {
  return { ...task, task_prompt: continuationPrompt(task, n), _resume: n };
}

module.exports = { shouldResume, continuationPrompt, withContinuation, DEFAULT_MAX_RESUME };
