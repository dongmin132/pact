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

const PLUGIN_ROOT = path.join(__dirname, '..', '..');

const { discoverTaskFiles, parseTaskFiles } = require(path.join(PLUGIN_ROOT, 'scripts', 'task-sources.js'));
const { buildBatches } = require(path.join(PLUGIN_ROOT, 'batch-builder.js'));
const {
  checkEnvironment,
  createWorktree,
  removeWorktree,
  isMergeInProgress,
} = require(path.join(PLUGIN_ROOT, 'scripts', 'worktree-manager.js'));
const { prepareWorkerSpawn } = require(path.join(PLUGIN_ROOT, 'scripts', 'spawn-worker.js'));
const { collectLongDocs, DEFAULT_MAX_LINES } = require(path.join(PLUGIN_ROOT, 'bin', 'cmds', 'context-guard.js'));
const { planMerge } = require(path.join(PLUGIN_ROOT, 'bin', 'cmds', 'merge.js'));
const { mergeAll } = require(path.join(PLUGIN_ROOT, 'scripts', 'merge-coordinator.js'));

const CURRENT_BATCH_FILE = '.pact/current_batch.json';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(stage, errors) {
  emit({ ok: false, stage, errors });
  process.exit(1);
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

  const pre = preflight(cwd);
  if (!pre.ok) return fail('preflight', pre.errors);

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

  for (const task of batch0) {
    const wt = createWorktree(task.id, 'main', { cwd });
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
      base_branch: 'main',
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
  fs.writeFileSync(path.join(cwd, CURRENT_BATCH_FILE), JSON.stringify({
    task_ids: batch0.map(t => t.id),
    prepared_at: new Date().toISOString(),
    coordinator_review_needed,
  }, null, 2) + '\n');

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
  const cbPath = path.join(cwd, CURRENT_BATCH_FILE);

  if (!fs.existsSync(cbPath)) {
    return fail('no-current-batch', [{ message: 'current_batch.json 없음 — pact run-cycle prepare 먼저' }]);
  }
  const currentBatch = JSON.parse(fs.readFileSync(cbPath, 'utf8'));

  const plan = planMerge({ cwd, taskIds: currentBatch.task_ids });
  const result = mergeAll(plan.eligible, { cwd });

  fs.writeFileSync(path.join(cwd, '.pact/merge-result.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    eligible: plan.eligible.length,
    merged: result.merged,
    conflicted: result.conflicted,
    skipped: result.skipped,
    rejected: plan.rejected,
  }, null, 2) + '\n');

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

  try { fs.unlinkSync(cbPath); } catch {}

  emit({
    ok: true,
    merged: result.merged,
    rejected: plan.rejected,
    conflicted: result.conflicted,
    skipped: result.skipped,
    failures,
    cleanup,
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
