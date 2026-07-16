'use strict';

// pact claim <task_id> [<task_id>...] — 멀티세션에서 task 명시적 점유.
// 한 번에 여러 task 가능 (v0.6.2). session_label 자동 인식:
//   --session <label> > $PACT_SESSION > process.ppid (부모 셸 PID)
// 이미 살아있는 lock 있으면 거부. stale lock은 takeover.

const fs = require('fs');
const path = require('path');
const { acquireLock } = require('../../scripts/lock.js');

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

function resolveSessionLabel(explicit) {
  if (explicit) return explicit;
  if (process.env.PACT_SESSION) return process.env.PACT_SESSION;
  // 자동: 부모 셸 PID (PPID). 셸이 살아있는 동안 동일 세션으로 인식됨.
  return `ppid-${process.ppid}`;
}

// 락 holder 로 기록할 세션 수명 pid (H3). 단명 CLI process.pid 를 쓰면 명령 반환 즉시
// dead-pid stale 이 돼 상호배제가 no-op 이 된다. 부모 셸(PPID)은 세션이 사는 동안 살아있어
// isAlive 판정이 유효하다. 우선순위: --owner-pid > $PACT_OWNER_PID > process.ppid.
// (parallel.md 의 prepare --owner-pid=$PPID 관례와 동일.)
function resolveOwnerPid(explicit) {
  const raw = explicit || process.env.PACT_OWNER_PID;
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isInteger(n) && n > 0) return n;
  return process.ppid;
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
