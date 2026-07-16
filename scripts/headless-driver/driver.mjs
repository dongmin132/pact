#!/usr/bin/env node
'use strict';

// ============================================================================
// pact 헤드리스 드라이버 — production 헤드리스 드라이버 (하드닝판). scripts/headless-driver/ (v1.0 코어).
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
// 실행 구조 (P2-2 · SPD-1/3): 기본이 K-슬롯 워커 풀이다. 사이클-배리어(배치 전원 종료 대기)
//   대신 슬롯이 비는 즉시 ready 큐에서 (a)deps 충족 (b)in-flight 와 pathsOverlap=false 인 다음
//   task 를 pull → admit → 투입하고, 워커 완료 즉시 그 task 만 게이트(planMerge) 경유 단건 머지한다.
//   ready 큐는 LPT(가장 큰 task 우선)로 정렬해 makespan 을 줄인다. cycle time Σmax(batch)→≈total/K.
//   충돌은 절대 자동해결 안 함 — 정지+사람 위임. 레거시 배치-배리어는 --no-pipeline 로 복귀 가능.
//
// 모드/플래그:
//   --real            실제 Agent SDK spawn (없으면 MOCK)
//   --pact            태스크를 pact CLI에서 + collect (없으면 DEMO)
//   --no-pipeline     레거시 배치-배리어(Promise.allSettled → 직렬 collect)로 복귀
//   --max=N           동시 슬롯 수 K = 하드 캡 (기본 5, prepare 상한과 동일)
//   --recover-after=N (IMP-5) rate-cap 다운시프트 후 연속 클린 settle N회면 동시폭 1 복원 (기본 3)
//                     rate-limit(429/overloaded) 실패 신호에 반응해 유효 동시폭을 일시 다운시프트 →
//                     재시도 재실행 낭비를 줄인다(파이프라인 전용, 하한 1, 상한 --max). 평시 무동작.
//   --cycles=N        graph 소진 후 재-prepare 라운드 수 (기본 1)
//   --model=NAME      실제 워커 모델 (기본 sonnet)
//   --timeout=SEC     워커 hang 백스톱 (기본 1200 — 작업 안 자름, cap 은 budget)
//   --budget=USD      누적 비용 상한 — 넘으면 정지 (기본 10)
//   --retries=N       태스크당 재시도 (기본 1 → 최대 2회 시도)
//   [MOCK 시연용]
//   --fail=ID,ID      이 태스크를 매번 실패 → 재시도 후 escalate 시연
//   --flaky=ID,ID     attempt1만 실패, 재시도서 성공 → 회복 시연
//   --deny=ID,ID      scope 밖 쓰기 시도 → 가드 deny 시연
//   --merge-reject=ID,ID  이 task 의 단건 머지를 rejected 로 강제 → 워커 done≠머지 done 시연(DRV-2)
//   --cost=USD        mock 워커 1개당 비용 (기본 0.9) — budget 차단 시연용
//   --loop=ID:N       [MOCK] loop task 시작 카운트(콤마 다수) — loop-until-dry 시연
//   --loop-step=K     [MOCK] iteration당 감소량 (기본 2)
//   --loop-max=N      [MOCK] mock loop_until.max_iterations (기본 6)
//   --loop-stuck=ID   [MOCK] 줄지 않음 → 정체 escalate 시연
//
// 예) node driver.mjs --fail=DEMO-002             # 1개 죽어도 나머지 생존
//     node driver.mjs --flaky=DEMO-001            # 재시도로 회복
//     node driver.mjs --cycles=3 --budget=2 --cost=1.2   # 예산 차단
// ============================================================================

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runPipeline } from './pool.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 직접 실행(`node driver.mjs` / `pact drive` 의 spawn) 여부 판정. 테스트가 import 하면 false →
// 아래 main()·process.exit 를 건너뛰고 순수 워커 함수(runWorkerReal 등)만 노출한다(계약 테스트용).
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(__filename); }
  catch { return false; }
})();
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
const PIPELINE = !has('--no-pipeline'); // P2-2 · SPD-1: K-슬롯 풀이 기본. 레거시 배치-배리어는 --no-pipeline 로 복귀.
const MAX = Math.floor(getNum('--max', 5));
const CYCLES = Math.floor(getNum('--cycles', 1));
const MODEL = getStr('--model', 'sonnet');
const TIMEOUT_MS = getNum('--timeout', 1200) * 1000; // 넉넉한 hang-backstop(작업 안 자름). 진짜 cap 은 budget.
const BUDGET = getNum('--budget', 10);
const RETRIES = Math.floor(getNum('--retries', 1));
const MAX_RESUME = Math.floor(getNum('--max-resume', 2)); // (2.2) 턴소진 시 fresh 워커 재개 cap
const FAIL = getSet('--fail');
const FLAKY = getSet('--flaky');
const DENY = getSet('--deny');
const MERGE_REJECT = getSet('--merge-reject'); // [MOCK] 이 task 들의 단건 머지를 rejected 로 강제(DRV-2 시연)
const MOCK_COST = getNum('--cost', 0.9);
// loop-until-dry mock 시뮬레이션 (REAL 모드는 measureCount 가 실제 loop_until.count 실행)
const getLoopMap = (n) => new Map((getStr(n, '') || '').split(',').filter(Boolean)
  .map((p) => { const [id, v] = p.split(':'); return [id, Math.max(0, Math.floor(Number(v) || 0))]; }));
const LOOP = getLoopMap('--loop');          // Map<task_id, 시작 카운트>
const LOOP_STEP = getNum('--loop-step', 2); // mock 워커가 iteration 당 줄이는 양
const LOOP_MAX = getNum('--loop-max', 6);   // mock loop_until.max_iterations (최소 1; 0 은 기본값 복귀)
const LOOP_STUCK = getSet('--loop-stuck');  // 줄지 않음 → 정체 시연
const loopState = new Map(LOOP);            // 가변 남은 카운트

// ---- 토큰 원장 (orchestratorTokens 는 절대 안 늘어남 = 불변식) -------------
// DRV-2: mergeRejected/skipped 도 원장에 담아 최종 exit code 에 반영한다. 워커가 SDK 상 done 이어도
// 단건 머지가 rejected/conflicted 면 base 에 미반영이므로 done 이 아니며, 미투입(skipped)도 미완이다.
// 이들을 exit 0(성공)으로 오보하지 않게 escalations 와 대칭으로 위임 신호(exit 3)로 취급한다.
// DX-2: live = 라이브 진행 카운터. 파이프라인 settle 마다 즉시 증가해 writeDriverState 가 매 write 에
// 실어 보낸다 → pact status --watch(drive 의 유일 관측창)가 '완료 N·escalation N' 을 실시간으로 본다.
// 기존엔 done 이 terminal 1회에만, escalations 는 runCyclePipeline 반환 후에야 채워져 실행 내내 0 고착.
// P1-#3: reservedUsd = in-flight 워커들에 배정됐으나 아직 안 쓴 예산 상한의 합(예약액). runWorkerReal
// 이 spawn 시 자기 cap 을 더하고 종료(finally) 시 뺀다. 남은 예산 계산이 (spent + 미사용 예약)을 반영해
// 동시 K 워커의 배정 cap 합이 절대 capBudget 을 넘지 못하게 한다(슬롯 재충전 시 잠재 지출 초과 차단).
// 트랙2 잔여: finally 는 예약 해제(reservedUsd)와 실지출 가산(spentUsd)을 한 동기 블록으로 원자 처리해
// '예약 제거'가 '지출 가산' 없이 관측되는 순간을 없앤다 — 그 간극의 재투입 워커가 잔여 예산을 과대평가해
// 예산을 초과 지출하던 경로 차단. 상위 호출자는 spentAccounted 마커를 보고 중복 가산을 스킵한다.
const ledger = { orchestratorTokens: 0, spentUsd: 0, reservedUsd: 0, budgetExhausted: false, attempts: [], escalations: [], mergeRejected: [], held: [], skipped: [], stoppedReason: null, live: { done: 0, escalated: 0, rejected: 0 } };
// DRV-3: 현재 in-flight 워커 수(pool onEvent 로 갱신). runWorkerReal 이 per-worker 예산 cap 을
// '남은예산/동시수' 로 나누는 분모 — 동시 K 워커가 각자 예산 전액을 받아 K×BUDGET 로 폭주하는 것 방지.
let liveInFlight = 0;
let dispatchHintShown = false; // dogfood #10: --watch 힌트는 첫 dispatch 에 1회만
// IMP-5: rate-limit 반응형 다운시프트의 현재 유효 동시폭. 평시엔 MAX(하드 캡)와 동일 — 조정 시에만 감소/복원.
// driver-state.json 에 항상 실어(additive) pact status 가 "지금 몇 슬롯으로 도는지"를 관측하게 한다.
let effectiveSlots = MAX;
const RECOVER_AFTER = Math.floor(getNum('--recover-after', 3)); // 연속 클린 settle 몇 회에 1 복원(진동 방지)
const tokOf = (u) => u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;

// ---- (verbose) 내부 동작 로그 — 토큰 0 (콘솔만). 워커 도구 호출·사이클 단계 가시화 -------
const VERBOSE = has('--verbose') || has('-v');
const vlog = (...a) => { if (VERBOSE) console.log(...a); };
const toolBrief = (name, input) => {
  input = input || {};
  if (['Read', 'Write', 'Edit'].includes(name)) return `${name}(${String(input.file_path || input.path || input.notebook_path || '?').split('/').pop()})`;
  if (name === 'Bash') return `Bash(${JSON.stringify(String(input.command || '').slice(0, 56))})`;
  if (['Glob', 'Grep'].includes(name)) return `${name}(${input.pattern || ''})`;
  return name;
};

// ---- (2) 안전 가드: worker-guard 단일 소스 (pre-tool-guard 로직 재사용) -------
// 헤드리스 워커가 인터랙티브 워커(서브에이전트)와 "같은 안전 규칙"을 받게 한다.
const nodeRequire = createRequire(import.meta.url);
const { guardToolUse } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lib', 'worker-guard.js'));
const { estimateCostUsd } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lib', 'cost-estimate.js'));
const { writeJsonAtomic } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lib', 'atomic-write.js'));
// STAB-1 belt: 같은 레포에 두 드라이버 동시 실행 차단(drive-owner.json, isAlive 게이트).
const { acquireDriveLock, releaseDriveLock } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lock.js'));
const { shouldResume, classifyRealResult, withContinuation } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'worker-completion', 'resume.js'));
// P2-2 · SPD-1/3: K-슬롯 풀이 쓰는 결정적 재사용 primitive — 슬롯 overlap 게이팅(pathsOverlap)과
// LPT 정렬용 file_count 추정(sizecheck). 둘 다 CJS 라 nodeRequire.
const { pathsOverlap } = nodeRequire(join(PLUGIN_ROOT, 'batch-builder.js'));
const { assessTask: sizeAssess } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'sizecheck.js'));
// DRV-1 2차 방어: 최종보고 직전 task source 를 결정적 스캔해 잔여 미완 task 를 잡는다(성공 오보 차단).
const { discoverTaskFiles, parseTaskFiles } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'task-sources.js'));

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
      budget: BUDGET, // pact status 가 비용 진행률 바를 그리는 분모
      escalations: ledger.escalations.length,
      // DX-2: 라이브 진행 카운터를 항상 포함 → status 대시보드가 종료 전에도 진행을 본다.
      // (writeJsonAtomic 은 매 호출 전체 재기록이라 patch 에만 넣으면 다음 write 에 사라진다 → base 에 상주.)
      // terminal write 는 patch 로 최종 tally 를 덮어 authoritative 값을 남긴다.
      done: ledger.live.done,
      escalated: ledger.live.escalated,
      rejected: ledger.live.rejected,
      effective_slots: effectiveSlots, // IMP-5: 현재 유효 동시폭(=MAX 가 평시값, rate-cap 시 감소)
      ...patch,
    });
  } catch { /* 관측은 best-effort — 실패해도 작업엔 영향 없음 */ }
}

// ---- (DX-2) 라이브 진행 카운터: settle 로 즉시 증가 (종료 tally 와 정합) ------
// 종료 시 allOutcomes tally(=merge-rejected 를 done→rejected 로 재라벨한 뒤의 집계)와 정확히
// 일치하도록, outcome.status 와 단건 머지 결과를 함께 본다: 워커가 done 이어도 머지가 rejected/
// conflicted 면 base 미반영이라 done 아님 → rejected 로 센다. 비-settle 이벤트는 무시.
function tallySettle(counters, evt) {
  if (!evt || evt.type !== 'settle') return counters;
  const st = evt.outcome && evt.outcome.status;
  const mergeBad = evt.merge && (evt.merge.result === 'rejected' || evt.merge.result === 'conflicted');
  if (st === 'done') { if (mergeBad) counters.rejected++; else counters.done++; }
  else if (st === 'escalated') counters.escalated++;
  else if (st === 'rejected') counters.rejected++;
  return counters;
}

// ---- (IMP-2) settle 시 워커 미보고 status.json 합성 (드라이버 = 권위 소스) ----
// escalate/timeout/budget 로 죽은 워커는 종료 step("Write final status")에 못 가 status.json 을 안
// 남긴다 → metrics(collect.js:27)가 '비용0·failed' 로 오집계한다. 드라이버는 SDK 실측 cost/usage·
// resume 횟수·salvageable 을 쥔 사이클의 유일 권위 소스이므로, status.json 부재 시 그걸로 합성한다.
// 워커 자기보고(status.json 존재)는 절대 덮지 않는다 → metrics 리더 무변경으로 기존 경로에서 정확 집계.
function metricStatusOf(o) {
  if (!o) return 'failed';
  if (o.status === 'done') return 'done';
  if (o.status === 'escalated') return o.salvageable ? 'blocked' : 'failed'; // 부분작업 보존=blocked, 하드실패=failed
  if (o.status === 'rejected') return 'blocked'; // 머지 게이트 거부 = base 미반영, 사람 필요
  return 'failed'; // denied 등
}
function synthesizeRunStatus(outcome, opts = {}) {
  const runsRoot = opts.runsRoot || join(process.cwd(), '.pact', 'runs');
  const id = outcome && outcome.task_id;
  if (!id) return { written: false, reason: 'no_task_id' };
  const statusPath = join(runsRoot, id, 'status.json');
  try {
    if (existsSync(statusPath)) return { written: false, reason: 'self_reported' }; // 워커 자기보고 보존
    mkdirSync(join(runsRoot, id), { recursive: true });
    const status = metricStatusOf(outcome);
    writeJsonAtomic(statusPath, {
      task_id: id,
      status,
      tokens_used: tokOf(outcome.usage),
      cost_usd: Number(outcome.cost || 0),
      resumes: outcome.resumes || 0,
      attempts: outcome.attempts || 0,
      salvageable: !!outcome.salvageable,
      reason: outcome.reason || null,
      synthesized_by: 'driver', // metrics/디버깅용 마커 — 워커 자기보고와 구분
      completed_at: new Date().toISOString(),
    });
    return { written: true, status, path: statusPath };
  } catch (e) { return { written: false, reason: 'error:' + ((e && e.message) || e) }; }
}

// ---- (IMP-1) 파이프라인 타이밍 이벤트 영속: .pact/driver-events.jsonl ---------
// pool.mjs 스케줄러가 유일 권위 소스로 dispatch/settle(+ts)를 발화한다. 그걸 JSONL 로 흘려
// 두면 metrics(compute.pipelineTiming)가 사후에 유효 병렬폭·실측 동시폭을 잰다 —
// drive 의 헤드라인 가치(makespan 압축)를 self-reported deferred 가 아니라 실측으로 승격.
// 결정적 파일 IO 라 오케스트레이터 토큰은 여전히 0. 관측은 best-effort(실패해도 작업 무영향).
function driverEventsPath(opts = {}) {
  return opts.eventsPath || join(process.cwd(), '.pact', 'driver-events.jsonl');
}

// pool 이벤트(id 키) → JSONL 레코드({ts(ISO), type, task_id, ...}). settle 은 결말/머지도 남긴다.
function driverEventLine(evt) {
  const ms = typeof evt.ts === 'number' ? evt.ts : Date.now();
  const rec = { ts: new Date(ms).toISOString(), type: evt.type, task_id: evt.id };
  if (evt.type === 'settle') {
    if (evt.outcome && evt.outcome.status) rec.status = evt.outcome.status;
    if (evt.merge && evt.merge.result) rec.merge = evt.merge.result;
  }
  // IMP-5: rate-limit 반응형 다운시프트 조정 — 유효 동시폭 전이(from→to)를 makespan 재구성 소스에 남긴다.
  if (evt.type === 'downshift') {
    rec.from = evt.from; rec.to = evt.to; rec.direction = evt.direction;
    if (evt.signal) rec.signal = evt.signal;
  }
  return rec;
}

// JSONL 한 줄 append(원자적 append). USE_PACT 아니고 eventsPath 주입도 없으면 무시(demo).
function appendDriverEvent(evt, opts = {}) {
  if (!USE_PACT && !opts.eventsPath) return { written: false, reason: 'demo' };
  try {
    const p = driverEventsPath(opts);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(evt) + '\n');
    return { written: true, path: p };
  } catch (e) { return { written: false, reason: 'error:' + ((e && e.message) || e) }; }
}

// 사이클 시작 경계 처리(무한 성장 방지 + merge-result cycle_id 정합): 파일의 마지막 cycle 마커
// cycle_id 가 같으면(=같은 사이클 resume/admit) 이월(append 유지), 다르거나 없으면(=새 사이클)
// 회전(truncate) 후 새 cycle 마커. merge-result.json 의 fresh-per-cycle/사이클내-누적과 대칭.
function beginCycleEvents(cycleId, cycleNum, opts = {}) {
  if (!USE_PACT && !opts.eventsPath) return;
  try {
    const p = driverEventsPath(opts);
    let sameCycle = false;
    if (cycleId != null && existsSync(p)) {
      const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let j; try { j = JSON.parse(lines[i]); } catch { continue; }
        if (j && j.type === 'cycle') { sameCycle = j.cycle_id === cycleId; break; }
      }
    }
    mkdirSync(dirname(p), { recursive: true });
    if (!sameCycle) writeFileSync(p, ''); // 회전: 새 사이클이면 이전 이벤트 폐기
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), type: 'cycle', cycle: cycleNum, cycle_id: cycleId || null }) + '\n');
  } catch { /* best-effort — 관측 실패해도 작업엔 영향 없음 */ }
}

// 진행 중 사이클의 cycle_id = current_batch.json 의 prepared_at(merge-result 와 동일 소스).
function readCycleId(opts = {}) {
  try {
    const p = opts.currentBatchPath || join(process.cwd(), '.pact', 'current_batch.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return typeof j.prepared_at === 'string' ? j.prepared_at : null;
  } catch { return null; }
}

// canUseTool 콜백 팩토리 — worker-guard 로 worktree 경계 + allowed_paths(glob) + SOT/Bash 검사
function makeCanUseTool(task) {
  return async (toolName, input) => {
    const r = guardToolUse(toolName, input || {}, { workingDir: task.working_dir, allowedPaths: task.allowed_paths });
    // ⚠️ allow 는 updatedInput(원본 input) 필수 — .d.ts 는 optional 로 표기하지만 CLI(2.1.20x)
    // 런타임 Zod 스키마가 allow arm 에 record 를 요구한다. 누락 시 모든 도구 호출이
    // "Tool permission request failed: ZodError" 로 거부돼 워커가 산출 0 으로 예산만 태운다
    // (dogfood 실측: 3세대 $0.92 · 커밋 0). allowedTools shadow 시절엔 이 콜백이 아예 안
    // 불려 잠복해 있던 결함. 계약 테스트가 응답 shape 를 고정한다.
    // deny 는 interrupt 없이 — interrupt:true 면 deny 1회에 워커 세션이 즉사(ede, dogfood #12
    // 실측: LC-001 3세대가 같은 deny 에서 전멸). 인터랙티브 pre-tool-guard 처럼 행동만 막고
    // 워커는 살려 우회·적응하게 한다(폭주는 budget/maxTurns 가 bound).
    return r.allow
      ? { behavior: 'allow', updatedInput: input || {} }
      : { behavior: 'deny', message: r.reason };
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
      loop_until: LOOP.has(`DEMO-${String(i + 1).padStart(3, '0')}`) ? { count: 'mock', max_iterations: LOOP_MAX } : null,
    };
  });
  return { tasks, readyToCollect: false, graph: { ready: [], tasks: {} } };
}
function getTasksPact() {
  // 코어 수정으로 prepare 는 already_prepared 에도 task_prompts 를 항상 반환한다
  // (makeTaskPrompt 단일 소스) → 드라이버 자체 reconstruct 불필요 = drift 근원 제거.
  // P2-2 · SPD-2: --graph 로 batch0 밖 전체 DAG 도 받아 슬롯 풀이 pull 대상을 안다.
  // STAB-1: 장수 드라이버 pid 를 owner 로 주입 → 인터랙티브/타 세션이 같은 사이클 재개 시 cycle-busy 거부.
  // DX-1: prepare 실패(cycle-busy/preflight/tbd)는 exit≠0 이라 execSync 가 throw 하지만, fix 담긴
  // JSON 은 stdout 에 emit 돼 있다. makeAdmit/mergeOnePact 와 동형으로 e.stdout 에서 JSON 을 살려
  // 읽어, 'Command failed' 셸 덤프 대신 stage + message + actionable fix 를 리포트에 노출한다.
  let out;
  try { out = execSync(`node "${PACT_BIN}" run-cycle prepare --max=${MAX} --graph --owner-pid=${process.pid} --session=drive`, { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '').toString(); }
  let j;
  try { j = JSON.parse(out); }
  catch { throw new Error('prepare 응답 파싱 실패' + (out ? ': ' + out.slice(0, 200) : ' (빈 출력)')); }
  if (j.ok === false) {
    const msgs = (j.errors || []).map((x) => x.message).filter(Boolean).join('; ');
    const fixes = (j.errors || []).map((x) => x.fix).filter(Boolean).join(' / ');
    throw new Error(`prepare ${j.stage || '실패'}: ${msgs || JSON.stringify(j.errors)}${fixes ? ` → ${fixes}` : ''}`);
  }
  // P1-1 · SPD-4: 슬로우니스 경고는 헤드리스(사람 부재)라 행동에 못 옮김 → 로그 1줄만.
  const warnN = (j.size_warnings || []).length + (j.scope_warnings || []).length + (j.bundle_warnings || []).length;
  if (warnN > 0) console.log(`  ⚠️ 슬로우니스 경고 ${warnN}건 (size:${(j.size_warnings || []).length} scope:${(j.scope_warnings || []).length} bundle:${(j.bundle_warnings || []).length}) — 분해는 인터랙티브 /pact:plan 에서.`);
  const graph = j.task_graph || { ready: [], tasks: {} };
  if (j.empty) return { tasks: [], readyToCollect: false, graph };
  if (j.ready_to_collect) {
    console.log('  (already_prepared + 모든 워커 done — spawn 스킵, collect 로)');
    return { tasks: [], readyToCollect: true, graph };
  }
  if (j.already_prepared) console.log('  (already_prepared — 미완료 task 재개)');
  return { tasks: j.task_prompts || [], readyToCollect: false, graph };
}

// ---- 워커 러너 (mock) — fault 주입 -----------------------------------------
async function runWorkerMock(task, attempt) {
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 500));
  // loop task mock: 진행 시뮬레이션 — stuck 아니면 LOOP_STEP 만큼 남은 카운트 감소
  if (task.loop_until && loopState.has(task.task_id) && !LOOP_STUCK.has(task.task_id)) {
    loopState.set(task.task_id, Math.max(0, loopState.get(task.task_id) - LOOP_STEP));
  }
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

// ---- 진행 신호 측정 (결정적). MOCK: loopState / REAL: loop_until.count stdout 마지막 정수 ----
function measureCount(task) {
  if (!REAL) return loopState.has(task.task_id) ? loopState.get(task.task_id) : 0;
  try {
    const out = execSync(task.loop_until.count, { cwd: task.working_dir, encoding: 'utf8', shell: '/bin/bash' });
    const nums = String(out).match(/-?\d+/g);
    if (!nums) return null;                                  // 정수 없음 → 측정 불가
    return Math.max(0, parseInt(nums[nums.length - 1], 10)); // 마지막 정수
  } catch { return null; }                                   // 명령 에러 → 측정 불가
}

// ---- 워커 러너 (real) — SDK + 타임아웃 + 가드 + 예산 ------------------------
function stripFrontmatter(s) { const m = /^---\n[\s\S]*?\n---\n/.exec(s); return m ? s.slice(m[0].length) : s; }
async function runWorkerReal(task, opts = {}) {
  // SDK query 주입 가능 — 기본은 동적 import(프로덕션). 테스트는 가짜 async-generator 를 주입해
  // 실제 SDK/네트워크 없이 재발버그(zombie·spent_usd 0·SIGINT 고착) 계약을 고정한다.
  // (프로덕션에선 attempt 번호가 opts 로 넘어오나 primitive 라 opts.query/timeoutMs = undefined → 무해.)
  const query = opts.query || (await import('@anthropic-ai/claude-agent-sdk')).query;
  let systemPrompt = { type: 'preset', preset: 'claude_code' };
  const wmd = join(PLUGIN_ROOT, 'agents', 'worker.md');
  if (existsSync(wmd)) systemPrompt = stripFrontmatter(readFileSync(wmd, 'utf8'));

  // 끝까지 두고 폭주는 budget 으로 막는다(워크플로우 방식). 턴/시간은 작업을 자르지 않는
  // 넉넉한 backstop. wall-clock 발화 시 abort 만으론 SDK 가 안 죽을 수 있어 q.close()로 실제 종료.
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS; // 테스트가 짧은 backstop 주입 → abort/정리 경로 검증
  // DRV-3: per-worker 예산 cap 을 '동시 실행 워커 수'로 나눠 배정. 이전엔 각 워커가 (BUDGET-spent)
  // 전액을 받아 동시 K 워커면 실효 상한이 K×BUDGET 로 새어 나갔다(헤더 안전장치 #4 무력화).
  // activeWorkers = 현재 in-flight 수(liveInFlight) → 동시 K 는 각 BUDGET/K, 마지막 1개는 잔여 전액(적응적).
  const capBudget = (typeof opts.budget === 'number') ? opts.budget : BUDGET;
  const activeWorkers = (typeof opts.activeWorkers === 'number') ? opts.activeWorkers : liveInFlight;
  // P1-#3: 남은 예산 = capBudget - 이미 쓴 비용 - in-flight 예약(아직 안 쓴 배정 상한). 예약을 빼야
  // 이미 실행 중인 워커에 배정된 미사용 상한이 이중 배정되지 않아, 동시 워커의 배정 cap 합 ≤ capBudget.
  const remainingBudget = Math.max(0, capBudget - ledger.spentUsd - ledger.reservedUsd);
  // per-worker cap = 남은 예산을 동시수로 균등 분할. floor(0.5)로 최소치는 주되, 남은 예산은 절대 못 넘게
  // clamp — remaining 이 floor 보다 작으면(예: --budget=0.1) remaining 이 상한이라 declared 예산 초과 X.
  const BUDGET_FLOOR = 0.5;
  const workerBudgetUsd = Math.min(remainingBudget, Math.max(BUDGET_FLOOR, remainingBudget / Math.max(1, activeWorkers)));
  // H4/H4-2: 잔여 예산이 in-flight 예약으로 소진되면 cap 이 0(이하) 또는 극소 양수(FP 잔재·1턴 비용
  // 미만)가 된다. SDK 는 undefined 만 거르고 0 을 --max-budget-usd 0 으로 CLI 에 넘겨 CLI 가
  // "must be a positive number greater than 0" 로 즉사시키고, 극소 양수는 스폰돼도 즉시 예산 소진 →
  // incomplete 오분류·resume 헛돌기. 둘 다 스폰하지 않고 budgetExhausted 신호를 반환한다(예약도
  // 안 잡음 → 팬텀 예약 방지). MIN_DISPATCH 는 declared budget(예: --budget=0.1)을 침범하지 않는
  // 절대 하한 — 잔여가 그보다 작을 때만 발동(=예약 소진/FP 잔재).
  // ⚠️ 재투입은 자동이 아니다: budgetExhausted 는 ledger 플래그로 pool 의 신규 dispatch 를 정지시켜
  // 잔여 ready 큐가 escalated 로 캐스케이드되는 걸 막는다(H4-2). 남은 task 는 skipped 로 다음
  // 사이클(예약 해제·spent 확정 후)에 재평가된다.
  const MIN_DISPATCH = 0.005;
  if (remainingBudget < MIN_DISPATCH || !(workerBudgetUsd > 0)) {
    ledger.budgetExhausted = true;   // pool.shouldStop 신호 → 캐스케이드 정지
    return {
      ok: false,
      budgetExhausted: true,
      reason: `예산 소진 — 남은 예산 $${remainingBudget.toFixed(4)} < 최소치 $${MIN_DISPATCH} (spent $${ledger.spentUsd.toFixed(2)} + reserved $${ledger.reservedUsd.toFixed(2)} ≈ cap $${capBudget}). --budget 상향 필요`,
      cost: 0, usage: null, turns: 0, via: 'real',
    };
  }
  // 예약 회계: 배정한 cap 을 예약액에 즉시 더한다(finally 에서 해제). 다음 워커의 남은 예산 계산에 반영돼
  // 슬롯 재충전 시 in-flight 워커의 미사용 상한까지 차감된다 → 전체 잠재 지출 ≤ capBudget 불변식 보장.
  ledger.reservedUsd += workerBudgetUsd;
  let q, timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { ac.abort(); } catch { /* noop */ }
    try { if (q && typeof q.close === 'function') q.close(); } catch { /* noop */ }
  }, timeoutMs);

  // usage/cost 는 모든 메시지에서 갱신 — 중간에 끊겨도 마지막 본 값 보존(비용 0 방지).
  // result 는 반환 객체를 finally 가 참조하기 위한 홀더 — finally 에서 예약 해제와 spent 가산을
  // 원자적으로 처리하고 이 객체에 spentAccounted 마커를 찍는다(상위 호출자 중복 가산 방지).
  // 트랙2: SDK 는 abort/timeout 시 result 없이 throw 할 수 있어(0.3.178 실측) total_cost_usd 를
  // 영영 못 본다 → assistant 메시지의 message.usage 를 누적해 두고 그 경로에서 비용을 추정한다.
  // 같은 API 응답의 블록들이 각각 assistant 메시지로 흘러오며 usage 를 공유하므로 message.id 로 dedup.
  let usage = null, turns = 0, subtype = 'error_during_execution', cost = 0, result = null;
  const streamUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let streamUsageSeen = false;
  const seenMsgIds = new Set();
  // C-1: per-task 모델 분기 — tasks/*.md frontmatter worker_model(haiku|sonnet|opus)이 payload →
  // task_prompts 로 전달됨. 단순·기계적 task 를 haiku 로 돌리면 배치 토큰(워커가 ~70%)이 크게 준다.
  const workerModel = task.worker_model || MODEL;
  try {
    q = query({
      prompt: task.task_prompt,
      options: {
        model: workerModel,
        cwd: task.working_dir,
        // ⚠️ allowedTools 절대 금지: allow rule 에 매칭된 도구는 canUseTool 을 스킵(자동 승인)한다
        // — 공식 permissions 문서 + SDK 0.3.178 실측(deny 콜백 0회 호출, Write 실행됨).
        // 도구 제한·경계는 canUseTool(worker-guard) 단일 관문이 담당한다. 계약 테스트가 고정(T2-1).
        canUseTool: makeCanUseTool(task),
        permissionMode: 'default',
        maxTurns: 200,                                          // 넉넉한 backstop (작업 안 자름)
        maxBudgetUsd: workerBudgetUsd,                          // ★ 진짜 cap = 예산 (DRV-3: 동시수로 분할)
        abortController: ac,
        systemPrompt,
      },
    });
    for await (const m of q) {
      if (m && m.usage) usage = m.usage;
      if (m && typeof m.total_cost_usd === 'number') cost = m.total_cost_usd;
      if (m && m.type === 'assistant' && m.message && m.message.usage && !seenMsgIds.has(m.message.id)) {
        seenMsgIds.add(m.message.id);
        const u = m.message.usage;
        streamUsage.input_tokens += u.input_tokens || 0;
        streamUsage.output_tokens += u.output_tokens || 0;
        streamUsage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
        streamUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
        streamUsageSeen = true;
      }
      if (m && m.type === 'result') { turns = m.num_turns || turns; subtype = m.subtype; }
      // (verbose) 워커가 부르는 도구를 실시간 스트리밍 — 내부 동작 가시화
      if (VERBOSE && m && m.type === 'assistant') {
        for (const b of (m.message && m.message.content) || []) {
          if (b.type === 'tool_use') vlog(`  [${task.task_id}] 🔧 ${toolBrief(b.name, b.input)}`);
        }
      }
    }
    // ⚠️ SDK 는 abort/timeout 시 throw 하지 않고 subtype='error_during_execution' result 를
    // 반환할 수 있다(라이브 --real 로 발견) → timedOut/aborted 를 subtype 보다 우선해 incomplete
    // 로 분류(안 그러면 resume 대신 retry + 부분작업 미보존). 단일소스 resume.js.
    const cls = classifyRealResult({ subtype, timedOut, aborted: ac.signal.aborted });
    result = cls.ok
      ? { ok: true, usage, cost, turns, via: 'real' }
      : { ok: false, reason: cls.reason, usage, cost, turns, via: 'real', incomplete: cls.incomplete };
    return result;
  } catch (e) {
    // timeout/예외 — 본 만큼의 cost 보존, worktree 부분작업 보존 대상(incomplete).
    const reason = (timedOut || ac.signal.aborted) ? 'timeout' : ('error:' + ((e && e.message) || e));
    result = { ok: false, reason, usage, cost, turns, via: 'real', incomplete: true };
    return result;
  } finally {
    clearTimeout(timer);
    // 트랙2: result(total_cost_usd)를 못 본 채 끝났으면(=abort/throw 경로) 누적 assistant usage 로
    // 비용을 추정해 ledger 과소계상을 막는다. 실측이 있으면 실측이 항상 우선.
    if (!cost && streamUsageSeen) {
      cost = estimateCostUsd(streamUsage, workerModel);
      if (result) { result.cost = cost; result.costEstimated = true; }
      if (result && !result.usage) result.usage = { ...streamUsage };
    }
    // 트랙2 잔여 수리: '예약 해제'와 '지출 가산'을 한 동기 블록에서 원자적으로 처리한다. 이전엔 여기서
    // 예약만 반납하고 실지출(cost)은 상위 attemptTask/runLoopTask 가 한 마이크로태스크 뒤에 더했다 →
    // 그 간극에 재투입된 워커가 (예약 빠짐 + 지출 미가산) 상태를 관측해 remaining=capBudget-spent-reserved
    // 를 과대평가, 잠재 지출이 capBudget 을 cost 만큼 초과할 수 있었다. 이제 spent 가산과 reserved 해제가
    // 원자적이라 '예약 제거'가 '지출 가산' 없이 관측되는 순간이 없다. 이중계상은 spentAccounted 마커로
    // 상위 호출자가 스킵해 방지. (부차: 워커별 opts.budget 이 서로 다르면 예약합≤capBudget 증명이 깨지나,
    // production 은 전부 BUDGET 이라 무해.)
    ledger.spentUsd += cost;
    ledger.reservedUsd = Math.max(0, ledger.reservedUsd - workerBudgetUsd);
    if (result) result.spentAccounted = true; // 상위(attemptTask/runLoopTask) 중복 가산 방지 마커
  }
}

const runWorker = REAL ? runWorkerReal : runWorkerMock;
const getTasks = USE_PACT ? getTasksPact : getTasksDemo;

// ---- (1)+(5) 태스크 1건: 재시도 루프 + 격리 (절대 throw 안 함) -------------
async function attemptTask(task, opts = {}) {
  const worker = opts.runWorker || runWorker; // 테스트가 가짜 runner 주입 → resume 오케스트레이션 검증
  let last;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      const r = await worker(task, attempt);
      r.task_id = task.task_id; r.attempts = attempt;
      // 트랙2 잔여: runWorkerReal 은 예약 해제와 원자적으로 spent 를 이미 가산(spentAccounted 마커)
      // → 여기서 다시 더하면 이중계상. mock/주입 러너는 마커가 없어 종전대로 여기서 가산.
      if (!r.spentAccounted) ledger.spentUsd += r.cost || 0;
      if (r.ok) return { ...r, status: 'done' };
      if (r.denied) return { ...r, status: 'denied' };          // 가드 deny — 재시도 무의미
      // H4: 예산 소진으로 스폰조차 못 함 → 재시도·resume 무의미(예산은 안 늘어남). 부분작업도 없어
      // salvage 대상 아님. 예산 상향/다음 사이클 안내 사유와 함께 즉시 위임(거짓 3회실패 오보 제거).
      if (r.budgetExhausted) return { ...r, status: 'escalated', salvageable: false };
      // budget/시간 소진(incomplete) → 재시도해도 또 소진 + 부분작업 손실 위험 → 즉시 위임(보존).
      if (r.incomplete) return { ...r, status: 'escalated', salvageable: true };
      last = r;                                                  // 일시 error subtype → 재시도
    } catch (e) {
      last = { task_id: task.task_id, ok: false, reason: (e && e.message) || String(e), attempts: attempt, cost: 0, usage: null };
    }
    if (attempt <= RETRIES) await new Promise((r) => setTimeout(r, 150)); // 백오프
  }
  // (5) 회로차단기: 재시도 소진 → 사람 위임
  return { ...last, status: 'escalated' };
}

// ---- (2.2) 일반 task: 턴/예산 소진(incomplete) 시 같은 worktree 에 fresh 워커 재투입 ----
// 같은 워커 재시도는 무의미하지만 부분작업이 worktree 에 보존되므로, FRESH 워커가 "처음부터"
// 가 아니라 "이어서" 마저 끝낼 수 있다(사람 salvage 제거). resume-cap·예산 초과 시 위임(보존).
async function runResumableTask(task, opts = {}) {
  let cur = task;
  for (let resume = 0; ; resume++) {
    const r = await attemptTask(cur, opts);
    // 미완(턴/예산 소진)이 아니면 그대로 (done/denied/일반 escalate) — 기존 동작 불변.
    // H4-2: budgetExhausted 로 스폰 못 했어도 이전 세대(resume>0)가 worktree 에 부분작업을 남겼으면
    // salvageable(=takeover 대상). 첫 시도(resume=0) 부터 소진이면 산출물 없음 → salvageable:false 유지.
    if (!(r.status === 'escalated' && r.incomplete)) {
      const salvageable = r.budgetExhausted ? resume > 0 : r.salvageable;
      return { ...r, salvageable, resumes: resume };
    }
    if (ledger.spentUsd >= BUDGET)
      return { ...r, status: 'escalated', salvageable: true, resumes: resume, reason: `${r.reason || '미완'} — 예산 소진으로 resume 중단` };
    if (!shouldResume(r, resume, MAX_RESUME))
      return { ...r, status: 'escalated', salvageable: true, resumes: resume, reason: `${r.reason || '턴 소진'} — fresh 워커 ${resume}회 재개 후 위임` };
    if (VERBOSE) vlog(`  [${task.task_id}] 🔁 미완 → fresh 워커 resume ${resume + 1}/${MAX_RESUME} (같은 worktree, 이어서)`);
    // DOG-3: 직전 사유를 continuationPrompt 로 전달(같은 코어). 드라이버 사유는 전부 턴소진형이라
    // 서사·출력은 종전과 동일 — 게이트 거부 사유가 흐를 경우에만 [직전 거부 사유] 줄이 붙는다.
    cur = withContinuation(task, resume + 1, r.reason || null);
  }
}

// ---- loop-until-dry: 측정된 진행 중에만 fresh 워커 재투입 (절대 throw 안 함) ----
// done/progress 판정은 워커 자기보고가 아니라 measureCount(결정적)로만 한다 (ADR-057, ADR-012).
async function runLoopTask(task) {
  const MAX_ITER = (task.loop_until && task.loop_until.max_iterations) || 6;
  let prev = measureCount(task);
  if (prev === null) return { task_id: task.task_id, status: 'escalated', reason: 'loop 측정 불가(초기)', salvageable: true, attempts: 0, usage: null };
  if (prev === 0)    return { task_id: task.task_id, status: 'done', via: REAL ? 'real' : 'mock', attempts: 0, usage: null, turns: 0 };
  let iter = 0, lastUsage = null;
  while (true) {
    if (ledger.spentUsd >= BUDGET) return { task_id: task.task_id, status: 'escalated', reason: `budget 소진 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`, salvageable: true, attempts: iter, usage: lastUsage };
    let r;
    try { r = await runWorker(task, ++iter); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e), cost: 0, usage: null }; }
    // H4-2: loop task 도 예산 소진으로 스폰조차 못 했으면 '정체' 로 오라벨하지 말고 예산 사유로 위임.
    if (r.budgetExhausted) return { task_id: task.task_id, status: 'escalated', reason: r.reason || '예산 소진 — 스폰 불가', salvageable: iter > 1, attempts: iter - 1, usage: lastUsage };
    // 트랙2 잔여: real 워커는 runWorkerReal.finally 가 예약 해제와 원자적으로 spent 가산(마커) → 스킵.
    if (!r.spentAccounted) ledger.spentUsd += (r.cost || 0);
    if (r.usage) lastUsage = r.usage;
    const cur = measureCount(task);                    // ★ 결정적 재측정 (워커 자기보고 불신)
    if (cur === null)  return { task_id: task.task_id, status: 'escalated', reason: 'loop 측정 불가', salvageable: true, attempts: iter, usage: lastUsage };
    if (cur === 0)     return { task_id: task.task_id, status: 'done', via: r.via ?? (REAL ? 'real' : 'mock'), attempts: iter, usage: lastUsage, turns: r.turns ?? 0 };
    if (cur >= prev)   return { task_id: task.task_id, status: 'escalated', reason: `정체(no-progress) — 남은 ${cur}`, salvageable: true, attempts: iter, usage: lastUsage };
    if (iter >= MAX_ITER) return { task_id: task.task_id, status: 'escalated', reason: `max_iterations(${MAX_ITER}) — 남은 ${cur}`, salvageable: true, attempts: iter, usage: lastUsage };
    prev = cur;
  }
}

// ---- P2-2 · SPD-1/3: K-슬롯 풀 배선 (pool.mjs 스케줄러에 부수효과 주입) --------
// 스케줄러는 순수(pool.mjs). 여기서 admit/runTask/mergeOne/overlaps 를 mode 별로 꽂는다.

// LPT 정렬용 task 크기(파일 수 추정) — sizecheck 재사용(비교자 1개, 거의 무료).
function sizeOfTask(id, allowedPaths) {
  try { return sizeAssess({ id, allowed_paths: allowedPaths || [] }).file_count || 0; }
  catch { return 0; }
}

// [MOCK] 단건 머지 시뮬 — 데모/파이프라인에서 planMerge reject 경로(DRV-2)를 실 pact 없이 재현.
// --merge-reject=ID 에 든 task 는 rejected(base 미반영), 그 외는 merged. 플래그 없으면 미사용(mergeOne=null).
async function mergeOneMock(id) {
  if (MERGE_REJECT.has(id)) return { result: 'rejected', detail: { task_id: id, reason: 'mock 머지 게이트 거부(--merge-reject)' } };
  return { result: 'merged', detail: {} };
}

// 워커 산출 1건 콘솔 보고(파이프라인/레거시 공용).
function reportOutcome(o) {
  // DRV-2: rejected = 워커는 done 이나 머지 게이트에서 거부돼 base 에 미반영(done 아님) → ⛔.
  const icon = { done: '✓', failed: '✗', denied: '⛔', escalated: '🚨', rejected: '⛔', held: '⏸' }[o.status] || '?';
  const tok = o.usage ? (tokOf(o.usage) / 1e6).toFixed(2) + 'M' : '—';
  const extra = o.status === 'done' ? `${o.turns}턴 ${tok}` : (o.reason || '');
  console.log(`  ${icon} ${o.task_id}  [${o.status}]  시도 ${o.attempts || '?'}회  ${extra}`);
}

// 배치 collect(레거시 배리어 + ready_to_collect resume 경로 공용). 'conflict'|'ok' 반환.
function collectBatch() {
  // M8: collect 가 exit≠0(외부 MERGE_HEAD·cycle-busy)로 끝나면 execSync 가 throw 해 드라이버가
  // 스택트레이스로 통째 크래시하고 driver-state 가 collecting 고착·최종보고 스킵됐다. stdout 에 JSON 이
  // 실려 오면(admit/collect-one 규약과 동일) 그것으로 진행하고, 아니면 정지 신호로 우아하게 종료.
  let out;
  try {
    out = execSync(`node "${PACT_BIN}" run-cycle collect --commit-status`, { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '').toString();
    if (!out.trim()) {
      ledger.stoppedReason = `collect 실패 (exit≠0): ${(e.stderr || e.message || '').toString().trim().slice(0, 200)}`;
      return 'conflict'; // 신규 dispatch 중단 + 정지(루프가 break)
    }
  }
  let cj;
  try { cj = JSON.parse(out); }
  catch { ledger.stoppedReason = 'collect 출력 파싱 실패 (비 JSON)'; return 'conflict'; }
  const committed = cj.status_commit && cj.status_commit.committed ? 'committed' : 'no-commit';
  const rejected = cj.rejected || [];
  console.log(`  collect: merged=${(cj.merged || []).length} conflicted=${cj.conflicted ? 'YES' : 'no'} rejected=${rejected.length} failures=${(cj.failures || []).length} status=${committed}`);
  if (VERBOSE) {
    vlog(`  [collect] merged=${JSON.stringify(cj.merged || [])}`);
    for (const r of rejected) vlog(`  [collect] ✗ ${r.task_id}: ${r.reason}`);
    for (const f of cj.failures || []) vlog(`  [collect] ⚠ ${f.task_id}: ${f.status} ${(f.blockers || []).join('; ')}`);
  }
  // DRV-2(레거시 대칭): 배치 collect 의 rejected(게이트 통과 실패 → base 미반영)도 원장에 기록해
  // 최종 tally·exit 에 반영한다. 파이프라인은 인라인 재라벨, 레거시는 최종보고의 정규화 패스가 처리.
  for (const r of rejected) ledger.mergeRejected.push({ task_id: r.task_id, reason: r.reason || '머지 게이트 거부' });
  if (cj.conflicted) { ledger.stoppedReason = '머지 충돌 — 자동해결 안 함, 사람 위임(/pact:resolve-conflict)'; return 'conflict'; }
  return 'ok';
}

// PACT 슬롯 admit — batch0 은 캐시 payload, graph task 는 run-cycle admit CLI(그 순간 base 에서 worktree 생성).
function makeAdmit(cachedPayloads) {
  return async (id, inFlightIds) => {
    if (cachedPayloads.has(id)) return { ok: true, task: cachedPayloads.get(id) };
    if (!USE_PACT) return { ok: false, reason: 'payload 없음(demo)' }; // demo 는 graph task 없음 — 방어
    const flags = inFlightIds && inFlightIds.length ? ` --in-flight=${inFlightIds.join(',')}` : '';
    let out;
    // STAB-1: admit 도 드라이버 owner-pid 를 유지해 사이클 소유권이 끊기지 않게 한다.
    try { out = execSync(`node "${PACT_BIN}" run-cycle admit ${id}${flags} --owner-pid=${process.pid} --session=drive`, { encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '').toString(); } // admit hard-fail 은 exit≠0 이나 stdout 에 JSON 존재
    let j;
    try { j = JSON.parse(out); } catch { return { ok: false, reason: 'admit 응답 파싱 실패' }; }
    if (j.ok === false) {
      if (j.reason === 'path_overlap') return { ok: false, reason: 'path_overlap' }; // 재큐(in-flight 해소 후 재시도)
      return { ok: false, reason: (j.errors && j.errors[0] && j.errors[0].message) || j.reason || 'admit 실패' };
    }
    cachedPayloads.set(id, j.task_prompt); // 슬롯 내 resume 재사용
    return { ok: true, task: j.task_prompt };
  };
}

// PACT 단건 머지 — 워커 완료 즉시 그 task 만 게이트(planMerge) 경유. 충돌은 자동해결 X(정지 신호).
async function mergeOnePact(id) {
  let out;
  try { out = execSync(`node "${PACT_BIN}" run-cycle collect-one ${id} --commit-status`, { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '').toString(); }
  let j;
  try { j = JSON.parse(out); } catch { return { result: 'held', detail: { task_id: id, stage: 'parse-failure', reason: 'collect-one 응답 파싱 실패' } }; }
  if (j.conflicted) return { result: 'conflicted', detail: j.conflicted };
  if ((j.merged || []).includes(id)) return { result: 'merged', detail: { verification: j.verification_summary } };
  if ((j.already_merged || []).includes(id)) return { result: 'already_merged', detail: {} };
  const rej = (j.rejected || []).find((r) => r && r.task_id === id);
  if (rej) return { result: 'rejected', detail: rej };   // 실제 planMerge 게이트 거부(terminal)
  // M6: merged/already/rejected 어디에도 없음 = 게이트 이전 stage 실패(cycle-busy 락 경쟁·
  // merge-in-progress 의 dangling MERGE_HEAD). 완료된 task 를 거짓 rejected(terminal)로 만들지 말고
  // held(보류·재시도 대상 — worktree 보존)로 분류한다. 다음 사이클/충돌해결 후 재머지된다.
  return { result: 'held', detail: { task_id: id, stage: j.stage || j.reason || 'stage-failure' } };
}

// 한 라운드: batch0 ∪ graph 를 K-슬롯 풀로 드레인. 완료 즉시 단건 머지가 다른 워커 실행과 겹친다.
async function runCyclePipeline(c, tasks, graph) {
  const map = new Map();
  const cachedPayloads = new Map();
  for (const t of tasks) {                     // batch0 = ready-set (deps 이미 충족)
    cachedPayloads.set(t.task_id, t);
    map.set(t.task_id, { deps: [], allowed_paths: t.allowed_paths || [], size: sizeOfTask(t.task_id, t.allowed_paths) });
  }
  for (const [id, g] of Object.entries((graph && graph.tasks) || {})) { // batch0 밖 남은 DAG
    if (map.has(id)) continue;                 // batch0 우선
    map.set(id, { deps: g.deps || [], allowed_paths: g.allowed_paths || [], size: sizeOfTask(id, g.allowed_paths) });
  }
  return runPipeline({
    slots: MAX,
    tasks: map,
    admit: makeAdmit(cachedPayloads),
    runTask: (task) => (task.loop_until ? runLoopTask(task) : runResumableTask(task)),
    // demo: 머지 없음 → 워커 done 이 곧 done. 단 --merge-reject 시연 시엔 mock 머지 게이트를 꽂는다.
    mergeOne: USE_PACT ? mergeOnePact : (MERGE_REJECT.size ? mergeOneMock : null),
    overlaps: USE_PACT ? pathsOverlap : () => false,   // demo: 개별 tmpdir → 무충돌
    // IMP-5: rate-limit 반응형 다운시프트(파이프라인 전용 — 레거시 --no-pipeline 엔 미적용). 평시 무동작.
    downshift: { recoverAfter: RECOVER_AFTER, floor: 1 },
    onEvent: (evt) => {
      // dogfood #10: dispatch 무음이라 사용자가 수 분간 빈 화면을 봄 — 투입 1줄 + 관찰 힌트.
      if (evt.type === 'dispatch') {
        const n = (evt.in_flight || []).length;
        console.log(`  ▶ ${evt.id} 투입 (in-flight ${n}/${MAX})${dispatchHintShown ? '' : ' — 진행 관찰: pact status --watch (별도 터미널)'}`);
        dispatchHintShown = true;
      }
      // DX-2: settle 마다 라이브 진행 카운터 증가(→ 아래 write 에 항상 실려 status --watch 가 실시간 관측).
      // IMP-2: 워커가 status.json 을 못 남기고 죽었으면 드라이버 권위 데이터로 합성(자기보고는 안 덮음).
      if (evt.type === 'settle') { tallySettle(ledger.live, evt); if (USE_PACT) synthesizeRunStatus(evt.outcome); }
      // IMP-5: 유효 동시폭 조정 — 콘솔 1줄 + 유효폭 상태 갱신 + jsonl. (신호 감지·목표계산은 pool 이 순수하게 수행.)
      if (evt.type === 'downshift') {
        effectiveSlots = evt.to;
        const label = evt.direction === 'down'
          ? `⚠️ rate-cap 신호 — 동시폭 ${evt.from}→${evt.to} (다운시프트: 429/overloaded 재시도 낭비 방지)`
          : `↑ 안정화 — 동시폭 ${evt.from}→${evt.to} (복원, 상한 ${MAX})`;
        console.log(`  ${label}`);
        writeDriverState({ phase: 'spawning', cycle: c });
      }
      // IMP-1: dispatch/settle/downshift 을 driver-events.jsonl 로 영속(makespan 재구성 소스, 0토큰).
      if (evt.type === 'dispatch' || evt.type === 'settle' || evt.type === 'downshift') appendDriverEvent(driverEventLine(evt));
      if (evt.in_flight) { liveInFlight = evt.in_flight.length; writeDriverState({ phase: 'spawning', cycle: c, active_workers: evt.in_flight }); } // liveInFlight: DRV-3 예산 분할 분모
    },
    shouldStop: () => {
      if (ledger.spentUsd >= BUDGET) return `예산 초과 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`;
      // H4-2: 워커가 예산 소진(remaining < MIN_DISPATCH)으로 스폰 못 하면 신규 dispatch 정지 —
      // 잔여 ready 큐가 전부 bail→escalated 로 캐스케이드되는 걸 막고 skipped 로 남긴다.
      if (ledger.budgetExhausted) return `예산 예약 소진 — 신규 dispatch 정지(잔여 task 는 skipped, 다음 사이클 재평가)`;
      return null;
    },
  });
}

// DRV-1 2차 방어: task source 를 결정적으로 스캔해 done/failed 아닌 잔여 task id 를 반환.
// --graph emit 이 누락/회귀해도(재개 경로 등) 무인 자동화가 미완 task 를 두고 exit 0 성공 오보하는
// 것을 막는다. USE_PACT 에서만 의미(demo 는 레포 상태 없음). 토큰 0 · best-effort(파싱 실패 시 []).
function scanRemainingPending() {
  if (!USE_PACT) return [];
  try {
    const cwd = process.cwd();
    const files = discoverTaskFiles({ cwd });
    if (!files.length) return [];
    const parsed = parseTaskFiles(files, { cwd });
    return (parsed.tasks || [])
      .filter((t) => t.status !== 'done' && t.status !== 'failed')
      .map((t) => t.id);
  } catch { return []; }
}

// ---- 메인 루프 (오케스트레이터 = 이 코드 = 토큰 0) -------------------------
// import.meta.url 가드용으로 main() 에 감싼다 — 직접 실행(isMain)일 때만 아래에서 호출된다.
// 테스트가 이 모듈을 import 하면 main() 은 안 돌고 순수 워커 함수만 노출 → 부수효과·process.exit 없음.
async function main() {
console.log('=== pact 헤드리스 드라이버 (production, 하드닝) ===');
console.log(`mode: ${REAL ? 'REAL' : 'MOCK'} | ${USE_PACT ? 'PACT' : 'DEMO'} | max=${MAX} cycles=${CYCLES} budget=$${BUDGET}(cap) timeout=${TIMEOUT_MS / 1000}s(backstop) retries=${RETRIES}`);

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
    console.error('✗ SDK 미설치 — cd scripts/headless-driver && npm i @anthropic-ai/claude-agent-sdk (점검: node sdk-check.mjs)');
    process.exit(4);
  }
}

// STAB-1 belt: 워커 spawn 시작 전에 드라이브 소유권 락을 잡는다. 같은 레포에 또 다른
// 드라이버(또는 drive+drive)가 살아있으면 exit 4 로 정지 — 같은 worktree 이중 spawn 차단.
// driver-state.json 은 관측용이라 소유권 판정에 쓰지 않는다(전용 drive-owner.json).
// PACT 모드에서만(.pact 존재) 의미 있음 — demo 모드는 레포 상태가 없어 skip.
let driveLockHeld = false;
function releaseDrive() {
  if (!driveLockHeld) return;
  driveLockHeld = false;
  try { releaseDriveLock({ cwd: process.cwd() }); } catch { /* best-effort */ }
}
if (USE_PACT) {
  const dl = acquireDriveLock({ cwd: process.cwd(), session: 'drive' });
  if (!dl.ok) {
    console.error(`✗ ${dl.error} — 드라이버 이미 실행 중. 종료 대기 또는 pact status.`);
    process.exit(4);
  }
  driveLockHeld = true;
  // 정상/예외/exit 어느 경로든 해제. process.exit()·자연종료 모두 'exit' 발화(동기 unlink OK).
  process.on('exit', releaseDrive);
}

// 외부 종료(Ctrl-C/SIGTERM)에도 driver-state 를 finalize — "spawning 고착"(Bug2) 방지.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { writeDriverState({ phase: 'aborted', active_workers: [], stopped_reason: `signal ${sig}` }); } catch { /* noop */ }
    releaseDrive(); // belt 해제 후 종료
    process.exit(130);
  });
}

const tStart = Date.now();
let allOutcomes = [];

for (let c = 1; c <= CYCLES; c++) {
  // (4) 예산 회로차단기 — 사이클 시작 전 점검
  if (ledger.spentUsd >= BUDGET) { ledger.stoppedReason = `예산 초과 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`; break; }
  // H4-2: budgetExhausted 는 사이클 내 캐스케이드 정지용 — 새 사이클은 예약 해제·spent 확정 후라
  // 재평가한다. 진짜 소진은 위 spentUsd>=BUDGET 가이드가 잡는다.
  ledger.budgetExhausted = false;

  let tasks, readyToCollect, graph;
  try { ({ tasks, readyToCollect, graph } = getTasks()); }
  catch (e) { ledger.stoppedReason = `태스크 소스 실패: ${e.message}`; break; }
  // spawn 할 것도 없고 collect 할 것도 없으면 종료. (ready_to_collect 면 spawn 만 스킵하고 collect 진행)
  if (!tasks.length && !readyToCollect) { console.log(`\ncycle ${c}: 실행 가능 task 없음 — 종료`); break; }

  // ready_to_collect(resume): 모든 워커 이미 done → spawn 스킵, 배치 collect 로 머지(기존 경로 유지).
  if (!tasks.length && readyToCollect) {
    console.log(`\ncycle ${c}: spawn 스킵 (모든 워커 이미 done) → collect 로 진행`);
    writeDriverState({ phase: 'collecting', cycle: c, active_workers: [] });
    if (USE_PACT && collectBatch() === 'conflict') break;
    continue;
  }

  if (PIPELINE) {
    // ★ P2-2 · SPD-1/3: K-슬롯 워커 풀 — 슬롯이 비면 다음 ready+무겹침 task 를 즉시 pull.
    // 완료 즉시 단건 머지(게이트 경유)가 다른 워커 실행과 겹친다 → 배치 배리어 붕괴.
    // IMP-5: 다운시프트 컨트롤러는 사이클마다 fresh(=MAX 에서 시작) → 관측 변수도 사이클 경계에서 MAX 로 리셋.
    effectiveSlots = MAX;
    const graphN = Object.keys((graph && graph.tasks) || {}).length;
    console.log(`\ncycle ${c}: K-슬롯 풀 (슬롯=${MAX}, ready=${tasks.length}${graphN ? ` +graph=${graphN}` : ''}) — freed slot 이 다음 ready+무겹침 task pull (오케스트레이터 = 0 토큰)`);
    if (VERBOSE) for (const t of tasks) vlog(`  [spawn] ${t.task_id} → worktree ${t.working_dir}`);
    writeDriverState({ phase: 'spawning', cycle: c, active_workers: tasks.map((t) => t.task_id) });
    // IMP-1: 사이클 경계 마커 + 회전(새 cycle_id 면 이전 이벤트 폐기 → 무한 성장 방지).
    beginCycleEvents(readCycleId(), c);

    const pr = await runCyclePipeline(c, tasks, graph);
    // DRV-2: 워커 done(o.status) 과 단건 머지 결과(pr.merges)를 대조한다. 머지가 rejected/conflicted 면
    // base 에 미반영이므로 done 으로 계상하지 않고 'rejected' 로 재라벨(⛔) + 원장 기록(→ exit 3).
    const mergeById = new Map((pr.merges || []).map((m) => [m.id, m]));
    for (const o of pr.outcomes) {
      const mg = mergeById.get(o.task_id);
      if (o.status === 'done' && mg && (mg.result === 'rejected' || mg.result === 'conflicted')) {
        o.status = 'rejected';
        o.reason = o.reason || (mg.detail && (mg.detail.reason || mg.detail.error)) || `머지 ${mg.result}`;
        ledger.mergeRejected.push({ task_id: o.task_id, reason: o.reason });
      } else if (o.status === 'done' && mg && mg.result === 'held') {
        // M6: transient stage 실패(cycle-busy·merge-in-progress) — 거짓 rejected 아님. 워커 산출은
        // 보존되고 재시도 대상. done 오보(미머지)도 아니게 held 로 재라벨 + 원장(비성공, 비-rejected).
        o.status = 'held';
        o.reason = o.reason || (mg.detail && mg.detail.stage) || 'merge 보류(stage 실패)';
        ledger.held.push({ task_id: o.task_id, reason: o.reason });
      }
      allOutcomes.push(o);
      if (o.status === 'escalated') ledger.escalations.push(o);
      reportOutcome(o);
    }
    if (VERBOSE) for (const m of pr.merges) vlog(`  [merge] ${m.id}: ${m.result}`);
    if (pr.skipped.length) {
      for (const s of pr.skipped) ledger.skipped.push(s); // 미투입 = 미완 → exit 성공 오보 방지
      console.log(`  ⏭  미투입(skipped) ${pr.skipped.length}: ${pr.skipped.join(', ')}  (dep reject / budget / 정지)`);
    }

    // 머지 충돌 = 판단 에러 → 자동해결 X, 정지+위임. (그 외 정지사유=예산 등도 루프 중단)
    if (pr.conflicted) { ledger.stoppedReason = pr.stoppedReason || '머지 충돌 — 자동해결 안 함, 사람 위임(/pact:resolve-conflict)'; break; }
    if (pr.stoppedReason) {
      // H4-2/R3: 예약 소진(budgetExhausted)으로 인한 this-cycle 정지는 run 종료가 아니다 — in-flight
      // 는 이미 drain 됐고, 잔여 실예산이 있고 사이클이 남았으면 다음 사이클이 예약 해제·spent 확정
      // 후 skipped task 를 재평가한다(상단에서 budgetExhausted 리셋). 진짜 예산 초과만 run 종료.
      if (ledger.budgetExhausted && ledger.spentUsd < BUDGET && c < CYCLES) {
        console.log(`  ⏸  이번 사이클 예약 소진 → 다음 사이클 재평가 (spent $${ledger.spentUsd.toFixed(2)}/$${BUDGET}, skipped ${pr.skipped.length})`);
        continue;
      }
      ledger.stoppedReason = pr.stoppedReason; break;
    }
    if (ledger.spentUsd >= BUDGET) { ledger.stoppedReason = `예산 초과 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`; break; }
    continue;
  }

  // ─── 레거시 배치-배리어(--no-pipeline): 배치 전원 종료 대기 → 직렬 collect ───
  writeDriverState({ phase: 'spawning', cycle: c, active_workers: tasks.map((t) => t.task_id) });
  console.log(`\ncycle ${c}: 워커 ${tasks.length}개 동시 spawn... (레거시 배리어, 오케스트레이터 await = 0 토큰)`);
  if (VERBOSE) for (const t of tasks) vlog(`  [spawn] ${t.task_id} → worktree ${t.working_dir}`);

  // (1) ★ allSettled — 한 워커가 터져도 나머지 결과는 보존됨
  liveInFlight = tasks.length; // DRV-3: 레거시 배리어는 배치 전원 동시 실행 → 예산 분할 분모=배치폭
  const settled = await Promise.allSettled(tasks.map((t) => t.loop_until ? runLoopTask(t) : runResumableTask(t)));
  const outcomes = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { task_id: tasks[i].task_id, status: 'escalated', reason: 'driver 예외: ' + s.reason });
  for (const o of outcomes) {
    allOutcomes.push(o);
    if (o.status === 'escalated') ledger.escalations.push(o);
    tallySettle(ledger.live, { type: 'settle', outcome: o }); // DX-2: 레거시도 라이브 카운터 갱신
    if (USE_PACT) synthesizeRunStatus(o);                     // IMP-2: 워커 미보고 시 권위 데이터 합성(자기보고 보존)
    reportOutcome(o);
  }

  // (4) 예산 점검 — 사이클 후 누적
  if (ledger.spentUsd >= BUDGET) { ledger.stoppedReason = `예산 초과 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`; break; }

  // 머지 충돌 = 판단 에러 → 자동해결 X, 정지+위임
  if (USE_PACT && collectBatch() === 'conflict') break;
}

// ---- 최종 보고 + 불변식 ----------------------------------------------------
// DRV-2(정규화 패스): 머지 거부된 task 는 워커가 done 이어도 done 이 아니다. 파이프라인은 이미
// 인라인 재라벨했고, 레거시(collectBatch)는 워커 완료 시점엔 머지 결과를 몰라 여기서 정규화한다.
{
  const rejectedIds = new Set(ledger.mergeRejected.map((r) => r.task_id));
  for (const o of allOutcomes) {
    if (o.status === 'done' && rejectedIds.has(o.task_id)) {
      o.status = 'rejected';
      const rr = ledger.mergeRejected.find((r) => r.task_id === o.task_id);
      if (rr && !o.reason) o.reason = rr.reason;
    }
  }
}

// DRV-1 2차 방어: 최종보고 직전 task source 를 스캔해 잔여 미완 task 를 잡는다. done/failed 아닌
// pending 이 남았으면 경고 1줄. 다른 정지/위임/거부/미투입 신호가 전혀 없는데 잔여가 있으면 그 자체가
// 성공 오보(예: --graph 누락으로 하위 DAG 미투입) → stoppedReason 설정(→ exit 3). 토큰 0.
if (USE_PACT) {
  const leftover = scanRemainingPending();
  if (leftover.length) {
    const shown = leftover.slice(0, 8).join(', ') + (leftover.length > 8 ? ' …' : '');
    console.log(`\n⚠️ 잔여 미완 task ${leftover.length}건: ${shown} (이 실행에서 완료되지 않음)`);
    if (!ledger.stoppedReason && ledger.escalations.length === 0
        && ledger.mergeRejected.length === 0 && ledger.held.length === 0 && ledger.skipped.length === 0) {
      ledger.stoppedReason = `잔여 미완 task ${leftover.length}건 — 완료로 오보 방지(재개: pact drive / /pact:parallel)`;
    }
  }
}

const wall = (Date.now() - tStart) / 1000;
const tally = allOutcomes.reduce((m, o) => ((m[o.status] = (m[o.status] || 0) + 1), m), {});
const workerTok = allOutcomes.reduce((a, o) => a + tokOf(o.usage), 0);

console.log('\n=== 결과 ===');
console.log(`완료 ✓${tally.done || 0}  미머지 ⛔${tally.rejected || 0}  거부 ⛔${tally.denied || 0}  위임 🚨${tally.escalated || 0}  (${allOutcomes.length}건)`);
console.log(`워커 토큰 합: ${(workerTok / 1e6).toFixed(2)}M   비용: $${ledger.spentUsd.toFixed(2)} / 예산 $${BUDGET}   wall=${wall.toFixed(1)}s`);
console.log(`오케스트레이터 토큰: ${ledger.orchestratorTokens}   ← 에러 처리해도 여전히 0`);
if (ledger.stoppedReason) console.log(`⏸  정지: ${ledger.stoppedReason}`);

if (ledger.escalations.length) {
  console.log('\n🚨 사람 위임 필요 (헤드리스→인터랙티브 핸드오프):');
  for (const e of ledger.escalations) {
    // DX-3: salvageable(worktree 에 부분작업 보존)이면 목적특화 /pact:takeover 인계를 1차로 병기한다.
    // 예산/정체/회로차단으로 이미 실패한 task 를 fresh 재spawn(/pact:resume)만 하면 같은 실패 반복 위험 —
    // takeover 는 보존된 worktree 를 사람이 이어받는 on-ramp. 강제 이분이 아니라 선택을 남긴다(철학⑤).
    const hint = e.salvageable
      ? `/pact:takeover ${e.task_id} 로 보존된 worktree 직접 인계(재시도로 안 풀리는 판단·커플링), 또는 /pact:resume ${e.task_id} 로 fresh 재spawn`
      : `/pact:resume ${e.task_id} 로 재시도`;
    const salv = e.salvageable ? ' (부분작업 worktree 보존)' : '';
    console.log(`   - ${e.task_id}: ${e.reason || '2회 실패'}${salv} → ${hint}`);
  }
}

// DRV-2: 머지 거부 task 는 escalation 이 아니라 '게이트 통과 실패로 base 미반영' 이다. 워커 done 이
// merge done 과 다르다는 사실을 명시 노출한다(비-verbose 에서도). 산출 점검 후 재시도/수정 안내.
if (ledger.mergeRejected.length) {
  console.log('\n⛔ 머지 거부 (게이트 통과 실패 — base 미반영, 워커 done ≠ 머지 done):');
  for (const r of ledger.mergeRejected) {
    console.log(`   - ${r.task_id}: ${r.reason || '머지 게이트 거부'} → 산출 점검 후 /pact:resume ${r.task_id} 또는 인터랙티브 수정`);
  }
}

writeDriverState({ phase: 'done', active_workers: [], stopped_reason: ledger.stoppedReason, done: tally.done || 0, escalated: tally.escalated || 0, rejected: tally.rejected || 0 });

if (ledger.orchestratorTokens !== 0) { console.error('\n✗ INVARIANT 실패'); process.exit(1); }
console.log('\n✓ 불변식 유지: 오케스트레이션 = 0 토큰. 기계적 에러는 드라이버가 흡수, 판단 에러는 위임.');
if (!REAL) console.log('[MOCK] 실제 spawn: cd scripts/headless-driver && npm i @anthropic-ai/claude-agent-sdk && node driver.mjs --real');

// 위임/미머지/미투입/정지 중 하나라도 있으면 비정상 종료코드(자동화 파이프라인이 성공 오보 안 하도록).
// DRV-2: mergeRejected(base 미반영) + skipped(미투입) 를 exit 판정에 포함 — 워커 done ≠ 사이클 완료.
const incomplete = ledger.escalations.length || ledger.mergeRejected.length || ledger.held.length || ledger.skipped.length || ledger.stoppedReason;
process.exit(incomplete ? 3 : 0);
}

// 직접 실행일 때만 메인 루프 구동. import(테스트) 시엔 실행 안 됨 = 부수효과·process.exit 없음.
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

// 테스트 계약용 export — 프로덕션 실행 경로(main)는 이 export 에 의존하지 않는다.
export { runWorkerReal, attemptTask, runResumableTask, runLoopTask, ledger, tallySettle, synthesizeRunStatus, metricStatusOf, appendDriverEvent, beginCycleEvents, driverEventLine, readCycleId };
