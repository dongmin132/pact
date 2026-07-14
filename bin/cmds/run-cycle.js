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
const {
  buildBatches,
  pathsOverlap,
  depTaskId,
  allDependenciesMet,
} = require(path.join(PLUGIN_ROOT, 'batch-builder.js'));
const {
  checkEnvironment,
  createWorktree,
  removeWorktree,
  isMergeInProgress,
  detectBaseBranch,
  reconcileWorktree,
} = require(path.join(PLUGIN_ROOT, 'scripts', 'worktree-manager.js'));
const { prepareWorkerSpawn, makeTaskPrompt } = require(path.join(PLUGIN_ROOT, 'scripts', 'spawn-worker.js'));
const { collectLongDocs, DEFAULT_MAX_LINES } = require(path.join(PLUGIN_ROOT, 'scripts', 'context-guard.js'));
const { assessTasks: assessSizes } = require(path.join(PLUGIN_ROOT, 'scripts', 'sizecheck.js'));
const { assessTasks: assessScopes, assessOwnership } = require(path.join(PLUGIN_ROOT, 'scripts', 'scopecheck.js'));
const { generateAll: generateReports } = require(path.join(PLUGIN_ROOT, 'scripts', 'report-gen.js'));
const { planMerge, mergeAll, mergeWorktree, abortMerge } = require(path.join(PLUGIN_ROOT, 'scripts', 'merge-coordinator.js'));
const { acquireCycleLock, releaseCycleLock, cleanStaleLocks, isAlive } = require(path.join(PLUGIN_ROOT, 'scripts', 'lock.js'));
const { setTaskStatus } = require(path.join(PLUGIN_ROOT, 'scripts', 'task-sources.js'));
const { writeJsonAtomic } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'atomic-write.js'));

const CURRENT_BATCH_FILE = '.pact/current_batch.json';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ─── STAB-1: 멀티세션 owner-pid 게이트 ───────────────────────────────────────
// 문제: 사이클 락은 prepare/collect CLI 호출만 직렬화하고, 워커가 도는 창(분 단위)은
//   무방비다. adopt(already_prepared) 분기는 사이클 락 이전에 return 하므로 락도 안 잡는다.
//   → 같은 레포의 두 세션(drive+인터랙티브 등)이 같은 worktree 에 워커를 이중 spawn 할 수 있다.
// 고침: 호출측이 장수 pid 를 주입(driver=process.pid, parallel.md=$PPID). prepare/admit 가
//   그 owner{pid,session,stamped_at} 를 current_batch.json 에 stamp 하고, adopt 시 살아있는
//   타 owner 면 spawn 전 거부한다. --owner-pid 미제공(구버전)이면 게이트 전체 skip(하위호환).

/** --owner-pid=<n> [--session=<label>] 파싱(= 형태만 — admit taskId 오탐 방지). 없으면 null. */
function parseOwner(args) {
  const pidFlag = (args || []).find((a) => a.startsWith('--owner-pid='));
  if (!pidFlag) return null;
  const pid = Number(pidFlag.slice('--owner-pid='.length));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const sessFlag = (args || []).find((a) => a.startsWith('--session='));
  return { pid, session: sessFlag ? sessFlag.slice('--session='.length) : null };
}

function readCurrentBatch(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, CURRENT_BATCH_FILE), 'utf8')); }
  catch { return null; }
}

/** owner stamp 객체(현재 시각). */
function ownerStamp(owner) {
  return { pid: owner.pid, session: owner.session, stamped_at: new Date().toISOString() };
}

/** current_batch.json 의 owner 만 호출자로 재스탬프(adopt 시 이후 프리페어가 라이브 소유로 인식). */
function restampOwner(cwd, owner) {
  const cb = readCurrentBatch(cwd);
  if (!cb) return;
  writeJsonAtomic(path.join(cwd, CURRENT_BATCH_FILE), { ...cb, owner: ownerStamp(owner) });
}

/**
 * adopt(already_prepared) 게이트. 호출자가 owner-pid 를 안 줬으면 skip(하위호환).
 * 기록된 owner 가 호출자와 다르고 살아있으면 거부. 같은 owner/죽은 owner/무-owner 면 adopt 재스탬프
 * (크래시 세션의 죽은 owner 를 산 호출자로 이전 → 이후 세션의 이중 채택 방지).
 * @returns {{ok:true} | {ok:false, holder:{pid:number, session?:string}}}
 */
function ownerAdoptGate(cwd, args) {
  const owner = parseOwner(args);
  if (!owner) return { ok: true };                     // 미제공 → 게이트 skip(하위호환)
  const cb = readCurrentBatch(cwd);
  const rec = cb && cb.owner;
  if (rec && typeof rec.pid === 'number' && rec.pid !== owner.pid && isAlive(rec.pid)) {
    return { ok: false, holder: rec };
  }
  restampOwner(cwd, owner);                             // adopt — 소유권을 호출자로 이전
  return { ok: true };
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

/**
 * 디스크의 기존 payload.json 하나로부터 task_prompt 원소를 재구성한다(per-task 판정).
 * fresh prepare 와 동일한 makeTaskPrompt 단일 소스를 써서 drift 를 원천 제거.
 * already_prepared(rebuildTaskPrompts) 와 admit 멱등 경로가 공유한다.
 */
function rebuildOneTaskPrompt(cwd, id) {
  const runs = path.join(cwd, '.pact/runs', id);
  const payload = JSON.parse(fs.readFileSync(path.join(runs, 'payload.json'), 'utf8'));
  const paths = {
    prompt_path: path.join(runs, 'prompt.md'),
    context_path: path.join(runs, 'context.md'),
    status_path: path.join(runs, 'status.json'),
    report_path: path.join(runs, 'report.md'),
  };
  return {
    task_id: id,
    title: payload.title || '',
    task_prompt: makeTaskPrompt(payload, paths),
    prompt_path: path.relative(cwd, paths.prompt_path),
    context_path: path.relative(cwd, paths.context_path),
    status_path: path.relative(cwd, paths.status_path),
    report_path: path.relative(cwd, paths.report_path),
    working_dir: payload.working_dir,
    allowed_paths: payload.allowed_paths || [], // P2-2: 슬롯 풀 pathsOverlap 게이팅용(추가 필드)
    loop_until: payload.loop_until || null,
  };
}

/**
 * already_prepared 시 디스크의 기존 batch 로부터 task_prompts 를 재구성한다.
 * 각 task status.json 으로 done 여부도 판정.
 */
function rebuildTaskPrompts(cwd) {
  const cb = JSON.parse(fs.readFileSync(path.join(cwd, CURRENT_BATCH_FILE), 'utf8'));
  const ids = cb.task_ids || [];
  const taskPrompts = [];
  let allDone = ids.length > 0;
  for (const id of ids) {
    taskPrompts.push(rebuildOneTaskPrompt(cwd, id));
    let done = false;
    try {
      done = JSON.parse(fs.readFileSync(path.join(cwd, '.pact/runs', id, 'status.json'), 'utf8')).status === 'done';
    } catch { /* 미완 */ }
    if (!done) allDone = false;
  }
  // coordinator_review_needed 는 pre-spawn 검토 제거(P1-3)로 deprecated — 항상 false.
  return { task_prompts: taskPrompts, ready_to_collect: allDone, coordinator_review_needed: false };
}

/** task 하나가 이미 준비됨(worktree + payload + prompt 존재)인지 per-task 판정. admit 멱등용. */
function isTaskPrepared(cwd, id) {
  return fs.existsSync(path.join(cwd, '.pact', 'worktrees', id))
    && fs.existsSync(path.join(cwd, '.pact', 'runs', id, 'prompt.md'))
    && fs.existsSync(path.join(cwd, '.pact', 'runs', id, 'payload.json'));
}

/** batch0 task 와 admit task 가 공유하는 worker payload 구성(중복 구현 방지). */
function buildTaskPayload(task, wt, baseBranch, parsed) {
  return {
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
    loop_until: task.loop_until || null,
  };
}

/** prepareWorkerSpawn 결과 → prepare 의 task_prompts 원소 shape. prepare/admit 공용. */
function buildTaskPromptEntry(r, wt, payload, cwd) {
  return {
    task_id: payload.task_id,
    title: payload.title || '',
    task_prompt: r.task_prompt,
    prompt_path: path.relative(cwd, r.prompt_path),
    context_path: path.relative(cwd, r.context_path),
    status_path: path.relative(cwd, r.status_path),
    report_path: path.relative(cwd, r.report_path),
    working_dir: wt.working_dir,
    allowed_paths: payload.allowed_paths || [], // P2-2: 슬롯 풀 pathsOverlap 게이팅용(추가 필드)
    loop_until: payload.loop_until || null,
  };
}

/**
 * task 1개의 worktree 생성 + payload/context 렌더 (doPrepare 루프 · admit 공통 per-task 로직).
 * reconcile(stale 자가치유) → createWorktree → payload → prepareWorkerSpawn → task_prompt 원소.
 * @returns {{ok:true, entry, bundle_warnings:Array}
 *   | {ok:false, stage:string, error:string, worktreeCreated:boolean}}
 */
function prepareOneTask(task, baseBranch, parsed, cwd) {
  const rec = reconcileWorktree(task.id, baseBranch, { cwd });
  if (!rec.ok) return { ok: false, stage: 'worktree', error: rec.error, worktreeCreated: false };

  const wt = createWorktree(task.id, baseBranch, { cwd });
  if (!wt.ok) return { ok: false, stage: 'worktree', error: wt.error, worktreeCreated: false };

  const payload = buildTaskPayload(task, wt, baseBranch, parsed);
  const r = prepareWorkerSpawn(payload, { cwd, runsRoot: path.join(cwd, '.pact/runs') });
  if (!r.ok) {
    return { ok: false, stage: 'spawn-prepare', error: (r.errors || []).join('; '), worktreeCreated: true };
  }
  return { ok: true, entry: buildTaskPromptEntry(r, wt, payload, cwd), bundle_warnings: r.bundle_warnings || [] };
}

/**
 * 전체 task DAG 를 드라이버가 소비할 그래프로 emit (P2-1 · SPD-2, --graph 뒤에서만).
 * batch0 밖 pending task 만 담아 슬롯 파이프라인이 pull 대상을 알게 한다.
 * ready = 그 중 완료 task 로 의존 충족된 것(overflow 이지만 즉시 admit 가능한 후보).
 * 실제 admit 은 pathsOverlap 재검사를 거치므로 ready 는 dependency-readiness 만 의미한다.
 */
function buildTaskGraph(tasks, batch0) {
  const batch0Ids = new Set(batch0.map(t => t.id));
  const completedIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  const graph = { ready: [], tasks: {} };
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'failed') continue; // pending 만
    if (batch0Ids.has(t.id)) continue;                          // batch0 밖
    graph.tasks[t.id] = {
      deps: (t.dependencies || []).map(depTaskId),
      allowed_paths: t.allowed_paths || [],
      status: t.status || 'todo',
      title: t.title || '',
    };
    if (allDependenciesMet(t, completedIds)) graph.ready.push(t.id);
  }
  return graph;
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
  // 단 task_prompts 는 항상 반환(makeTaskPrompt 단일 소스) → 드라이버 reconstruct 불필요·drift 제거.
  if (!force && isAlreadyPrepared(cwd)) {
    // P1-#2: adopt(already_prepared) 경로를 acquireCycleLock 배타 구간으로 감싼다. owner 검사·
    // restamp(ownerAdoptGate)·task_prompts 재구성이 락 밖이면 두 세션이 동시에 무-owner/죽은-owner
    // 를 읽고 둘 다 gate 통과 → 같은 task_prompts 반환 → 워커 이중 spawn. 락을 못 잡으면(다른 세션이
    // prepare/collect/admit 진행 중) cycle-busy 로 거부한다. adopt 는 early-return 이라 아래 fresh
    // prepare 경로의 락 획득과 겹치지 않는다(데드락/이중획득 없음).
    const lock = acquireCycleLock({ cwd, stage: 'adopt' });
    if (!lock.ok) {
      emit({ ok: false, stage: 'cycle-busy', errors: [{ message: lock.error, fix: '다른 세션 종료 대기 또는 pact status' }] });
      process.exit(1); // 락 미획득 → 누수 없음
    }
    try {
      // STAB-1: adopt 전 owner 게이트 — 살아있는 타 세션이 소유 중이면 spawn 전 거부(이중 spawn 차단).
      const gate = ownerAdoptGate(cwd, args);
      if (!gate.ok) {
        const h = gate.holder;
        const who = `pid=${h.pid}${h.session ? `, session=${h.session}` : ''}`;
        const msg = `cycle-busy: 다른 세션(${who})이 이 사이클을 소유 중`;
        emit({
          ok: false,
          stage: 'cycle-busy',
          error: msg,
          errors: [{ message: msg, fix: '다른 세션 종료 대기 또는 pact status' }],
        });
        // process.exit 는 finally(releaseCycleLock)를 건너뛴다 → exitCode 만 세팅하고 return.
        process.exitCode = 1;
        return;
      }
      const rebuilt = rebuildTaskPrompts(cwd);
      const out = {
        ok: true,
        already_prepared: true,
        task_prompts: rebuilt.task_prompts,
        ready_to_collect: rebuilt.ready_to_collect, // 모든 워커 done이면 spawn 스킵 → collect 로
        coordinator_review_needed: rebuilt.coordinator_review_needed,
        message: rebuilt.ready_to_collect
          ? '이미 prepare 완료 + 모든 워커 done — collect 로 진행 권장.'
          : '이미 prepare 완료 — 미완료 task 재개 가능 (--force 로 재생성).',
      };
      // DRV-1: 재개(already_prepared)에서도 --graph 면 전체 DAG 를 다시 emit 해야 한다. 안 그러면
      // 크래시-재개/부분 사이클에서 파이프라인이 current_batch 에 남은 task 만 drain 하고, 아직
      // admit 안 된 하위 DAG(예: dep 완료 후 투입될 task)를 pull 대상으로 못 봐 조용히 누락된다
      // (→ 기본 --cycles=1 이면 잔여 task 가 있어도 exit 0 성공 오보). fresh prepare(doPrepare)와
      // 동일 소스: task source 를 재파싱해 buildTaskGraph. 파싱 실패해도 재개 자체는 진행(방어).
      if (args.includes('--graph')) {
        try {
          const cb = readCurrentBatch(cwd) || {};
          const batch0 = (cb.task_ids || []).map((id) => ({ id }));
          const parsed = parseTaskFiles(discoverTaskFiles({ cwd }), { cwd });
          out.task_graph = buildTaskGraph(parsed.tasks, batch0);
        } catch { /* task source 재파싱 실패 시 graph 생략 — 재개는 계속 진행 */ }
      }
      emit(out);
      return;
    } finally {
      releaseCycleLock({ cwd });
    }
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

  // 슬로우니스 레버 (P1-1 · SPD-4): fan-out 직전 batch0 에 정적 검사를 결정적으로 적용해
  // non-blocking 경고로 emit (propose-only, 철학5). batch0 은 미완(non-done/failed) task 만
  // 담으므로 이미 merged/done task 는 자동 제외(노이즈 방어). 검사가 던져도 prepare 는 진행.
  let sizeWarnings = [];
  let scopeWarnings = [];
  let ownershipWarnings = [];
  try { sizeWarnings = assessSizes(batch0); } catch { /* non-blocking */ }
  try { scopeWarnings = assessScopes(batch0); } catch { /* non-blocking */ }
  // P1-3 · SPD-6: pre-spawn coordinator 검토를 제거하며, 그 유일한 비중복 체크
  // (allowed_paths ⊆ MODULE_OWNERSHIP)를 결정적으로 승계 — non-blocking, propose-only.
  try { ownershipWarnings = assessOwnership(batch0, cwd); } catch { /* non-blocking */ }

  // worktree 생성 + payload·prompt 렌더 — atomic, 실패 시 모두 롤백
  const created = [];
  const taskPrompts = [];
  // TOK-3(2부): prepareWorkerSpawn 이 반환하는 anchor-없는 대형 shard 경고를 task_id 부착해 수집.
  const bundleWarnings = [];

  // base branch 자동 감지 (master 기반 repo 지원, 'main' 하드코딩 제거)
  const baseBranch = detectBaseBranch({ cwd });

  // P2-1 · SPD-2: prepare 는 batch0 만 upfront 생성(인터랙티브 Task-tool 배리어 호환). 나머지
  // DAG 는 --graph 뒤로만 emit 하고, 드라이버가 슬롯이 빌 때 admit 으로 per-task on-demand 생성.
  for (const task of batch0) {
    const res = prepareOneTask(task, baseBranch, parsed, cwd);
    if (!res.ok) {
      // 현재 task 의 worktree 가 이미 만들어졌으면(spawn-prepare 실패) 그것부터 롤백.
      if (res.worktreeCreated) removeWorktree(task.id, { cwd });
      for (const c of created) removeWorktree(c.task_id, { cwd });
      return fail(res.stage, [{ task_id: task.id, message: res.error }]);
    }
    created.push({ task_id: task.id });
    for (const w of res.bundle_warnings) bundleWarnings.push({ task_id: task.id, ...w });
    taskPrompts.push(res.entry);
  }

  fs.mkdirSync(path.join(cwd, '.pact'), { recursive: true });
  // STAB-1: --owner-pid 주입 시 owner stamp(멀티세션 adopt 게이트용). 미제공이면 필드 생략(하위호환).
  const owner = parseOwner(args);
  writeJsonAtomic(path.join(cwd, CURRENT_BATCH_FILE), {
    task_ids: batch0.map(t => t.id),
    prepared_at: new Date().toISOString(),
    ...(owner ? { owner: ownerStamp(owner) } : {}),
  });

  const out = {
    ok: true,
    task_prompts: taskPrompts,
    // deprecated (P1-3): pre-spawn coordinator 검토 삭제 — 검토 4항목은 결정적 게이트가 커버
    // (경로충돌=buildBatches/pathsOverlap, 의존=allDependenciesMet, TBD=parse, 스코프=merge 게이트,
    //  ownership=아래 ownership_warnings). 하위호환 위해 필드는 유지하되 항상 false.
    coordinator_review_needed: false,
    context_warnings: contextWarnings,
    // P1-1 · SPD-4 + P1-3 · SPD-6 슬로우니스/계약 레버 (전부 non-blocking, propose-only):
    size_warnings: sizeWarnings,          // 턴소진 위험(oversized/unbounded) — 분해 제안
    scope_warnings: scopeWarnings,        // done_criteria ⊄ allowed_paths 계약모순 — 수정 제안
    bundle_warnings: bundleWarnings,      // anchor 없는 대형 shard 통째 번들 — freeze/anchor 제안
    ownership_warnings: ownershipWarnings, // allowed_paths ⊄ MODULE_OWNERSHIP 오너 영역 침범 — 경계 수정 제안
    next_action: '메인이 Task tool로 위 task_prompts들을 한 메시지에서 동시 spawn (subagent_type: worker)',
  };

  // P2-1 · SPD-2: --graph 옵트인일 때만 전체 DAG 를 추가. 인터랙티브 메인 컨텍스트 오염 방지를
  // 위해 기본 emit 은 100% 불변으로 두고, 드라이버(슬롯 파이프라인)만 이 필드를 소비한다.
  if (args.includes('--graph')) {
    out.task_graph = buildTaskGraph(parsed.tasks, batch0);
  }

  emit(out);
}

/**
 * P2-1 · SPD-2 — admit: 슬롯이 빌 때 드라이버가 다음 task 1개를 온디맨드 투입.
 * 그 순간의 CURRENT base(직전 머지 반영)에서 worktree 생성 + payload/context 렌더.
 * in-flight 워커들의 allowed_paths 와 pathsOverlap 재검사(겹치면 거부, 자동해결 X).
 * 멱등: 이미 준비된 task 는 재생성 없이 기존 payload 반환.
 */
function admit(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  cleanStaleLocks({ cwd });

  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    emit({ ok: false, stage: 'admit', errors: [{ message: 'admit <task_id> 필요 (예: admit PROJ-002 --in-flight=PROJ-001)' }] });
    process.exit(1);
  }

  // 사이클 lock — 다른 세션의 prepare/collect/admit 과 current_batch.json 경쟁 차단.
  const lock = acquireCycleLock({ cwd, stage: 'admit' });
  if (!lock.ok) {
    emit({ ok: false, stage: 'cycle-busy', errors: [{ message: lock.error, fix: '다른 세션 종료 대기 또는 pact status' }] });
    process.exit(1);
  }

  try {
    doAdmit(args, taskId, cwd);
  } catch (e) {
    if (e.pactStage) emitFail(e);
    else throw e;
  } finally {
    releaseCycleLock({ cwd });
  }
}

/** 진행 중 사이클의 cycle_id(= merge-result.json 의 cycle_id). current_batch 가 비어 삭제된
 *  사이클 중간에 admit 이 cycle 경계를 되살릴 fallback. 없으면 null. */
function readMergeCycleId(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.pact/merge-result.json'), 'utf8'));
    return typeof j.cycle_id === 'string' ? j.cycle_id : null;
  } catch { return null; }
}

/** admit 된 task 를 current_batch.json 에 추가 기록(멱등 append). collect 가 함께 처리하게. */
function recordAdmitted(cwd, taskId, owner) {
  const cbPath = path.join(cwd, CURRENT_BATCH_FILE);
  let cb = {};
  try { cb = JSON.parse(fs.readFileSync(cbPath, 'utf8')); } catch { cb = {}; }
  const ids = Array.isArray(cb.task_ids) ? cb.task_ids.slice() : [];
  if (!ids.includes(taskId)) ids.push(taskId);
  fs.mkdirSync(path.join(cwd, '.pact'), { recursive: true });
  // STAB-1: owner 주입 시 재스탬프, 미제공이면 기존 owner 를 ...cb 로 보존(clobber 방지).
  // ORCH-1 admit 상호작용: collect-one 이 current_batch 를 비워 삭제한 뒤 슬롯이 다시 차서
  // admit 이 파일을 재생성할 때, prepared_at 을 새로 찍으면 cycle_id 가 갈려 merge-result 가
  // 사이클 중간에 리셋된다(--max=1 파이프라인은 매 task 가 제 사이클이 됨). 진행 중 사이클의
  // cycle_id(merge-result.json)를 재사용해 같은 사이클로 유지한다. 교차-run 은 prepare 가 새
  // prepared_at 을 찍으므로(항상 current_batch 존재) 이 fallback 을 타지 않아 안전하다.
  const next = {
    ...cb,
    task_ids: ids,
    prepared_at: cb.prepared_at || readMergeCycleId(cwd) || new Date().toISOString(),
    last_admitted_at: new Date().toISOString(),
  };
  if (owner) next.owner = ownerStamp(owner);
  writeJsonAtomic(cbPath, next);
}

function parseInFlight(args) {
  const i = args.findIndex(a => a === '--in-flight' || a.startsWith('--in-flight='));
  if (i < 0) return [];
  const raw = args[i].startsWith('--in-flight=') ? args[i].slice('--in-flight='.length) : args[i + 1];
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function doAdmit(args, taskId, cwd) {
  const taskFiles = discoverTaskFiles({ cwd });
  if (taskFiles.length === 0) {
    return fail('admit', [{ message: 'task source(TASKS.md 또는 tasks/*.md) 없음', fix: '/pact:plan 먼저' }]);
  }
  const parsed = parseTaskFiles(taskFiles, { cwd });
  if (parsed.errors.length > 0) {
    return fail('task-parse', parsed.errors.map(e => ({ message: `${e.file || '?'} ${e.taskId || ''}: ${e.error}` })));
  }
  const task = parsed.tasks.find(t => t.id === taskId);
  if (!task) {
    return fail('admit', [{ message: `task ${taskId} 를 task source 에서 찾을 수 없음` }]);
  }

  // STAB-1: admit 도 owner 를 stamp/보존(드라이버가 --owner-pid 로 자기 소유권 유지).
  const owner = parseOwner(args);

  // 멱등/재개: 이미 worktree+payload 가 있으면 재생성하지 않고 기존 payload 반환(per-task 판정).
  // 진행 중 워커 작업물을 재베이스로 날리지 않기 위해 idempotency 가 overlap 재검사보다 우선.
  if (isTaskPrepared(cwd, taskId)) {
    recordAdmitted(cwd, taskId, owner);
    emit({ ok: true, admitted: true, already_prepared: true, task_prompt: rebuildOneTaskPrompt(cwd, taskId) });
    return;
  }

  // in-flight 워커들의 allowed_paths 와 pathsOverlap 재검사 — 겹치면 admit 거부(정지, 자동해결 X).
  const inFlight = parseInFlight(args);
  const admitPaths = task.allowed_paths || [];
  const conflicts = [];
  for (const id of inFlight) {
    if (id === taskId) continue;
    const other = parsed.tasks.find(t => t.id === id);
    const otherPaths = other ? (other.allowed_paths || []) : [];
    if (otherPaths.length && pathsOverlap(admitPaths, otherPaths)) conflicts.push(id);
  }
  if (conflicts.length > 0) {
    // 정상적 admission 거절(에러 아님, exit 0) — 드라이버는 다른 ready task 를 시도한다.
    emit({
      ok: false,
      reason: 'path_overlap',
      task_id: taskId,
      conflicts,
      message: `admit 거부 — in-flight task 와 allowed_paths 겹침: ${conflicts.join(', ')}`,
    });
    return;
  }

  // CURRENT base(직전 머지 반영)에서 worktree 생성 + payload/context 렌더(공통 per-task 로직).
  const baseBranch = detectBaseBranch({ cwd });
  const res = prepareOneTask(task, baseBranch, parsed, cwd);
  if (!res.ok) {
    if (res.worktreeCreated) removeWorktree(taskId, { cwd });
    return fail(res.stage, [{ task_id: taskId, message: res.error }]);
  }

  recordAdmitted(cwd, taskId, owner);
  emit({
    ok: true,
    admitted: true,
    base_branch: baseBranch,
    task_prompt: res.entry,
    bundle_warnings: res.bundle_warnings.map(w => ({ task_id: taskId, ...w })),
  });
}

// ─── P2-2 · SPD-1: collect-one — 워커 완료 즉시 단건 머지(반드시 게이트 경유) ───
// 슬롯 풀 드라이버가 task 1개 완료마다 호출. 기존 batch collect 는 100% 불변으로 두고
// 이 서브커맨드만 추가(옵트인). merge-result.json 은 단건 append 로 누적 → /pact:wrap·status
// 소비 포맷 유지. 충돌이면 자동해결 절대 X — conflicted 필드로 알리고 드라이버가 정지.

/** verify 결과 fold(fail 우선, skip 은 뒤 값으로 대체) — 단건 append 간 누적용. */
function foldVerification(base, patch) {
  const out = { lint: 'skip', typecheck: 'skip', test: 'skip', build: 'skip', ...(base || {}) };
  for (const k of ['lint', 'typecheck', 'test', 'build']) {
    const v = patch && patch[k];
    if (!v || v === 'skip') continue;
    if (v === 'fail') out[k] = 'fail';
    else if (out[k] === 'skip') out[k] = v;
  }
  return out;
}

/** current_batch.json 의 사이클 식별자(prepared_at). merge-result 사이클 경계 판정용. 없으면 null. */
function readCycleMarker(cwd) {
  const cb = readCurrentBatch(cwd);
  return cb && typeof cb.prepared_at === 'string' ? cb.prepared_at : null;
}

/** task_id 별로 최신 1건만 남긴다(뒤에 온 항목이 이김 — 사유 최신화). task_id 없는 항목은 보존. */
function dedupeByTaskIdKeepLast(arr) {
  const idx = new Map();
  const out = [];
  for (const item of (arr || [])) {
    const id = item && item.task_id;
    if (id == null) { out.push(item); continue; }
    if (idx.has(id)) out[idx.get(id)] = item; // 최신으로 갱신
    else { idx.set(id, out.length); out.push(item); }
  }
  return out;
}

/**
 * DOG-1: 사이클 내 누적 화해(reconcile). collect-one 은 사이클 내 여러 patch 를 rejected/failures
 * 배열에 append 만 하므로, 앞선 patch 에서 rejected 됐다가 뒤에 resume 되어 머지된 task 가 rejected
 * 에 stale 하게 잔존한다 → 축소 coordinator 가 SOT 만 읽고 머지 성공 task 를 Blocked 로 오기록.
 * (a) 이번 결과에서 merged/already_merged 된 task_id 는 누적 rejected/failures 에서 제거하고,
 * (b) 같은 task 의 반복 rejected/failures 는 최신 1건만 남긴다(중복 제거·사유 갱신).
 */
function reconcileCycleResult(out) {
  const settled = new Set([...(out.merged || []), ...(out.already_merged || [])]);
  const clean = (arr) =>
    dedupeByTaskIdKeepLast((arr || []).filter((r) => !(r && settled.has(r.task_id))));
  out.rejected = clean(out.rejected);
  out.failures = clean(out.failures);
  return out;
}

/**
 * merge-result.json 을 단건 append 로 갱신(배열 누적 + verification fold). 기존 소비 포맷 유지.
 *
 * ORCH-1/CI-1: merge-result.json 은 '현재 사이클만' 담는 deterministic SOT 다(wrap/metrics 계약).
 * 디스크의 파일이 **다른 사이클**(cycle_id 불일치)이면 이전 drive/사이클 산출물이므로 이월하지 않고
 * 이번 사이클로 fresh 시작한다 — 그래야 `pact drive` 를 여러 번(또는 --cycles>1) 돌려도 두 번째
 * 런의 collect-one 이 이전 런 위에 무한 누적하지 않는다(batch collect(doCollect)의 overwrite=
 * 'fresh-per-cycle' 계약과 대칭). **같은 사이클**(cycle_id 일치)이면 기존대로 누적한다 —
 * 한 사이클 내 task N개가 완료마다 collect-one 을 호출해 사이클 SOT 를 조립하는 정상 경로.
 * cycleId 부재(current_batch 없음: 재진입·수동 호출)면 판정 불가 → 안전하게 fresh 로 취급.
 * @param {string|null} cycleId — 이번 사이클 식별자(readCycleMarker). null 이면 fresh.
 */
function appendMergeResult(cwd, patch, cycleId = null) {
  const p = path.join(cwd, '.pact/merge-result.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { cur = {}; }
  const sameCycle = cycleId != null && cur.cycle_id === cycleId;
  const base = sameCycle ? cur : {}; // 다른 사이클/판정불가 → 이월 없이 fresh
  const arr = (k) => (Array.isArray(base[k]) ? base[k] : []);
  const out = {
    timestamp: new Date().toISOString(),
    ...(cycleId != null ? { cycle_id: cycleId } : {}),
    single_merge: true, // 마커: collect-one append 로 조립된 사이클 결과(batch collect 와 구분).
    eligible: (base.eligible || 0) + (patch.eligible || 0),
    merged: [...arr('merged'), ...(patch.merged || [])],
    already_merged: [...arr('already_merged'), ...(patch.already_merged || [])],
    conflicted: patch.conflicted || base.conflicted || null,
    skipped: [...arr('skipped'), ...(patch.skipped || [])],
    rejected: [...arr('rejected'), ...(patch.rejected || [])],
    status_updates: [...arr('status_updates'), ...(patch.status_updates || [])],
    cleanup: [...arr('cleanup'), ...(patch.cleanup || [])],
    failures: [...arr('failures'), ...(patch.failures || [])],
    verification_summary: foldVerification(base.verification_summary, patch.verification_summary),
    decisions_to_record: [...arr('decisions_to_record'), ...(patch.decisions_to_record || [])],
  };
  reconcileCycleResult(out); // DOG-1: 머지된 task 는 rejected/failures 에서 제거 + 중복 정리
  fs.mkdirSync(path.join(cwd, '.pact'), { recursive: true });
  writeJsonAtomic(p, out);
  return out;
}

/** merged/already_merged task 를 current_batch.json 에서 제거(정리). 비면 파일 삭제. */
function removeFromCurrentBatch(cwd, taskId) {
  const cbPath = path.join(cwd, CURRENT_BATCH_FILE);
  let cb;
  try { cb = JSON.parse(fs.readFileSync(cbPath, 'utf8')); } catch { return; }
  const ids = (cb.task_ids || []).filter((id) => id !== taskId);
  if (ids.length === 0) { try { fs.unlinkSync(cbPath); } catch { /* noop */ } return; }
  writeJsonAtomic(cbPath, { ...cb, task_ids: ids });
}

/** 단일 task status.json 요약(verification patch + decisions + failure). */
function summarizeOne(cwd, taskId) {
  const sp = path.join(cwd, '.pact/runs', taskId, 'status.json');
  const verification = {};
  const decisions = [];
  let failure = null;
  if (fs.existsSync(sp)) {
    try {
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      for (const k of ['lint', 'typecheck', 'test', 'build']) {
        const v = s.verify_results && s.verify_results[k];
        if (v) verification[k] = v;
      }
      if (Array.isArray(s.decisions)) for (const d of s.decisions) decisions.push({ task_id: taskId, ...d });
      if (s.status !== 'done') failure = { task_id: taskId, status: s.status, blockers: s.blockers || [] };
    } catch { /* skip malformed */ }
  }
  return { verification, decisions, failure };
}

function collectOne(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  cleanStaleLocks({ cwd });
  const taskId = args.find((a) => !a.startsWith('--'));
  if (!taskId) {
    emit({ ok: false, stage: 'collect-one', errors: [{ message: 'collect-one <task_id> 필요' }] });
    process.exit(1);
  }

  // 사이클 lock — admit/collect/prepare 와 current_batch.json·머지 경쟁 차단.
  const lock = acquireCycleLock({ cwd, stage: 'collect-one' });
  if (!lock.ok) {
    emit({ ok: false, stage: 'cycle-busy', errors: [{ message: lock.error, fix: '다른 세션 종료 대기 또는 pact status' }] });
    process.exit(1);
  }

  try {
    doCollectOne(args, opts, cwd, taskId);
  } catch (e) {
    if (e.pactStage) emitFail(e);
    else throw e;
  } finally {
    releaseCycleLock({ cwd });
  }
}

function doCollectOne(args, opts, cwd, taskId) {
  const journalPath = path.join(cwd, '.pact/collect-journal.json');
  // 사이클 식별자를 mutation(removeFromCurrentBatch 가 파일 삭제 가능) 이전에 캡처 —
  // 마지막 task 여도 이번 사이클 prepared_at 을 확보해 merge-result 사이클 경계를 판정한다.
  const cycleId = readCycleMarker(cwd);

  // 재진입 복구(doCollect 와 동일 규약): dangling 머지 + journal 있으면 abort 후 재개,
  // journal 없으면 외부 머지 → 건드리지 않고 정지(자동해결 X).
  if (isMergeInProgress({ cwd })) {
    if (fs.existsSync(journalPath)) {
      abortMerge({ cwd });
    } else {
      return fail('merge-in-progress', [{
        message: '외부 머지 진행 중(MERGE_HEAD) — pact 가 시작한 머지가 아님',
        fix: '/pact:resolve-conflict 또는 git merge --abort 후 재시도',
      }]);
    }
  }

  // report-gen 을 planMerge 이전에(doCollect 와 동일 순서) — report.md 존재 게이트 tautology 화.
  const reportGen = generateReports({ cwd, taskIds: [taskId] });

  const plan = planMerge({ cwd, taskIds: [taskId] });
  const rejected = plan.rejected || [];
  const eligible = plan.eligible || [];

  const merged = [];
  const alreadyMerged = [];
  const cleanup = [];
  const statusUpdates = [];
  let conflicted = null;

  if (eligible.includes(taskId)) {
    writeJsonAtomic(journalPath, { phase: 'merging', task_ids: [taskId], started_at: new Date().toISOString() });
    const r = mergeWorktree(taskId, { cwd });
    if (r.ok) {
      merged.push(taskId);
      const su = setTaskStatus(taskId, 'done', { cwd });
      statusUpdates.push({ task_id: taskId, ok: su.ok, action: su.action, file: su.file, error: su.error });
      const rm = removeWorktree(taskId, { cwd });
      cleanup.push({ task_id: taskId, ok: rm.ok, error: rm.error });
    } else if (r.branch_missing) {
      // 이미 머지+정리됨(재진입) — 충돌 아님. status done 멱등 보장.
      alreadyMerged.push(taskId);
      const su = setTaskStatus(taskId, 'done', { cwd });
      statusUpdates.push({ task_id: taskId, ok: su.ok, action: su.action, file: su.file, error: su.error });
    } else {
      // 실제 충돌 — abort 안 함(merge-coordinator 규약). 드라이버가 conflicted 로 정지·escalate.
      conflicted = { task_id: taskId, branch_name: r.branch_name, files: r.conflicted_files || [], error: r.error };
    }
    try { fs.unlinkSync(journalPath); } catch { /* noop */ }
  }

  const { verification, decisions, failure } = summarizeOne(cwd, taskId);
  const failures = failure ? [failure] : [];

  // merged/already 는 current_batch 에서 제거(정리). conflicted/rejected 는 보존(재시도 대상).
  if (merged.length || alreadyMerged.length) removeFromCurrentBatch(cwd, taskId);

  appendMergeResult(cwd, {
    eligible: eligible.length,
    merged,
    already_merged: alreadyMerged,
    conflicted,
    rejected,
    tdd_warnings: plan.tdd_warnings || [], // ADR-058 soft 경고 — 머지 진행, 가시화만
    status_updates: statusUpdates,
    cleanup,
    failures,
    verification_summary: verification,
    decisions_to_record: decisions,
  }, cycleId);

  const statusCommit = args.includes('--commit-status')
    ? commitStatusChanges(cwd, statusUpdates)
    : undefined;

  emit({
    ok: true,
    task_id: taskId,
    merged,
    already_merged: alreadyMerged,
    rejected,
    tdd_warnings: plan.tdd_warnings || [],
    conflicted,
    skipped: [],
    failures,
    cleanup,
    status_updates: statusUpdates,
    status_commit: statusCommit,
    verification_summary: verification,
    decisions_to_record: decisions,
    report_gen: reportGen,
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

  // SPD-5 (P1-4): status.json → report.md 결정적 렌더를 머지 게이트 이전에. 없는 report.md 만
  // 생성(워커 수기본 존중). report.md 존재가 보장되므로 merge 게이트의 report 검사가 tautology 화 —
  // 과소작성 reject/rewrite 사이클 소거. 워커는 status.json.summary(자유 서술)만 채우면 된다.
  const reportGen = generateReports({ cwd, taskIds: currentBatch.task_ids });

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

  // merge-result.json = 사이클 deterministic SOT. decisions/verification/failures 가 다 계산된 이 시점에
  // 한 번에 기록 → drive 후 /pact:wrap 가 LLM 없이 이 파일만 읽어 PROGRESS/DECISIONS 서사 갱신 가능.
  writeJsonAtomic(path.join(cwd, '.pact/merge-result.json'), {
    timestamp: new Date().toISOString(),
    // ORCH-1/CI-1: collect-one 과 동일 사이클 마커. batch collect 는 통째 overwrite 라 이미
    // fresh-per-cycle 이지만, 마커를 남겨 두 writer 의 SOT 사이클 규약을 일치시킨다.
    ...(currentBatch.prepared_at ? { cycle_id: currentBatch.prepared_at } : {}),
    eligible: plan.eligible.length,
    merged: result.merged,
    already_merged: alreadyMerged,
    conflicted: result.conflicted,
    skipped: result.skipped,
    rejected: plan.rejected,
    tdd_warnings: plan.tdd_warnings || [], // ADR-058 soft 경고
    status_updates: statusUpdates,
    cleanup,
    failures,
    verification_summary: verification,
    decisions_to_record: decisions,
  });

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
    tdd_warnings: plan.tdd_warnings || [],
    conflicted: result.conflicted,
    skipped: result.skipped,
    failures,
    cleanup,
    status_updates: statusUpdates,
    status_commit: statusCommit,
    verification_summary: verification,
    decisions_to_record: decisions,
    report_gen: reportGen, // SPD-5: report.md 결정적 렌더 결과(rendered/skipped/실패) — 관찰용.
  });
}

module.exports = function runCycle(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'prepare') return prepare(rest);
  if (sub === 'collect') return collect(rest);
  if (sub === 'collect-one') return collectOne(rest);
  if (sub === 'admit') return admit(rest);
  console.error('Usage: pact run-cycle <prepare|collect|collect-one|admit> [--max=N] [--graph]');
  console.error('  admit <task_id> --in-flight=id1,id2   슬롯이 빌 때 다음 task 온디맨드 투입 (P2-1)');
  console.error('  collect-one <task_id> [--commit-status]  워커 완료 즉시 단건 머지(게이트 경유) (P2-2)');
  process.exit(1);
};

module.exports.prepare = prepare;
module.exports.collect = collect;
module.exports.collectOne = collectOne;
module.exports.admit = admit;
