'use strict';

// pact claim <task_id> [<task_id>...] — 멀티세션에서 task 명시적 점유.
// 한 번에 여러 task 가능 (v0.6.2). session_label 자동 인식(H3-2):
//   --session <label> > $PACT_SESSION > $CLAUDE_CODE_SESSION_ID(세션 UUID) > ppid-<세션 pid>
// liveness pid: --owner-pid > $PACT_OWNER_PID > 조부모 세션 pid.
// 이미 살아있는 lock 있으면 거부. stale lock은 takeover.

const fs = require('fs');
const path = require('path');
const { acquireLock } = require('../../scripts/lock.js');
const { sessionPid, sessionId } = require('../../scripts/lib/session-pid.js');

function parseArgs(args) {
  const taskIds = [];
  let sessionLabel = null;
  let ownerPid = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--session' || a === '--label') sessionLabel = args[++i];
    else if (a === '--owner-pid') ownerPid = args[++i];
    else if (a.startsWith('--owner-pid=')) ownerPid = a.slice('--owner-pid='.length);
    else if (!a.startsWith('-')) taskIds.push(a);
  }
  return { taskIds, sessionLabel, ownerPid, json };
}

// session_label = 세션 정체성(H3-2). 세션 UUID(CLAUDE_CODE_SESSION_ID)를 써야 CLI 가 건 락을
// 훅(payload.session_id)이 자기 것으로 인식(자기 락아웃 방지)하고 다른 세션과 구분된다.
// UUID 부재 시에만 조부모 세션 pid 기반 폴백 라벨.
function resolveSessionLabel(explicit) {
  const id = sessionId(explicit);
  if (id) return id;
  return `ppid-${sessionPid()}`;
}

// 락 holder liveness pid (H3-2). 단명 CLI process.pid·즉사 셸 process.ppid 를 쓰면 명령 반환 즉시
// dead-pid stale 이 돼 상호배제가 no-op 이 된다(적대검증 실측). 조부모(=세션 프로세스 claude/터미널)는
// 세션 동안 살아있어 isAlive 판정이 유효하다. 우선순위: --owner-pid > $PACT_OWNER_PID > sessionPid().
function resolveOwnerPid(explicit) {
  const raw = explicit || process.env.PACT_OWNER_PID;
  const n = raw != null ? Number(raw) : NaN;
  // 유효 pid 범위만 채택 — 오버플로/비정수는 조용한 no-op 락(isAlive 가 즉시 false)이 되므로 폴백.
  if (Number.isSafeInteger(n) && n > 0 && n < 2 ** 31) return n;
  return sessionPid();
}

module.exports = function claim(args) {
  const { taskIds, sessionLabel: explicit, ownerPid: explicitPid, json } = parseArgs(args);
  if (taskIds.length === 0) {
    console.error('Usage: pact claim <task_id> [<task_id>...] [--session <label>] [--owner-pid <pid>] [--json]');
    process.exit(2);
  }

  const cwd = process.cwd();
  const sessionLabel = resolveSessionLabel(explicit);
  const ownerPid = resolveOwnerPid(explicitPid);
  const results = [];
  let anyFailed = false;

  for (const taskId of taskIds) {
    const r = acquireLock(taskId, { cwd, sessionLabel, pid: ownerPid });
    const runDir = path.join(cwd, '.pact', 'runs', taskId);
    const worktree = path.join(cwd, '.pact', 'worktrees', taskId);

    if (!r.ok) {
      anyFailed = true;
      results.push({ ok: false, task_id: taskId, error: r.error, holder: r.holder });
      continue;
    }

    results.push({
      ok: true,
      task_id: taskId,
      action: r.action,
      lock_file: r.file,
      session_label: sessionLabel,
      prompt_path: fs.existsSync(path.join(runDir, 'prompt.md')) ? path.join(runDir, 'prompt.md') : null,
      context_path: fs.existsSync(path.join(runDir, 'context.md')) ? path.join(runDir, 'context.md') : null,
      worktree: fs.existsSync(worktree) ? worktree : null,
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: !anyFailed, session_label: sessionLabel, results }, null, 2) + '\n');
    process.exit(anyFailed ? 1 : 0);
  }

  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.task_id} 점유 (${r.action}) — session=${r.session_label}`);
      if (r.worktree) console.log(`  worktree: ${r.worktree}`);
    } else {
      console.error(`✗ ${r.task_id} 실패: ${r.error}`);
    }
  }

  if (!anyFailed && taskIds.length > 0) {
    console.log('\n다음 (단일세션 워커 패턴):');
    console.log(`  cd ${results[0].worktree || '<worktree>'} && claude`);
    console.log('\n다음 (sub-agent 분담 패턴):');
    console.log(`  /pact:parallel    # 내가 잡은 ${taskIds.length}개만 sub-agent로 spawn`);
  }

  process.exit(anyFailed ? 1 : 0);
};

module.exports.resolveSessionLabel = resolveSessionLabel;
module.exports.resolveOwnerPid = resolveOwnerPid;
