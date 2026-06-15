#!/usr/bin/env node
'use strict';

// ============================================================================
// pact 헤드리스 드라이버 — PoC v2 (하드닝판). experiments, v1.0 코어 아님.
// ----------------------------------------------------------------------------
// v1 증명: 오케스트레이터 = 스크립트 → 코디네이션 토큰 0, 워커만 지불.
// v2 추가: "아무도 안 보는데 에러나면?" 에 대한 답 — 6가지 안전장치.
//   1) Promise.allSettled  — 워커 1개 실패가 배치 전체를 죽이지 않음 (격리)
//   2) canUseTool 가드      — allowed_paths 밖 쓰기 deny (pre-tool-guard 이식). bypass 안 씀
//   3) abortController      — 워커별 wall-clock 타임아웃 (무한/행 방지)
//   4) maxBudgetUsd + 누적  — 비용 폭주 차단 (사람이 안 보니 필수)
//   5) 재시도→회로차단기     — 1회 재시도 후 실패 시 사람 위임 (pact "2회 실패 시 위임")
//   6) 에러 subtype 분기     — throw가 아니라 result 메시지로 오는 에러 처리
//
// 기계적 에러(타임아웃/네트워크/scope위반/비용초과) → 드라이버가 자동 처리.
// 판단 에러(2회 실패/머지충돌/모호)               → 멈추고 사람한테 위임(escalate).
//
// 모드/플래그:
//   --real            실제 Agent SDK spawn (없으면 MOCK)
//   --pact            태스크를 pact CLI에서 + collect (없으면 DEMO)
//   --max=N           사이클당 워커 수 (기본 3)
//   --cycles=N        사이클 반복 (기본 1)
//   --model=NAME      실제 워커 모델 (기본 sonnet)
//   --timeout=SEC     워커별 타임아웃 (기본 120)
//   --budget=USD      누적 비용 상한 — 넘으면 정지 (기본 10)
//   --retries=N       태스크당 재시도 (기본 1 → 최대 2회 시도)
//   [MOCK 시연용]
//   --fail=ID,ID      이 태스크를 매번 실패 → 재시도 후 escalate 시연
//   --flaky=ID,ID     attempt1만 실패, 재시도서 성공 → 회복 시연
//   --deny=ID,ID      scope 밖 쓰기 시도 → 가드 deny 시연
//   --cost=USD        mock 워커 1개당 비용 (기본 0.9) — budget 차단 시연용
//
// 예) node driver.mjs --fail=DEMO-002             # 1개 죽어도 나머지 생존
//     node driver.mjs --flaky=DEMO-001            # 재시도로 회복
//     node driver.mjs --cycles=3 --budget=2 --cost=1.2   # 예산 차단
// ============================================================================

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const PACT_BIN = join(PLUGIN_ROOT, 'bin', 'pact');

// ---- 인자 파싱 (결정적, 토큰 0) -------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getNum = (n, d) => { const a = args.find((x) => x.startsWith(n + '=')); if (!a) return d; const v = Number(a.split('=')[1]); return Number.isFinite(v) && v > 0 ? v : d; };
const getStr = (n, d) => { const a = args.find((x) => x.startsWith(n + '=')); return a ? a.split('=')[1] : d; };
const getSet = (n) => new Set((getStr(n, '') || '').split(',').filter(Boolean));

const REAL = has('--real');
const USE_PACT = has('--pact');
const MAX = Math.floor(getNum('--max', 3));
const CYCLES = Math.floor(getNum('--cycles', 1));
const MODEL = getStr('--model', 'sonnet');
const TIMEOUT_MS = getNum('--timeout', 120) * 1000;
const BUDGET = getNum('--budget', 10);
const RETRIES = Math.floor(getNum('--retries', 1));
const FAIL = getSet('--fail');
const FLAKY = getSet('--flaky');
const DENY = getSet('--deny');
const MOCK_COST = getNum('--cost', 0.9);

// ---- 토큰 원장 (orchestratorTokens 는 절대 안 늘어남 = 불변식) -------------
const ledger = { orchestratorTokens: 0, spentUsd: 0, attempts: [], escalations: [], stoppedReason: null };
const tokOf = (u) => u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;

// ---- (2) 안전 가드: worker-guard 단일 소스 (pre-tool-guard 로직 재사용) -------
// 헤드리스 워커가 인터랙티브 워커(서브에이전트)와 "같은 안전 규칙"을 받게 한다.
const nodeRequire = createRequire(import.meta.url);
const { guardToolUse } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lib', 'worker-guard.js'));
const { writeJsonAtomic } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lib', 'atomic-write.js'));

// ---- (P5) 관측성: driver-state.json 단일 writer (atomic) -------------------
// 드라이버가 죽어도 디스크에 마지막 상태가 남아 사람이 pact status / 파일로 진행 파악.
function writeDriverState(patch) {
  if (!USE_PACT) return; // demo 모드는 .pact 없음
  try {
    const dir = join(process.cwd(), '.pact');
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, 'driver-state.json'), {
      pid: process.pid,
      updated_at: new Date().toISOString(),
      spent_usd: Number(ledger.spentUsd.toFixed(2)),
      escalations: ledger.escalations.length,
      ...patch,
    });
  } catch { /* 관측은 best-effort — 실패해도 작업엔 영향 없음 */ }
}

// canUseTool 콜백 팩토리 — worker-guard 로 worktree 경계 + allowed_paths(glob) + SOT/Bash 검사
function makeCanUseTool(task) {
  return async (toolName, input) => {
    const r = guardToolUse(toolName, input || {}, { workingDir: task.working_dir, allowedPaths: task.allowed_paths });
    return r.allow ? { behavior: 'allow' } : { behavior: 'deny', message: r.reason, interrupt: true };
  };
}

// ---- 태스크 소스 (반환: {tasks, readyToCollect}) ---------------------------
function getTasksDemo() {
  const tasks = Array.from({ length: MAX }, (_, i) => {
    const wd = mkdtempSync(join(tmpdir(), 'pact-poc-'));
    return {
      task_id: `DEMO-${String(i + 1).padStart(3, '0')}`,
      title: `데모 task ${i + 1}`,
      task_prompt: `Create a file named poc-${i + 1}.txt in your cwd with one line: "worker ${i + 1} ran". Then stop.`,
      working_dir: wd,
      allowed_paths: ['**'], // 데모: worktree 안 전체 허용 (worker-guard glob 기준)
    };
  });
  return { tasks, readyToCollect: false };
}
function getTasksPact() {
  // 코어 수정으로 prepare 는 already_prepared 에도 task_prompts 를 항상 반환한다
  // (makeTaskPrompt 단일 소스) → 드라이버 자체 reconstruct 불필요 = drift 근원 제거.
  const out = execSync(`node ${PACT_BIN} run-cycle prepare --max=${MAX}`, { encoding: 'utf8' });
  const j = JSON.parse(out);
  if (j.ok === false) throw new Error('prepare 실패: ' + JSON.stringify(j.stage || j.errors));
  if (j.empty) return { tasks: [], readyToCollect: false };
  if (j.ready_to_collect) {
    console.log('  (already_prepared + 모든 워커 done — spawn 스킵, collect 로)');
    return { tasks: [], readyToCollect: true };
  }
  if (j.already_prepared) console.log('  (already_prepared — 미완료 task 재개)');
  return { tasks: j.task_prompts || [], readyToCollect: false };
}

// ---- 워커 러너 (mock) — fault 주입 -----------------------------------------
async function runWorkerMock(task, attempt) {
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 500));
  // (5) 매번 실패 → escalate 시연
  if (FAIL.has(task.task_id)) throw new Error('의도된 실패(--fail)');
  // (5) attempt1만 실패 → 재시도 회복 시연
  if (FLAKY.has(task.task_id) && attempt === 1) throw new Error('일시 실패(--flaky), 재시도 요망');
  // (2) scope 밖 쓰기 시도 → 가드 deny 시연
  if (DENY.has(task.task_id)) {
    const g = guardToolUse('Write', { file_path: '/etc/poc-escape.txt' }, { workingDir: task.working_dir, allowedPaths: task.allowed_paths });
    if (!g.allow) return { ok: false, denied: true, reason: g.reason, usage: null, cost: MOCK_COST * 0.2, turns: 3, via: 'mock' };
  }
  const usage = { input_tokens: 1200, output_tokens: 3000, cache_read_input_tokens: 800000 + Math.floor(Math.random() * 900000), cache_creation_input_tokens: 40000 };
  return { ok: true, usage, cost: MOCK_COST, turns: 8 + Math.floor(Math.random() * 25), via: 'mock' };
}

// ---- 워커 러너 (real) — SDK + 타임아웃 + 가드 + 예산 ------------------------
function stripFrontmatter(s) { const m = /^---\n[\s\S]*?\n---\n/.exec(s); return m ? s.slice(m[0].length) : s; }
async function runWorkerReal(task /*, attempt */) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let systemPrompt = { type: 'preset', preset: 'claude_code' };
  const wmd = join(PLUGIN_ROOT, 'agents', 'worker.md');
  if (existsSync(wmd)) systemPrompt = stripFrontmatter(readFileSync(wmd, 'utf8'));

  // (3) 타임아웃: abortController + setTimeout
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: task.task_prompt,
      options: {
        model: MODEL,
        cwd: task.working_dir,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        canUseTool: makeCanUseTool(task),       // (2) bypass 대신 가드
        permissionMode: 'default',
        maxTurns: 60,
        maxBudgetUsd: Math.max(0.5, BUDGET - ledger.spentUsd), // (4) 워커별 잔여예산
        abortController: ac,                     // (3)
        systemPrompt,
      },
    });
    let usage = null, turns = 0, subtype = 'error_during_execution', cost = 0, denied = false;
    for await (const m of q) {
      if (m.type === 'result') {
        usage = m.usage; turns = m.num_turns; subtype = m.subtype; cost = m.total_cost_usd || 0;
      }
    }
    // (6) 에러 subtype 분기
    if (subtype === 'success') return { ok: true, usage, cost, turns, via: 'real' };
    return { ok: false, reason: subtype, usage, cost, turns, via: 'real' };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: 'timeout', usage: null, cost: 0, turns: 0, via: 'real' };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const runWorker = REAL ? runWorkerReal : runWorkerMock;
const getTasks = USE_PACT ? getTasksPact : getTasksDemo;

// ---- (1)+(5) 태스크 1건: 재시도 루프 + 격리 (절대 throw 안 함) -------------
async function attemptTask(task) {
  let last;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      const r = await runWorker(task, attempt);
      r.task_id = task.task_id; r.attempts = attempt;
      ledger.spentUsd += r.cost || 0;
      if (r.ok) return { ...r, status: 'done' };
      if (r.denied) return { ...r, status: 'denied' };          // 가드 deny — 재시도 무의미
      last = r;                                                  // error subtype → 재시도
    } catch (e) {
      ledger.spentUsd += 0;
      last = { task_id: task.task_id, ok: false, reason: e.message, attempts: attempt, cost: 0, usage: null };
    }
    if (attempt <= RETRIES) await new Promise((r) => setTimeout(r, 150)); // 백오프
  }
  // (5) 회로차단기: 재시도 소진 → 사람 위임
  return { ...last, status: 'escalated' };
}

// ---- 메인 루프 (오케스트레이터 = 이 코드 = 토큰 0) -------------------------
console.log('=== pact 헤드리스 드라이버 PoC v2 (하드닝) ===');
console.log(`mode: ${REAL ? 'REAL' : 'MOCK'} | ${USE_PACT ? 'PACT' : 'DEMO'} | max=${MAX} cycles=${CYCLES} timeout=${TIMEOUT_MS / 1000}s budget=$${BUDGET} retries=${RETRIES}`);

// 가드 self-test (토큰 0, worker-guard 로직 자체 검증)
const wd0 = '/tmp/wt';
const gOK = (f, ap) => guardToolUse('Write', { file_path: f }, { workingDir: wd0, allowedPaths: ap }).allow;
const stOk = gOK('/tmp/wt/src/a.js', ['src/**']) === true;
const stNo1 = gOK('/tmp/wt/secret.js', ['src/**']) === false;
const stNo2 = gOK('/etc/passwd', ['src/**']) === false;
console.log(`가드 self-test: 허용=${stOk?'✓':'✗'} scope밖거부=${stNo1?'✓':'✗'} worktree밖거부=${stNo2?'✓':'✗'}`);

// --real preflight: SDK 설치 확인 (루프 밖 1회). 미설치를 워커 실패로 오분류하지 않게 먼저 exit 4.
if (REAL) {
  try { nodeRequire.resolve('@anthropic-ai/claude-agent-sdk'); }
  catch {
    console.error('✗ SDK 미설치 — cd experiments/headless-driver && npm i @anthropic-ai/claude-agent-sdk (점검: node sdk-check.mjs)');
    process.exit(4);
  }
}

const tStart = Date.now();
let allOutcomes = [];

for (let c = 1; c <= CYCLES; c++) {
  // (4) 예산 회로차단기 — 사이클 시작 전 점검
  if (ledger.spentUsd >= BUDGET) { ledger.stoppedReason = `예산 초과 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`; break; }

  let tasks, readyToCollect;
  try { ({ tasks, readyToCollect } = getTasks()); }
  catch (e) { ledger.stoppedReason = `태스크 소스 실패: ${e.message}`; break; }
  // spawn 할 것도 없고 collect 할 것도 없으면 종료. (ready_to_collect 면 spawn 만 스킵하고 collect 진행)
  if (!tasks.length && !readyToCollect) { console.log(`\ncycle ${c}: 실행 가능 task 없음 — 종료`); break; }

  writeDriverState({ phase: tasks.length ? 'spawning' : 'collecting', cycle: c, active_workers: tasks.map((t) => t.task_id) });

  if (tasks.length) {
    console.log(`\ncycle ${c}: 워커 ${tasks.length}개 동시 spawn... (오케스트레이터 await = 0 토큰)`);

    // (1) ★ allSettled — 한 워커가 터져도 나머지 결과는 보존됨
    const settled = await Promise.allSettled(tasks.map(attemptTask));
    const outcomes = settled.map((s, i) =>
      s.status === 'fulfilled' ? s.value : { task_id: tasks[i].task_id, status: 'escalated', reason: 'driver 예외: ' + s.reason });

    for (const o of outcomes) {
      allOutcomes.push(o);
      if (o.status === 'escalated') ledger.escalations.push(o);
      const icon = { done: '✓', failed: '✗', denied: '⛔', escalated: '🚨' }[o.status] || '?';
      const tok = o.usage ? (tokOf(o.usage) / 1e6).toFixed(2) + 'M' : '—';
      const extra = o.status === 'done' ? `${o.turns}턴 ${tok}` : (o.reason || '');
      console.log(`  ${icon} ${o.task_id}  [${o.status}]  시도 ${o.attempts || '?'}회  ${extra}`);
    }
  } else {
    console.log(`\ncycle ${c}: spawn 스킵 (모든 워커 이미 done) → collect 로 진행`);
  }

  // (4) 예산 점검 — 사이클 후 누적
  if (ledger.spentUsd >= BUDGET) { ledger.stoppedReason = `예산 초과 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`; break; }

  // 머지 충돌 = 판단 에러 → 자동해결 X, 정지+위임
  if (USE_PACT) {
    // --commit-status: status 변경 자동커밋 (무인 멀티사이클에서 다음 prepare preflight 통과)
    const out = execSync(`node ${PACT_BIN} run-cycle collect --commit-status`, { encoding: 'utf8' });
    const cj = JSON.parse(out);
    const committed = cj.status_commit && cj.status_commit.committed ? 'committed' : 'no-commit';
    console.log(`  collect: merged=${(cj.merged || []).length} conflicted=${cj.conflicted ? 'YES' : 'no'} failures=${(cj.failures || []).length} status=${committed}`);
    if (cj.conflicted) { ledger.stoppedReason = '머지 충돌 — 자동해결 안 함, 사람 위임(/pact:resolve-conflict)'; break; }
  }
}

// ---- 최종 보고 + 불변식 ----------------------------------------------------
const wall = (Date.now() - tStart) / 1000;
const tally = allOutcomes.reduce((m, o) => ((m[o.status] = (m[o.status] || 0) + 1), m), {});
const workerTok = allOutcomes.reduce((a, o) => a + tokOf(o.usage), 0);

console.log('\n=== 결과 ===');
console.log(`완료 ✓${tally.done || 0}  거부 ⛔${tally.denied || 0}  위임 🚨${tally.escalated || 0}  (${allOutcomes.length}건)`);
console.log(`워커 토큰 합: ${(workerTok / 1e6).toFixed(2)}M   비용: $${ledger.spentUsd.toFixed(2)} / 예산 $${BUDGET}   wall=${wall.toFixed(1)}s`);
console.log(`오케스트레이터 토큰: ${ledger.orchestratorTokens}   ← 에러 처리해도 여전히 0`);
if (ledger.stoppedReason) console.log(`⏸  정지: ${ledger.stoppedReason}`);

if (ledger.escalations.length) {
  console.log('\n🚨 사람 위임 필요 (헤드리스→인터랙티브 핸드오프):');
  for (const e of ledger.escalations) console.log(`   - ${e.task_id}: ${e.reason || '2회 실패'} → worktree 보존됨, /pact:resume 로 점검`);
}

writeDriverState({ phase: 'done', active_workers: [], stopped_reason: ledger.stoppedReason, done: tally.done || 0, escalated: tally.escalated || 0 });

if (ledger.orchestratorTokens !== 0) { console.error('\n✗ INVARIANT 실패'); process.exit(1); }
console.log('\n✓ 불변식 유지: 오케스트레이션 = 0 토큰. 기계적 에러는 드라이버가 흡수, 판단 에러는 위임.');
if (!REAL) console.log('[MOCK] 실제 spawn: cd experiments/headless-driver && npm i @anthropic-ai/claude-agent-sdk && node driver.mjs --real');

// 위임이 있으면 비정상 종료코드(자동화 파이프라인이 감지하도록)
process.exit(ledger.escalations.length || ledger.stoppedReason ? 3 : 0);
