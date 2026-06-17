# Proposal: loop-until-dry — `pact drive` 자동 진행 재투입

- Status: **설계 승인됨 (구현 대기)**
- Date: 2026-06-17
- Scope: `experiments/headless-driver/driver.mjs` (헤드리스 드라이버 전용), `schemas/task.schema.json`, `bin/cmds/run-cycle.js`(prepare 필드 전달)
- 관련: [[headless-driver-initiative]], `docs/proposals/continue-on-conflict.md`, ADR-012(워커 자기보고 불신)

---

## 1. 배경 / 문제

대량 기계적 정리 task(lint/디자인 토큰 마이그레이션)에서 워커가 **작업 도중 예산/턴 소진**으로 절반만 하고 멈추는 "질식"이 반복된다(실측 CLEANUP-009, CLEANUP-026, CLEANUP-029).

- 진짜 제약은 **컨텍스트 윈도우가 아니라 턴/예산**이다. CLEANUP-026은 130k 토큰·64 tool call에서 멈췄는데, 윈도우 한참 전이다. 한 워커가 60턴 안에 110개 수정을 못 한다 — 윈도우가 아무리 커도 동일.
- 현재 `driver.mjs:218`은 `incomplete`(예산/턴 소진)를 만나면 **즉시 escalate**(사람 위임)한다. 주석 근거: "재시도해도 또 소진 + 부분작업 손실 위험."
- 그러나 최근 `f5b2350`(워커 중간 커밋 강제)로 그 전제가 깨졌다: 부분작업이 worktree에 **커밋되어 보존**되므로, fresh 워커가 이어받으면 **새로운 진행**을 만든다.

## 2. 목표 / 비목표

**목표**: 측정 가능한 진행 신호를 가진 task에 대해, 진행이 있는 동안 **fresh 워커를 자동 재투입**하여 한 워커가 질식하지 않고 done_criteria에 도달하게 한다. (resume의 반응적·수동 회복을 → 능동적 청크 루프로.)

**비목표 (명시)**:
- `/pact:parallel`(인터랙티브 메인 LLM 오케스트레이터)은 **건드리지 않는다**. loop는 드라이버(결정적 스크립트)에만 산다 — 메인 LLM이 루프를 돌면 턴마다 컨텍스트가 부풀어 토큰 세금이 폭발하기 때문.
- **머지 게이트·verify를 우회하지 않는다.** loop는 done_criteria 도달까지만; 최종 검증·머지는 collect의 기존 게이트 그대로.
- 측정 신호가 없는 일반 feature task에는 적용하지 않는다(기존 `attemptTask` 경로 유지).
- 머지 충돌 자동해결, cross-review 차단 등 영구 out-of-scope 항목은 그대로.

## 3. 전제 (이미 구현된 토대)

- `f5b2350` — 워커 maxTurns cap 제거 + **중간 커밋 강제**: 부분작업이 worktree에 보존됨.
- worker-guard Bash 가드(`scripts/lib/worker-guard.js` `extractWriteTargets`) — Bash `>`·`tee`·`touch`로 allowed_paths 밖(워크트리 내) 쓰기 차단. 각 iteration commit이 **in-scope 보장** → CLEANUP-029식 통째 reject 위험 제거.
- context-bundle 자동 슬라이스(`scripts/context-bundle.js`) — anchor 없으면 `task_id` 섹션만 → 워커 시작 컨텍스트 슬림(질식 임계 상승).

## 4. 설계 (접근 1: 전용 loop 경로)

### 4.1 데이터 모델 — `loop_until` 필드 (opt-in)

`schemas/task.schema.json`에 선택 필드 추가. task가 이 필드를 선언하는 것 자체가 "이 task는 loop 대상"이라는 opt-in 스위치다.

```yaml
loop_until:
  count: "eslint --max-warnings=0 src/Foo.tsx 2>&1 | grep -c ': warning' || true"  # stdout 마지막 정수 = 남은 개수
  max_iterations: 6   # 선택, 기본 6
```

**계약**: `count` 명령의 **stdout 마지막 정수 = 남은 개수**. 0이면 done. 명령의 exit code는 무시한다(eslint류는 경고가 있으면 비0이라 done 판정에 못 씀).

`pact run-cycle prepare`가 makeTaskPrompt 단일 소스에서 `loop_until`을 `task_prompts[i]`에 그대로 실어 드라이버로 전달한다(드라이버는 자체 reconstruct 안 함 = drift 차단, 기존 원칙).

### 4.2 컴포넌트 — `driver.mjs`에 2개 추가 + dispatch 분기

**`measureCount(task)`** — `task.working_dir`에서 `loop_until.count`를 execSync로 실행, stdout에서 정수 파싱하여 반환. 비정수/실행 에러면 `null`(측정 불가).

**`runLoopTask(task)`** — 루프의 심장:

```
prev = measureCount(task)
if (prev === null) return escalate('측정 불가')          // 처음부터 못 재면 위임
if (prev === 0)    return done(iterations: 0)            // 이미 충족 → spawn 안 함
iter = 0
const MAX = task.loop_until.max_iterations || 6
while (true) {
  if (ledger.spentUsd >= BUDGET) return escalate('budget', salvageable)
  r = await runWorker(task, ++iter)        // fresh 워커. 부분작업 커밋(f5b2350). 실패해도 계속(아래 카운트로 판정)
  ledger.spentUsd += (r.cost || 0)
  cur = measureCount(task)                  // ★ 워커 자기보고 말고 결정적 재측정 (ADR-012)
  if (cur === null)   return escalate('측정 불가', salvageable)
  if (cur === 0)      return done(iter)
  if (cur >= prev)    return escalate('정체(no-progress)', salvageable)   // 엄격 감소 가드
  if (iter >= MAX)    return escalate('max_iterations', salvageable)
  prev = cur
}
```

- 워커가 에러로 끝나도(`r.ok=false`) **카운트가 줄었으면 진행으로 인정** — 판정의 진실은 워커 말이 아니라 `measureCount`다.
- 따라서 transient-retry는 별도로 필요 없다(진행 체크가 흡수). loop 경로는 `attemptTask`의 재시도 로직을 쓰지 않는다.

**dispatch** — 기존 main 루프의 `tasks.map(attemptTask)`를:
```
tasks.map(t => t.loop_until ? runLoopTask(t) : attemptTask(t))
```
loop_until 없는 task는 **기존 경로 무손상**. `driver.mjs:218`(incomplete→escalate)도 일반 task용으로 유지.

### 4.3 데이터 흐름

```
loop_until task
  → prepare가 loop_until 필드 전달
  → runLoopTask: measureCount=prev → [워커(부분커밋) → measureCount=cur] 반복
     · cur=0     → done → collect의 merge gate(기존) → 최종 verify·머지   [변경 없음]
     · 정체/cap/budget/측정불가 → escalate(worktree 보존) → /pact:resume   [기존 경로]
```

## 5. 안전 · 원칙

- **무한루프 3중 차단**: ① 엄격 감소(`cur < prev` 아니면 즉시 위임) = 수학적 종료 보장. ② `max_iterations` cap. ③ 전역 `budget` cap. ①이 본질, ②③은 백스톱.
- **워커 자기보고 불신 (ADR-012 정렬)**: done/progress는 워커 보고가 아니라 `measureCount`(결정적)로만 판정.
- **부분작업 안전 누적**: 각 iteration 커밋(f5b2350) + Bash 가드로 in-scope 보장 → 누적해도 후속 통째 reject 없음.
- **propose-only 보존**: 최종 머지는 collect 게이트(+인터랙티브면 사람) 그대로. loop는 done_criteria 도달까지만, 검증 우회 0.
- **자동루프금지 화해 → ADR 명문화 (이 작업에 포함)**: pact "2회 실패 시 위임(자동 루프 금지)" 원칙은 *실패 시 무한 재시도* 금지를 뜻한다. loop-until-dry는 *결정적으로 측정된 단조 진행 중에만* 재투입하고 정체 즉시 위임하므로 정신은 보존한다. 단 새 결정이므로 ADR로 기록한다.
  > **ADR-057 loop-until-dry**: 측정 가능한 진행 신호(`loop_until.count`)가 **엄격히 감소하는 동안에만** fresh 워커를 자동 재투입한다. 정체(`cur ≥ prev`)·`max_iterations`·budget·측정 불가 시 즉시 사람에게 위임한다. "자동 루프 금지"는 *실패 재시도* 에 대한 것이며, 측정된 단조 진행은 그 예외다.

## 6. 결정 사항

- `max_iterations` 기본값 = **6** (iteration당 fresh 워커 ~$0.2 → ~$1.2/task; 전역 budget이 추가 상한).
- ADR-057(자동루프금지 화해)를 본 작업에 **포함**(원칙: "기록 없이 반복 X").

## 7. 테스트 (TDD)

- mock 확장 플래그 `--loop=ID:N`(시작 카운트 N), 워커가 iteration마다 카운트 감소 주입.
- 시나리오: ⓐ 감소→0 done(iter 보고) ⓑ 정체 → escalate(no-progress) ⓒ max_iterations → escalate ⓓ budget 소진 → escalate ⓔ 측정 불가 → escalate ⓕ loop_until 없는 task = `attemptTask` 회귀 없음.
- `measureCount` 단위: 정수 파싱(마지막 정수)·0 처리·비정수/에러 → null.
- RED(시나리오 작성) → GREEN.

## 8. 변경 파일 (예상)

- `schemas/task.schema.json` — `loop_until` 선택 필드.
- `bin/cmds/run-cycle.js` (또는 makeTaskPrompt 소스) — prepare가 `loop_until`을 task_prompts에 전달.
- `experiments/headless-driver/driver.mjs` — `measureCount`, `runLoopTask`, dispatch 분기, mock `--loop` 플래그.
- `DECISIONS.md` — ADR-0xx.
- `test/` — driver loop 시나리오 + measureCount 단위 테스트.
- `agents/worker.md`(선택) — loop task 워커에 "예산 내 가능한 만큼 + 자주 커밋" 한 줄(이미 중간 커밋 강제라 필수 아님).

## 9. 미해결 / 후속

- `count` 명령의 stdout 정수 추출 규칙(여러 정수면 마지막 토큰) — 단순·명시적으로 고정.
- 인터랙티브 `/pact:parallel`에서 loop task를 만나면? → v1에서는 **드라이버 전용**, 인터랙티브는 기존 escalate. (하이브리드는 후속.)
- `/pact:takeover`(escalation 인계)와의 연동은 별개 후속.
