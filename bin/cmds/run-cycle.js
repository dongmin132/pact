'use strict';

// pact run-cycle — /pact:parallel의 결정적 작업을 압축한 통합 CLI.
//
// prepare: 사전검사 + batch + worktree 생성 + payload·prompt 렌더 (워커 spawn 직전까지)
// collect: status 검증 + merge + worktree cleanup + verification·decisions 요약
//
// 메인 Claude는 Bash 한 번에 prepare/collect 호출로 N개 도구 호출을 1로 압축.
// 11.3M cache_read → ~700k 추정 (batch15 측정 기준).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', '..');

const { discoverTaskFiles, parseTaskFiles } = require(path.join(PLUGIN_ROOT, 'scripts', 'task-sources.js'));
const { buildBatches } = require(path.join(PLUGIN_ROOT, 'batch-builder.js'));
const {
  checkEnvironment,
  createWorktree,
  removeWorktree,
  isMergeInProgress,
  detectBaseBranch,
  reconcileWorktree,
} = require(path.join(PLUGIN_ROOT, 'scripts', 'worktree-manager.js'));
const { prepareWorkerSpawn } = require(path.join(PLUGIN_ROOT, 'scripts', 'spawn-worker.js'));
const { collectLongDocs, DEFAULT_MAX_LINES } = require(path.join(PLUGIN_ROOT, 'bin', 'cmds', 'context-guard.js'));
const { planMerge } = require(path.join(PLUGIN_ROOT, 'bin', 'cmds', 'merge.js'));
const { mergeAll, abortMerge } = require(path.join(PLUGIN_ROOT, 'scripts', 'merge-coordinator.js'));
const { acquireCycleLock, releaseCycleLock, cleanStaleLocks } = require(path.join(PLUGIN_ROOT, 'scripts', 'lock.js'));
const { setTaskStatus } = require(path.join(PLUGIN_ROOT, 'scripts', 'task-sources.js'));
const { writeJsonAtomic } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'atomic-write.js'));

const CURRENT_BATCH_FILE = '.pact/current_batch.json';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/**
 * status 변경(setTaskStatus 가 건드린 task source 파일)을 자동 커밋한다.
 * 무인 멀티사이클 전제 — 안 하면 다음 cycle preflight(isClean)가 'uncommitted'로 막힘.
 * 건드린 파일만 stage (비-pact 변경은 휩쓸지 않음). 스테이징 없으면 skip.
 */
function commitStatusChanges(cwd, statusUpdates) {
  const files = [...new Set((statusUpdates || []).filter(s => s.ok && s.file).map(s => s.file))];
  if (files.length === 0) return { committed: false, reason: 'no status files' };
  const add = spawnSync('git', ['add', ...files], { cwd, encoding: 'utf8' });
  if (add.status !== 0) return { committed: false, error: (add.stderr || '').trim() || 'git add 실패' };
  // 실제 스테이징된 변경이 있나 (exit 0 = 변경 없음)
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd });
  if (staged.status === 0) return { committed: false, reason: 'nothing staged' };
  const commit = spawnSync('git', ['commit', '-m', 'pact: cycle status updates'], { cwd, encoding: 'utf8' });
  if (commit.status !== 0) return { committed: false, error: (commit.stderr || '').trim() || 'git commit 실패' };
  return { committed: true, files };
}

function fail(stage, errors) {
  // throw로 처리해서 try-finally의 unlock이 실행되게.
  // 호출 측이 catch해서 emit + process.exit.
  const e = new Error(`stage ${stage} failed`);
  e.pactStage = stage;
  e.pactErrors = errors;
  throw e;
}

function emitFail(e) {
  // process.exit() 는 finally 블록을 건너뛴다 → cycle.lock 누수. 절대 쓰지 않는다.
  // exitCode만 세팅하고 정상 반환 → 호출부 finally{releaseCycleLock} 실행 후 자연 종료(코드 1).
  emit({ ok: false, stage: e.pactStage, errors: e.pactErrors });
  process.exitCode = 1;
}

function isAlreadyPrepared(cwd) {
  const cb = path.join(cwd, CURRENT_BATCH_FILE);
  if (!fs.existsSync(cb)) return false;
  try {
    const batch = JSON.parse(fs.readFileSync(cb, 'utf8'));
    const taskIds = batch.task_ids || [];
    if (taskIds.length === 0) return false;
    for (const id of taskIds) {
      const wt = path.join(cwd, '.pact', 'worktrees', id);
      const prompt = path.join(cwd, '.pact', 'runs', id, 'prompt.md');
      if (!fs.existsSync(wt) || !fs.existsSync(prompt)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function preflight(cwd) {
  const errors = [];

  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    errors.push({ message: 'CLAUDE.md 없음', fix: '/pact:init 먼저' });
  }

  const taskFiles = discoverTaskFiles({ cwd });
  if (taskFiles.length === 0) {
    errors.push({ message: 'task source(TASKS.md 또는 tasks/*.md) 없음', fix: '/pact:plan 먼저' });
  }

  if (isMergeInProgress({ cwd })) {
    errors.push({ message: '이전 cycle 머지 충돌 미해결', fix: '/pact:resolve-conflict 또는 git merge --abort' });
  }

  const env = checkEnvironment({ cwd });
  if (!env.ok) {
    env.errors.forEach(e => errors.push({ message: e, fix: 'git 환경 정리' }));
  }

  return { ok: errors.length === 0, errors, taskFiles };
}

function parseMaxFlag(args) {
  const i = args.findIndex(a => a === '--max' || a.startsWith('--max='));
  if (i < 0) return null;
  let n;
  if (args[i].startsWith('--max=')) n = Number(args[i].slice(6));
  else n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), 5);
}

function prepare(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const force = args.includes('--force');

  // 진입 시 stale lock(죽은 PID) 자동 정리 — SIGKILL/구버전 누수 self-heal (hook 비의존).
  cleanStaleLocks({ cwd });

  // 멱등 (v0.6.1): 이미 prepared면 skip. --force로 무시 가능.
  if (!force && isAlreadyPrepared(cwd)) {
    emit({
      ok: true,
      already_prepared: true,
      message: '이미 prepare 완료 — current_batch.json + worktrees 존재. --force로 다시 진행.',
    });
    return;
  }

  // preflight를 lock 전에. lock 획득이 .pact/ 만들면 isClean이 false 잡으므로.
  const pre = preflight(cwd);
  if (!pre.ok) {
    emit({ ok: false, stage: 'preflight', errors: pre.errors });
    process.exit(1);
  }

  // 사이클 lock (v0.6.1) — 다른 세션의 prepare/collect 진행 중이면 거부
  const lock = acquireCycleLock({ cwd, stage: 'prepare' });
  if (!lock.ok) {
    emit({ ok: false, stage: 'cycle-busy', errors: [{ message: lock.error, fix: '다른 세션 종료 대기 또는 pact status' }] });
    process.exit(1);
  }

  try {
    doPrepare(args, opts, cwd, pre);
  } catch (e) {
    if (e.pactStage) emitFail(e);
    else throw e;
  } finally {
    releaseCycleLock({ cwd });
  }
}

function doPrepare(args, opts, cwd, pre) {

  const parsed = parseTaskFiles(pre.taskFiles, { cwd });
  if (parsed.errors.length > 0) {
    return fail('task-parse', parsed.errors.map(e => ({
      message: `${e.file || '?'} ${e.taskId || ''}: ${e.error}`,
    })));
  }
  if (parsed.tbdMarkers.length > 0) {
    return fail('tbd', parsed.tbdMarkers.map(m => ({
      message: `${m.taskId}: ${(m.fields || []).join(', ')}`,
      fix: '/pact:contracts 먼저',
    })));
  }

  const userMax = parseMaxFlag(args);
  const maxBatchSize = userMax || 5;
  const plan = buildBatches(parsed.tasks, { maxBatchSize });
  if (plan.error) return fail('batch', [{ message: plan.error }]);

  const batch0 = plan.batches[0] || [];
  if (batch0.length === 0) {
    emit({
      ok: true,
      empty: true,
      message: '실행 가능한 task 없음. /pact:status 또는 /pact:plan.',
    });
    return;
  }

  const contextWarnings = collectLongDocs(DEFAULT_MAX_LINES, { cwd })
    .map(r => ({ file: r.file, lines: r.lines, sharded: r.sharded, fix: r.fix }));

  const skippedCount = plan.skipped ? plan.skipped.length : 0;
  const coordinator_review_needed = batch0.length > 2 || skippedCount > 0;

  // worktree 생성 + payload·prompt 렌더 — atomic, 실패 시 모두 롤백
  const created = [];
  const taskPrompts = [];

  // base branch 자동 감지 (master 기반 repo 지원, 'main' 하드코딩 제거)
  const baseBranch = detectBaseBranch({ cwd });

  for (const task of batch0) {
    // 재진입 stale 자가치유 — 미머지 커밋 없는 cruft 회수 (있으면 보존하고 실패).
    const rec = reconcileWorktree(task.id, baseBranch, { cwd });
    if (!rec.ok) {
      for (const c of created) removeWorktree(c.task_id, { cwd });
      return fail('worktree', [{ task_id: task.id, message: rec.error }]);
    }

    const wt = createWorktree(task.id, baseBranch, { cwd });
    if (!wt.ok) {
      for (const c of created) removeWorktree(c.task_id, { cwd });
      return fail('worktree', [{ task_id: task.id, message: wt.error }]);
    }
    created.push({ task_id: task.id });

    const payload = {
      task_id: task.id,
      title: task.title || '',
      allowed_paths: task.allowed_paths || [],
      forbidden_paths: task.forbidden_paths || [],
      done_criteria: task.done_criteria || [],
      verify_commands: task.verify_commands || [],
      contracts: task.contracts || {},
      context_refs: task.context_refs || [],
      tdd: !!task.tdd,
      educational_mode: !!(parsed.frontmatter && parsed.frontmatter.educational_mode),
      prd_reference: task.prd_reference || null,
      working_dir: wt.working_dir,
      branch_name: wt.branch_name,
      base_branch: baseBranch,
      context_budget_tokens: task.context_budget_tokens || 20000,
    };

    const r = prepareWorkerSpawn(payload, { cwd, runsRoot: path.join(cwd, '.pact/runs') });
    if (!r.ok) {
      for (const c of created) removeWorktree(c.task_id, { cwd });
      return fail('spawn-prepare', [{ task_id: task.id, message: (r.errors || []).join('; ') }]);
    }

    taskPrompts.push({
      task_id: task.id,
      title: task.title || '',
      task_prompt: r.task_prompt,
      prompt_path: path.relative(cwd, r.prompt_path),
      context_path: path.relative(cwd, r.context_path),
      status_path: path.relative(cwd, r.status_path),
      report_path: path.relative(cwd, r.report_path),
      working_dir: wt.working_dir,
    });
  }

  fs.mkdirSync(path.join(cwd, '.pact'), { recursive: true });
  writeJsonAtomic(path.join(cwd, CURRENT_BATCH_FILE), {
    task_ids: batch0.map(t => t.id),
    prepared_at: new Date().toISOString(),
    coordinator_review_needed,
  });

  emit({
    ok: true,
    task_prompts: taskPrompts,
    coordinator_review_needed,
    context_warnings: contextWarnings,
    next_action: '메인이 Task tool로 위 task_prompts들을 한 메시지에서 동시 spawn (subagent_type: worker)',
  });
}

function collect(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  cleanStaleLocks({ cwd });
  const cbPath = path.join(cwd, CURRENT_BATCH_FILE);

  // 멱등 (v0.6.1): current_batch.json 없으면 이미 collect 완료 또는 prepare 안 됨
  if (!fs.existsSync(cbPath)) {
    emit({
      ok: true,
      already_collected: true,
      message: 'current_batch.json 없음 — 이미 collect 완료 또는 prepare 안 됨',
    });
    return;
  }

  // 사이클 lock — 다른 세션이 collect 중이면 거부
  const lock = acquireCycleLock({ cwd, stage: 'collect' });
  if (!lock.ok) {
    return emitFail({ pactStage: 'cycle-busy', pactErrors: [{ message: lock.error }] });
  }

  try {
    doCollect(args, opts, cwd, cbPath);
  } catch (e) {
    if (e.pactStage) emitFail(e);
    else throw e;
  } finally {
    releaseCycleLock({ cwd });
  }
}

function doCollect(args, opts, cwd, cbPath) {
  const currentBatch = JSON.parse(fs.readFileSync(cbPath, 'utf8'));
  const journalPath = path.join(cwd, '.pact/collect-journal.json');

  // 재진입 복구: 이전 collect 가 머지 도중 크래시했나? (MERGE_HEAD 잔존)
  if (isMergeInProgress({ cwd })) {
    if (fs.existsSync(journalPath)) {
      // journal 존재 = 우리(이전 collect)가 시작한 dangling 머지 → abort 후 깨끗이 재개.
      abortMerge({ cwd });
    } else {
      // journal 없음 = pact 가 시작한 머지가 아님(외부/수동) → 건드리지 않고 정지.
      return fail('merge-in-progress', [{
        message: '외부 머지 진행 중(MERGE_HEAD) — pact 가 시작한 머지가 아님',
        fix: '/pact:resolve-conflict 또는 git merge --abort 후 재시도',
      }]);
    }
  }

  // 머지 시작 전 저널 기록 — 크래시 시 "우리 머지"임을 표시 (atomic).
  writeJsonAtomic(journalPath, {
    phase: 'merging',
    task_ids: currentBatch.task_ids,
    started_at: new Date().toISOString(),
  });

  const plan = planMerge({ cwd, taskIds: currentBatch.task_ids });
  const result = mergeAll(plan.eligible, { cwd });

  // ADR-048 — 머지 성공한 task의 source frontmatter에 status:done 박기.
  // (executeMerge 경로는 이미 동일 로직 수행 중; doCollect만 누락이었음.)
  // 다음 cycle의 prepare가 같은 task_id를 후보로 다시 잡지 않게 막는다.
  // merged + already_merged(재진입: 이전 cycle 에 이미 머지됨) 모두 source status done 보장(멱등).
  const alreadyMerged = result.already_merged || [];
  const statusUpdates = [];
  for (const id of [...result.merged, ...alreadyMerged]) {
    const r = setTaskStatus(id, 'done', { cwd });
    statusUpdates.push({ task_id: id, ok: r.ok, action: r.action, file: r.file, error: r.error });
  }

  writeJsonAtomic(path.join(cwd, '.pact/merge-result.json'), {
    timestamp: new Date().toISOString(),
    eligible: plan.eligible.length,
    merged: result.merged,
    already_merged: alreadyMerged,
    conflicted: result.conflicted,
    skipped: result.skipped,
    rejected: plan.rejected,
    status_updates: statusUpdates,
  });

  const cleanup = [];
  for (const id of result.merged) {
    const r = removeWorktree(id, { cwd });
    cleanup.push({ task_id: id, ok: r.ok, error: r.error });
  }

  // verification + decisions 요약 (coordinator integration용)
  const verification = { lint: 'skip', typecheck: 'skip', test: 'skip', build: 'skip' };
  const decisions = [];
  const failures = [];
  for (const id of currentBatch.task_ids) {
    const sp = path.join(cwd, '.pact/runs', id, 'status.json');
    if (!fs.existsSync(sp)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      for (const k of ['lint', 'typecheck', 'test', 'build']) {
        const v = s.verify_results && s.verify_results[k];
        if (!v) continue;
        if (v === 'fail') verification[k] = 'fail';
        else if (verification[k] === 'skip') verification[k] = v;
      }
      if (Array.isArray(s.decisions)) {
        for (const d of s.decisions) decisions.push({ task_id: id, ...d });
      }
      if (s.status !== 'done') {
        failures.push({ task_id: id, status: s.status, blockers: s.blockers || [] });
      }
    } catch { /* skip malformed */ }
  }

  // 무인 멀티사이클: status 변경 자동커밋 (--commit-status). 다음 cycle preflight(isClean) 통과용.
  const statusCommit = args.includes('--commit-status')
    ? commitStatusChanges(cwd, statusUpdates)
    : undefined;

  try { fs.unlinkSync(journalPath); } catch {}
  try { fs.unlinkSync(cbPath); } catch {}

  emit({
    ok: true,
    merged: result.merged,
    already_merged: alreadyMerged,
    rejected: plan.rejected,
    conflicted: result.conflicted,
    skipped: result.skipped,
    failures,
    cleanup,
    status_updates: statusUpdates,
    status_commit: statusCommit,
    verification_summary: verification,
    decisions_to_record: decisions,
  });
}

module.exports = function runCycle(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'prepare') return prepare(rest);
  if (sub === 'collect') return collect(rest);
  console.error('Usage: pact run-cycle <prepare|collect> [--max=N]');
  process.exit(1);
};

module.exports.prepare = prepare;
module.exports.collect = collect;
