'use strict';

// pact claim <task_id> — 멀티세션에서 task 명시적 점유.
// 이미 살아있는 lock 있으면 거부. stale lock은 takeover.
// 성공 시 prompt.md / context.md / worktree 경로 stdout 출력.

const fs = require('fs');
const path = require('path');
const { acquireLock } = require('../../scripts/lock.js');

function parseArgs(args) {
  let taskId = null;
  let sessionLabel = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--session' || a === '--label') sessionLabel = args[++i];
    else if (!taskId && !a.startsWith('-')) taskId = a;
  }
  return { taskId, sessionLabel, json };
}

module.exports = function claim(args) {
  const { taskId, sessionLabel, json } = parseArgs(args);
  if (!taskId) {
    console.error('Usage: pact claim <task_id> [--session <label>] [--json]');
    process.exit(2);
  }

  const cwd = process.cwd();
  const r = acquireLock(taskId, { cwd, sessionLabel });

  if (!r.ok) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, ...r }) + '\n');
    } else {
      console.error(`✗ ${taskId} 점유 실패: ${r.error}`);
    }
    process.exit(1);
  }

  // 경로 정보 수집 (사용자가 다음 단계로 바로 갈 수 있게)
  const runDir = path.join(cwd, '.pact', 'runs', taskId);
  const promptPath = path.join(runDir, 'prompt.md');
  const contextPath = path.join(runDir, 'context.md');
  const worktree = path.join(cwd, '.pact', 'worktrees', taskId);

  const info = {
    ok: true,
    task_id: taskId,
    action: r.action,
    lock_file: r.file,
    prompt_path: fs.existsSync(promptPath) ? promptPath : null,
    context_path: fs.existsSync(contextPath) ? contextPath : null,
    worktree: fs.existsSync(worktree) ? worktree : null,
  };

  if (json) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  } else {
    console.log(`✓ ${taskId} 점유 (${r.action})`);
    if (info.worktree) console.log(`  worktree: ${info.worktree}`);
    if (info.prompt_path) console.log(`  prompt:   ${info.prompt_path}`);
    if (info.context_path) console.log(`  context:  ${info.context_path}`);
    console.log('\n다음:');
    console.log(`  cd ${info.worktree || '<worktree>'}`);
    console.log(`  claude          # 새 세션에서 시작, prompt.md를 첫 입력으로`);
  }
};
