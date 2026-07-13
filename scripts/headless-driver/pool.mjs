'use strict';

// ============================================================================
// pact 헤드리스 드라이버 — K-슬롯 워커 풀 스케줄러 (P2-2 · SPD-1 + SPD-3).
// ----------------------------------------------------------------------------
// 사이클-배리어(Promise.allSettled 로 배치 전원 종료 대기)를 K-슬롯 파이프라인으로 교체한다.
//   - 슬롯이 비면 ready 큐에서 (a)deps 전부 done (b)in-flight 와 pathsOverlap=false 인
//     다음 task 를 pull → admit(worktree/payload 확보) → 워커 투입.
//   - 워커 완료 즉시 그 task 1개만 단건 머지(게이트 경유) → 다른 워커와 겹침.
//   - cycle time Σmax(batch) → ≈ total_work/K 로 수렴.
//
// 순수 스케줄러 — 부수효과(admit/runTask/mergeOne/overlaps)는 전부 주입받는다.
// 그래서 mock 으로 단위 테스트가 가능하고, 드라이버는 실제 구현을 꽂아 쓴다.
// (충돌 자동해결 절대 없음: mergeOne 이 conflicted 를 반환하면 dispatch 중단 + 정지.)
//
// runPipeline(cfg) → { outcomes, merges, stoppedReason, conflicted, skipped }
//
// cfg:
//   slots        K (동시 워커 수)
//   tasks        Map<id, { deps:string[], allowed_paths:string[], size:number }>
//                 — 이번 라운드 전체 task 집합(batch0 ∪ graph). batch0 은 deps:[] 로 넣는다.
//   admit        async (id, inFlightIds[]) => { ok:true, task } | { ok:false, reason }
//                 — worktree/payload 확보. batch0 은 캐시 반환, graph 는 run-cycle admit CLI.
//                   ok:false reason='path_overlap' 이면 재큐(다른 in-flight 해소 후 재시도).
//   runTask      async (task) => outcome   ({ task_id, status:'done'|'escalated'|'denied', ... })
//   mergeOne     async (id, outcome) => { result:'merged'|'already_merged'|'rejected'|'conflicted', detail }
//                 | null (데모: 머지 없음 → 워커 done 이 곧 done)
//   overlaps     (pathsA, pathsB) => boolean   (batch-builder pathsOverlap; 데모 → ()=>false)
//   fileCountOf  (id) => number   LPT 정렬용(없으면 tasks[id].size 사용)
//   onEvent      (evt) => void    dispatch/settle 관측(로그·driver-state). best-effort.
//   shouldStop   () => reason|null  예산 등 정지 신호(있으면 신규 dispatch 중단, in-flight 는 drain)
// ============================================================================

// ============================================================================
// IMP-5 최소형 — rate-limit 신호 기반 반응형 동시폭 다운시프트 (파이프라인 전용).
// ----------------------------------------------------------------------------
// 선제적/데이터 기반 K 자동 튜닝(측정 축적 전 추측)이 아니라, 워커의 rate-limit '실패 신호'에
// 반응해 유효 동시폭을 일시적으로 낮추는 반응형 가드다. 평시(신호 없음)엔 무동작(target=slots).
// 총비용은 K 와 무관(같은 task 수) — 이 가드의 가치는 오직 구독 soft ceiling 에서 다수 워커가
// 429/overloaded 로 실패→재시도 재실행하는 낭비를 줄이는 것.
// ============================================================================

// rate-limit 계열 신호 판별 (순수). 워커 결과의 subtype/reason/error/message 문자열에서
//   429(too many requests)·529·rate_limit·overloaded 를 잡는다. 명시 boolean(rate_limited)도 존중.
// classifyRealResult 는 reason=subtype 을 실어 보내고, 예외 경로는 reason='error:<message>' 라
//   두 형태 모두 여기서 커버된다. 일반 오류(error_max_turns·timeout·TypeError 등)엔 false(오탐 방지).
const RATE_LIMIT_RE = /\b429\b|\b529\b|rate[\s_-]?limit|overloaded|too many requests/i;
export function isRateLimited(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.rate_limited === true) return true; // 드라이버가 이미 분류해 실어준 명시 신호 우선
  for (const f of [result.subtype, result.reason, result.error, result.message]) {
    if (typeof f === 'string' && RATE_LIMIT_RE.test(f)) return true;
  }
  return false;
}

// rate-limit 반응형 다운시프트 컨트롤러 (순수 상태기계 — 시계·부수효과 없음, 회복은 카운트 기반).
//   observe(outcome) 를 settle 마다 호출:
//     · rate-limit 신호 → target 1 감소(하한 floor), clean streak 리셋(급복원 진동 방지).
//     · 그 외(클린) settle → clean streak +1, 연속 recoverAfter 회면 target 1 복원(상한 max).
//   상향 자동 조정 없음 — 오직 다운시프트분의 복원만. --max 는 여전히 하드 캡(max).
export function createDownshiftController({ max, floor = 1, recoverAfter = 3 } = {}) {
  const hardMax = Math.max(1, Math.floor(max) || 1);
  const lo = Math.max(1, Math.min(Math.floor(floor) || 1, hardMax));
  const need = Math.max(1, Math.floor(recoverAfter) || 1);
  let target = hardMax;
  let cleanStreak = 0;
  return {
    get target() { return target; },
    observe(outcome) {
      const prev = target;
      if (isRateLimited(outcome)) {
        cleanStreak = 0;                              // 신호 발생 → 회복 카운터 리셋(진동 방지)
        if (target > lo) target -= 1;
        return { changed: target !== prev, from: prev, to: target, direction: 'down', signal: 'rate_limit' };
      }
      cleanStreak += 1;
      if (target < hardMax && cleanStreak >= need) {
        target += 1;
        cleanStreak = 0;
        return { changed: true, from: prev, to: target, direction: 'up', signal: 'recover' };
      }
      return { changed: false, from: prev, to: target, direction: null };
    },
  };
}

export async function runPipeline(cfg) {
  const {
    slots,
    tasks,
    admit,
    runTask,
    mergeOne = null,
    overlaps = () => false,
    fileCountOf = null,
    onEvent = () => {},
    shouldStop = () => null,
    downshift = null, // IMP-5: { floor?, recoverAfter? } 면 rate-limit 반응형 다운시프트 활성(null=비활성, 기존 동작 불변)
  } = cfg;

  // 다운시프트 컨트롤러(옵션). 없으면 유효 슬롯 목표는 항상 고정 slots(= --max) — 완전 하위호환.
  const controller = downshift ? createDownshiftController({ max: slots, ...downshift }) : null;
  const currentSlots = () => (controller ? controller.target : slots);
  // settle 결과를 컨트롤러에 먹여 목표를 조정하고, 변화가 있으면 downshift 이벤트 발화(관측·jsonl).
  const observeSettle = (id, outcome) => {
    if (!controller) return;
    const info = controller.observe(outcome);
    if (info.changed) {
      onEvent({ type: 'downshift', id, ts: Date.now(), from: info.from, to: info.to, direction: info.direction, signal: info.signal });
    }
  };

  const allRunIds = new Set(tasks.keys());
  const notStarted = new Set(tasks.keys());
  const done = new Set();          // 머지 성공(또는 데모 done) — deps 충족 신호
  const inFlight = new Map();      // id -> { allowed_paths }
  const running = new Map();       // id -> Promise<{ id, ... }>

  const outcomes = [];
  const merges = [];
  let stoppedReason = null;
  let conflicted = null;

  const sizeOf = (id) => {
    if (fileCountOf) { const n = fileCountOf(id); if (Number.isFinite(n)) return n; }
    const t = tasks.get(id);
    return (t && Number.isFinite(t.size)) ? t.size : 0;
  };
  const pathsOf = (id) => (tasks.get(id) && tasks.get(id).allowed_paths) || [];

  // dep 하나가 아직 안 끝났나: 이번 라운드 소속(allRunIds)인데 done 에 없으면 blocking.
  // 라운드 밖 dep = 이미 done(외부/이전 사이클)로 간주(prepare 가 그렇게 ready 를 계산).
  const depsMet = (id) => {
    const deps = (tasks.get(id) && tasks.get(id).deps) || [];
    return deps.every((d) => done.has(d) || !allRunIds.has(d));
  };
  const overlapsInFlight = (id) => {
    const p = pathsOf(id);
    for (const [, v] of inFlight) {
      if (overlaps(p, v.allowed_paths)) return true;
    }
    return false;
  };

  // 다음 투입 대상: deps 충족 + in-flight 무겹침 중 LPT(가장 큰 task 우선)로 1개.
  const pickDispatchable = () => {
    let best = null;
    for (const id of notStarted) {
      if (!depsMet(id)) continue;
      if (overlapsInFlight(id)) continue;
      if (best === null) { best = id; continue; }
      const ds = sizeOf(id) - sizeOf(best);
      if (ds > 0 || (ds === 0 && id < best)) best = id; // size desc, tie=id asc (결정적)
    }
    return best;
  };

  const inFlightIds = () => [...inFlight.keys()];

  async function dispatch(id) {
    // (IMP-1) ts 를 payload 에 실어 driver 가 driver-events.jsonl 로 영속 → makespan 재구성 소스.
    onEvent({ type: 'dispatch', id, ts: Date.now(), in_flight: inFlightIds() });
    const admitRes = await admit(id, inFlightIds().filter((x) => x !== id));
    if (!admitRes || !admitRes.ok) {
      // path_overlap = 레이스(in-flight 가 pick 이후 변함) → 재큐. 그 외 = admit 실패(escalate).
      const requeue = admitRes && admitRes.reason === 'path_overlap';
      return { id, requeue, admitFailed: !requeue, reason: (admitRes && admitRes.reason) || 'admit failed' };
    }
    const outcome = await runTask(admitRes.task);
    let merge = null;
    if (mergeOne && outcome && outcome.status === 'done') {
      merge = await mergeOne(id, outcome);
    }
    return { id, outcome, merge };
  }

  while (true) {
    if (!stoppedReason) { const s = shouldStop(); if (s) stoppedReason = s; }

    // 슬롯 채우기 — 정지/충돌 아니면. 유효 슬롯 목표(currentSlots)는 다운시프트 시 slots 밑으로 줄 수 있다.
    // 목표가 in-flight 아래로 떨어지면 신규 dispatch 만 멈추고(진행 중 워커는 안 자름) drain 후 목표 존중.
    while (!stoppedReason && !conflicted && inFlight.size < currentSlots()) {
      const id = pickDispatchable();
      if (id === null) break;
      notStarted.delete(id);
      inFlight.set(id, { allowed_paths: pathsOf(id) });
      running.set(id, dispatch(id));
    }

    if (running.size === 0) break; // 더 돌릴 것도, 기다릴 것도 없음 → 종료

    const res = await Promise.race(running.values());
    running.delete(res.id);
    inFlight.delete(res.id);

    if (res.requeue) {
      // in-flight 해소를 기다렸다 재시도 — 다음 루프의 pickDispatchable 이 재검사.
      notStarted.add(res.id);
      onEvent({ type: 'requeue', id: res.id, ts: Date.now() });
      continue;
    }
    if (res.admitFailed) {
      const o = { task_id: res.id, status: 'escalated', reason: `admit 실패: ${res.reason}` };
      outcomes.push(o);
      onEvent({ type: 'settle', id: res.id, ts: Date.now(), outcome: o, in_flight: inFlightIds() });
      observeSettle(res.id, o); // IMP-5: admit 실패도 settle 로 카운트(비 rate-limit → 클린)
      continue;
    }

    outcomes.push(res.outcome);
    if (res.merge) {
      merges.push({ id: res.id, ...res.merge });
      if (res.merge.result === 'merged' || res.merge.result === 'already_merged') {
        done.add(res.id);
      } else if (res.merge.result === 'conflicted') {
        conflicted = res.merge.detail || { task_id: res.id };
        stoppedReason = stoppedReason || '머지 충돌 — 자동해결 안 함, 사람 위임(/pact:resolve-conflict)';
      }
      // rejected → done 아님 → 의존 task 는 계속 blocked(rejected 산출물 위에 못 쌓음).
    } else if (res.outcome && res.outcome.status === 'done') {
      done.add(res.id); // 데모(머지 없음): 워커 done 이 곧 done
    }
    onEvent({ type: 'settle', id: res.id, ts: Date.now(), outcome: res.outcome, merge: res.merge, in_flight: inFlightIds() });
    observeSettle(res.id, res.outcome); // IMP-5: rate-limit 신호면 다음 dispatch 목표를 낮춘다(회복은 연속 클린 후)
  }

  return { outcomes, merges, stoppedReason, conflicted, skipped: [...notStarted] };
}

export default { runPipeline, isRateLimited, createDownshiftController };
