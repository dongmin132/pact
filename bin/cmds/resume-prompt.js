'use strict';

// pact resume-prompt <task_id> [--consume] [--max-resume=N] [--project <path>]
//
// fresh-resume 연속(continuation) 프롬프트의 단일 결정적 소스 (STR-2 / P2-A).
// parallel.md 에 인라인 리터럴로 중복돼 driver.mjs 와 drift 나던 프롬프트를,
// scripts/worker-completion/resume.js 의 continuationPrompt 로 일원화한다.
//
// 회로차단기(철학: 자동 루프 금지)는 LLM 기억이 아니라 파일(.pact/runs/<id>/resume.json)로 영속.
//   조회(기본): 재개했다면 몇 회인지 + 다음 재개 프롬프트 미리보기. 카운트 불변.
//   --consume : 재개 1회 소비(카운트 영속 증가). cap 도달이면 증가 없이 escalate.
//
// 출력 JSON: {task_id, continuationPrompt, resumes_remaining, incomplete_reason?, ...(추가 필드)}.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const {
  continuationPrompt,
  readResumeCount,
  consumeResume,
  resumesRemaining,
  DEFAULT_MAX_RESUME,
} = require(path.join(PLUGIN_ROOT, 'scripts', 'worker-completion', 'resume.js'));
const { makeTaskPrompt } = require(path.join(PLUGIN_ROOT, 'scripts', 'spawn-worker.js'));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function usage() {
  console.error('Usage: pact resume-prompt <task_id> [--consume] [--max-resume=N] [--project <path>]');
}

function parseFlagValue(args, name) {
  const eq = args.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return null;
}

function parseMaxResume(args) {
  const v = parseFlagValue(args, '--max-resume');
  if (v == null) return DEFAULT_MAX_RESUME;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_RESUME;
}

// 결정적 사실만 읽어 재개 필요 여부·사유 판정: merge-result.json 의 rejected/failures + worktree git status.
function assessResumeNeed(cwd, taskId) {
  let reason = null;

  const mrPath = path.join(cwd, '.pact', 'merge-result.json');
  if (fs.existsSync(mrPath)) {
    try {
      const mr = JSON.parse(fs.readFileSync(mrPath, 'utf8'));
      const rej = (mr.rejected || []).find(r => r && r.task_id === taskId);
      if (rej) reason = rej.reason || 'rejected';
      if (!reason) {
        const f = (mr.failures || []).find(x => x && x.task_id === taskId);
        if (f) {
          const blockers = Array.isArray(f.blockers) && f.blockers.length ? `: ${f.blockers.join('; ')}` : '';
          reason = `status=${f.status || 'incomplete'}${blockers}`;
        }
      }
    } catch { /* merge-result 손상 — 비차단 */ }
  }

  // worktree 에 부분작업(dirty)이 남아있나 — 결정적 사실 (git status --porcelain).
  let dirty = false;
  const wt = path.join(cwd, '.pact', 'worktrees', taskId);
  if (fs.existsSync(wt)) {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
    dirty = r.status === 0 && (r.stdout || '').trim() !== '';
  }

  if (!reason && dirty) reason = 'worktree dirty (부분작업 보존)';
  return { needed: !!reason || dirty, reason, dirty };
}

module.exports = function resumePrompt(args) {
  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    usage();
    process.exit(1);
  }

  const cwd = parseFlagValue(args, '--project') || process.cwd();
  const consume = args.includes('--consume');
  const maxResume = parseMaxResume(args);

  // payload → task_prompt 재구성 (makeTaskPrompt 단일소스 = run-cycle.rebuildTaskPrompts 와 동일 렌더).
  const runs = path.join(cwd, '.pact', 'runs', taskId);
  const payloadPath = path.join(runs, 'payload.json');
  if (!fs.existsSync(payloadPath)) {
    console.error(`payload 없음: ${payloadPath} — prepare 안 됐거나 잘못된 task_id`);
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  } catch (e) {
    console.error(`payload.json parse 실패: ${e.message}`);
    process.exit(2);
  }

  const paths = {
    prompt_path: path.join(runs, 'prompt.md'),
    context_path: path.join(runs, 'context.md'),
    status_path: path.join(runs, 'status.json'),
    report_path: path.join(runs, 'report.md'),
  };
  const task = {
    task_id: taskId,
    task_prompt: makeTaskPrompt(payload, paths),
    working_dir: payload.working_dir,
  };

  const need = assessResumeNeed(cwd, taskId);

  // 회로차단기 — 조회(부수효과 없음) vs 소비(영속 증가) 분리.
  // RC-1: escalate 는 driver.mjs 와 동일 예산(재개 ≤ maxResume)을 내야 한다(parallel.md '동일 효과').
  //   소비 모드: consumeResume 이 '실제로 거부'했을 때만 escalate = 소비 전 카운트가 이미 cap 도달.
  //     → RESUME1·RESUME2 둘 다 유효 재투입, 세 번째 미완에서 escalate (드라이버 shouldResume 와 동형:
  //       resumeCount < maxResume 를 소비 전 카운트로 판정). 과거 post-consume remaining===0 판정은
  //       RESUME2 를 만들고도 escalate 를 세워 재개 예산이 절반(1회)으로 줄던 off-by-one 이었다.
  //   조회 모드(부수효과 없음): 이미 cap 도달(remaining===0)이면 다음 소비가 거부될 것이므로 escalate.
  const preCount = readResumeCount(cwd, taskId);
  let count = preCount;
  let escalate;
  if (consume) {
    count = consumeResume(cwd, taskId, maxResume);
    escalate = preCount >= maxResume; // consumeResume 이 증가 없이 거부 = 재개 상한 도달
  } else {
    escalate = resumesRemaining(count, maxResume) === 0;
  }
  const remaining = resumesRemaining(count, maxResume);

  // [RESUME n] 라벨: 소비했으면 방금 소비한 n(=count), 조회면 다음에 예정된 재개(count+1, cap clamp).
  const n = consume ? Math.max(1, count) : Math.min(count + 1, maxResume || count + 1);
  const prompt = continuationPrompt(task, n);

  emit({
    task_id: taskId,
    continuationPrompt: prompt,
    resumes_remaining: remaining,
    resumes_used: count,
    max_resume: maxResume,
    resume_needed: need.needed,
    escalate,
    ...(need.reason ? { incomplete_reason: need.reason } : {}),
  });
};
