---
description: 워커 N개 동시 spawn (worktree 격리) → 머지 → PROGRESS 갱신 (run-cycle CLI 기반)
---

`/pact:parallel` 실행됨. 메인은 결정적 작업을 `pact run-cycle`로 묶어 호출하고 LLM 영역(워커 spawn·coordinator·사용자 보고)에 집중. 모든 안내는 한국어.

## 단계 0: `pact drive` 넛지 (propose-only)

이번 실행이 **task 3개 이상 + 크기(duration)가 이질적**이면, 시작 전에 한국어로 **한 번** 안내(강제 X, 사용자 선택):

> 이 사이클은 task 다수·크기 편차가 커서 **헤드리스 `pact drive`(K-슬롯 파이프라인)** 가 더 빠를 수 있습니다. 인터랙티브 `/pact:parallel` 은 배치-배리어(느린 task 가 배치 전체를 잡음)라 오케스트레이터 재독 세금(~190M)을 물지만, `pact drive` 는 슬롯이 비는 즉시 다음 task 를 투입하고 오케스트레이션 토큰이 0 입니다.
> - 헤드리스로 돌리려면: 별도 터미널에서 `pact drive --pact` (테스트 후 `--real`).
> - 이대로 인터랙티브로 계속해도 됩니다.

사용자가 답하지 않거나 "계속"이면 그대로 아래 단계로 진행(자동 전환 X — 철학 5번). 조건 미충족(task 2개 이하 또는 크기 균일)이면 이 절 생략.

## 단계 1: Review 확인 게이트

한국어로 묻기: plan-task-review / plan-arch-review / plan-ui-review 중 어디까지 했는지. 답 [검토 없이] 시 PROGRESS.md에 `risk_acknowledged: true` + ts.

리뷰를 했다면 추가 확인: **권장 액션을 `tasks/*.md`에 반영했는지.** 리뷰는 propose-only(철학 5번) — prepare는 `tasks/*.md`만 읽으므로 미반영이면 리뷰 **전** 원본 task가 워커에 넘어감. 미반영이면: 작은 fix는 **메인이 사용자 승인 후 `tasks/<domain>.md` 해당 task를 직접 `Edit`**, 구조 변경은 `/pact:plan` 재분해 — 그 후 다시 호출하도록 한국어 안내.

## 단계 2: prepare 호출

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle prepare --owner-pid=$PPID --session=parallel
```

`--max=N`(1~5)로 이번 cycle만 batch 크기 줄이기 가능.

`--owner-pid=$PPID`(claim.js 관례와 동일한 세션 pid)는 STAB-1 멀티세션 게이트용 — prepare 가 이 사이클의 owner 로 stamp 한다. 같은 레포에서 `pact drive`(헤드리스)나 다른 인터랙티브 세션이 **살아있는** 소유자로 같은 사이클을 이미 잡고 있으면 재개 시 `cycle-busy` 로 거부돼 워커 이중 spawn 을 막는다(소유자 세션이 죽었으면 크래시 resume 으로 채택). collect 가 사이클을 소비하면 owner 도 함께 해제된다.

stdout JSON 분기:

- `ok: false` → `stage`별 한국어 안내 후 중단 (`stage`: `preflight` / `task-parse` / `tbd` / `batch` / `worktree` / `spawn-prepare` / `cycle-busy`). 각 errors[i].fix 그대로 사용자에게 표시. `cycle-busy` 는 다른 세션(pid)이 이 사이클을 소유 중이라는 뜻 — `error` 문구를 그대로 보여주고 종료(그 세션 종료 대기 또는 `pact status`).
- `ok: true, empty: true` → "실행 가능 task 없음. /pact:status 또는 /pact:plan." 종료.
- `ok: true` → 단계 2.5 이후로 진행 (spawn).

prepare가 반환한 키:
- `task_prompts: [{task_id, title, task_prompt, status_path, working_dir, ...}]`
- `context_warnings: [...]` — 있으면 한국어 경고 (중단 X)
- `size_warnings: [{task, risk, reason}]` — 턴소진 위험(oversized/unbounded) task (중단 X)
- `scope_warnings: [{task, violations}]` — done_criteria ⊄ allowed_paths 계약모순 (중단 X)
- `bundle_warnings: [{task_id, ref, lines}]` — anchor 없이 통째 번들된 대형 shard (중단 X)
- `ownership_warnings: [{task, risk, violations}]` — allowed_paths 가 MODULE_OWNERSHIP 오너 영역 밖 (중단 X)
- `coordinator_review_needed: false` — **deprecated** (pre-spawn 검토 제거, P1-3). 무시.

## 단계 2.5: 분담 모드 인식 (v0.6.2)

이 세션이 멀티세션 분담 모드인지 확인 — `pact claim`으로 잡아둔 task가 있나:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact list-locks --mine --alive --json
```

stdout `task_ids`:
- `[]` → **단일세션 모드.** `task_prompts` 전체를 그대로 사용.
- `[PACT-001, PACT-002, ...]` → **분담 모드.** `task_prompts`에서 그 ID들만 필터 (다른 세션이 잡은 건 그 세션이 처리).

분담 모드에서는 사용자에게 한국어 안내:
> 🪟 분담 모드: 이 세션이 잡은 N개만 sub-agent로 처리 (다른 세션이 나머지 처리 중).

## 단계 2.6: 슬로우니스·계약 경고 표면 (조건부, propose-only)

prepare 결과의 `size_warnings` / `scope_warnings` / `bundle_warnings` / `ownership_warnings` 중 **하나라도 비어있지 않으면**, fan-out **전에** 한국어로 요약 표시하고 진행 여부를 확인한다 (`context_warnings`와 동일 패턴 — 자동 수정 X, 철학 5번). 전부 빈 배열이면 이 단계 스킵.

> ⚠️ fan-out 전 사전경보 (분해·수정이 아직 무료인 지점):
> - 🔴 **턴소진 위험** (size_warnings): `<task>` — `<reason>`. 워커가 한 턴에 못 끝내 resume·salvage로 wall-time이 배로 늘 수 있음.
> - 🔴 **계약모순** (scope_warnings): `<task>` — done_criteria가 allowed_paths 밖 파일 생성을 요구 → merge 게이트가 통째 거부(작업 유실).
> - 🔴 **오너십 침범** (ownership_warnings): `<task>` — allowed_paths가 MODULE_OWNERSHIP 어느 모듈 오너 영역에도 속하지 않음(`<violations[].path>`). merge 게이트도 못 잡는 계약 경계 위반.
> - 🟡 **컨텍스트 bloat** (bundle_warnings): `<task_id>` — `<ref>`(`<lines>`줄)가 anchor 없이 K워커에 통째 복제.
>
> 어떻게 할까요?
> 1. **분해/수정 후 재시작** (권장): `/pact:plan` 재분해(oversized) 또는 사용자 승인 후 메인이 `tasks/<domain>.md`의 해당 task를 직접 `Edit`(계약모순=경로 추가/의무 제거, 오너십=allowed_paths를 오너 영역 안으로 or MODULE_OWNERSHIP 갱신, bloat=ref에 anchor 추가) → 다시 `/pact:parallel`.
> 2. **경고 무시하고 이대로 진행**: risk 감수하고 fan-out 계속.

사용자가 2를 택하면 그대로 spawn(단계 4)으로. 1을 택하면 정리 안내(worktree·payload는 이미 생성됨 → `pact run-cycle collect` 또는 수동 cleanup) 후 재분해로 유도.

> **참고 (P1-3)**: 워커 spawn 전 coordinator 검토 단계는 삭제됐다 — 그 검토 4항목(경로충돌·의존·TBD·스코프)은 이미 결정적 게이트(buildBatches/pathsOverlap·allDependenciesMet·parse·merge 게이트)가 커버하고, 유일하게 비중복이던 MODULE_OWNERSHIP 교차검토는 위 `ownership_warnings`로 결정적 승계됐다. 배치 크기 무관 바로 spawn 한다.

## 단계 4: 워커 N개 동시 spawn (Task tool ×N, **한 메시지**)

서브에이전트 nesting 불가 (ARCHITECTURE.md §14.2). 메인이 (단계 2.5에서 필터된) `task_prompts`의 각 항목으로 동시 호출:
- `subagent_type`: `worker`
- `description`: `<task_id>: <title>`
- `prompt`: `task_prompt` 그대로 (메인은 prompt.md/context.md를 read X)

순차 호출은 직렬화. **반드시 한 메시지에 N개 Task call**.

## 단계 5: 모든 워커 종료 후 collect 호출

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle collect
```

분담 모드에서는 다른 세션도 같은 batch를 처리 중일 수 있음. collect는 v0.6.1 멱등 + cycle.lock으로 한 곳에서만 실행되므로 누가 부르든 안전 (다른 세션 미완 task는 `failures`로 보고됨, 그 task는 잡고 있는 세션 종료 후 또 호출 가능).

stdout JSON:
- `merged: [...]`, `rejected: [...]`, `conflicted: null | {...}`, `skipped: [...]`
- `failures: [{task_id, status, blockers}]`
- `verification_summary: {lint, typecheck, test, build}`
- `decisions_to_record: [...]`

CLI는 자동으로 머지 → merge-result.json 작성 → 성공 worktree cleanup → current_batch 소비.

## 단계 5.5: 워커 실패 시 메인 fallback (ADR-053)

`merge-result.json`의 `rejected` 발생 시 메인은 다음 **4종 시나리오만** 처리한다 (추측·자동수정 X, 메인이 의도 검증 후 수동).

### 0. 워커 미완(턴소진)이면 — 직접 salvage 전에 fresh 서브에이전트 재투입 (워커-완료 2.2)

워커가 턴/budget 소진으로 **미완 종료**(status.json 없음 + worktree에 부분작업 존재, 또는 `clean_for_merge: false`)면 **메인이 직접 끝내지 말 것** — 그게 salvage(= 솔로작업 + ceremony), brewdy의 ~65% 시간을 먹은 그 패턴이다. 대신:

1. **같은 worktree(부분작업 보존)에 fresh worker 서브에이전트를 continuation 프롬프트로 재투입.** 연속 프롬프트는 인라인으로 직접 쓰지 말 것 — driver.mjs 와 동일한 코어(`scripts/worker-completion/resume.js`)를 그대로 출력하는 결정적 CLI 단일소스에서 가져온다 (drift 0, 회로차단기 영속):

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/pact resume-prompt <task_id> --consume
   ```

   stdout JSON `{task_id, continuationPrompt, resumes_remaining, escalate, incomplete_reason?}` 분기:
   - `escalate: true` → 재개 상한(`MAX_RESUME`=2) 도달(= `--consume` 이 카운트를 못 늘리고 거부됨). **재투입 X** → 아래 1~4 직접 처리 또는 사용자 위임. 분기는 **`escalate` 로만** 한다 — `resumes_remaining` 은 정보용이라 0 이어도 방금 소비한 `continuationPrompt`(예: RESUME 2)가 유효한 재투입일 수 있다(그때 `escalate: false`).
   - 아니면 `continuationPrompt` 문자열을 **그대로** worker 서브에이전트 prompt 로 사용 (`subagent_type: worker`, working_dir = 그 task 의 worktree). 메인이 프롬프트를 직접 작문하지 않는다 (단일소스).
2. 재투입 종료 후 `pact merge` 재시도.
3. **회로차단기(영속)**: 재개 카운트는 LLM 기억이 아니라 `.pact/runs/<id>/resume.json` 에 파일로 누적된다 — `--consume` 이 카운트를 증가시키고, `escalate: true`(소비가 거부됨) 이면 더는 재개 없이 아래 1~4 또는 사용자 위임. 이렇게 판정해야 헤드리스 드라이버와 **동일하게 2회 재투입**된다(과거엔 인터랙티브가 1회만 재투입되던 off-by-one 이 있었음). (조회만 하려면 `--consume` 없이 호출 — 카운트 불변.)

> 헤드리스 `pact drive`는 driver.mjs `runResumableTask`가 이걸 자동으로 한다(토큰 0). 인터랙티브 `/pact:parallel`은 메인이 위 절차로 동일 효과(재투입 2회 예산)를 낸다.

### 1. status.json 미작성 (`reason: "status.json missing"`)

- worktree (`.pact/worktrees/<id>`) 보존 — 워커 산출물이 있을 수 있음
- 메인이 worktree에서 `git status` + 변경 파일 확인 후 다음 중 하나:
  - 산출물 있음 → 메인이 직접 status.json 작성 (`verify_results`는 실측 가능한 것만 채우고 나머지 `skip`), `report.md`도 워커 의도 추정해서 작성 (Fallback #3 참고), `pact merge` 재시도
  - 산출물 없음 → 사용자에게 `/pact:resume <id>` 안내 후 종료

### 2. commit 미작성 + worktree 변경 존재 (`reason: "files_changed 보고 ≠ 실제 diff"` 등에서 빈 diff)

- worktree 안에서 메인이 직접 commit
- commit message: `pact: salvage <task_id> (worker incomplete)`
- 후 `pact merge` 재시도

### 3. report.md 미작성 / 너무 짧음 (`reason: "report.md missing"` / `"too short"`)

- 메인이 워커 산출물(diff + status.json + worker prompt)을 근거로 `report.md` 작성
- 본문에 **"워커 의도 추정 — 회고 단계 사용자 검증 필요"** 명시 (출처 거짓 방지)
- 최소 비공백 10줄 (Section: 무엇을 / 왜 / 마주친 문제 / 결정 / 메인이 알아야 할 것)
- 후 `pact merge` 재시도

### 4. decisions schema 위반 (`reason: "schema 위반"` 중 decisions 필드)

- 메인이 schema 정합 형태로 정규화 후 status.json 덮어쓰기
- 위반 원본은 `.pact/runs/<id>/decisions.raw.json`에 보존 (감사 추적)
- 후 `pact merge` 재시도

### 공통

- 위 4종 외 reason(`ownership 위반`, `verify fail`, `git diff에 allowed_paths 외 파일` 등)은 **메인이 임의로 우회 X** — 워커 spec drift나 실제 결함이라 사용자 결정 필요
- 회로 차단기: 같은 task 2회 fallback 실패 시 사용자 위임 (`/pact:abort <id>` 안내)

## 단계 6: 충돌·실패 안내 (조건부)

`conflicted` 있으면 한국어:
> ⚠️ 머지 충돌 — 성공: \<merged\>, 충돌: \<task_id\>(파일 \<files\>), 미시도: \<skipped\>. /pact:resolve-conflict 또는 git merge --abort.

`failures` 있으면 한국어로 task_id별 status·blockers 표시.

worktree는 머지 성공한 것만 정리 — 실패·blocked·충돌은 `.pact/worktrees/<id>` 보존 (재개·디버깅).

## 단계 7: PROGRESS/DECISIONS 갱신

`collect`가 이미 `.pact/merge-result.json`(사이클 deterministic SOT)에 merged·conflicted·rejected·failures·verification_summary·decisions_to_record를 다 계산해 뒀다. 갱신은 **그 파일 기준**으로 한다 — status.json 전량 재독·validate-status 재실행 X (collect가 이미 소화함, TOK-2).

- **작은 batch(task ≤ 2)**: 메인이 직접 `merge-result.json`(+collect stdout)만으로 PROGRESS.md 짧게 갱신 (Recently Done + Blocked만, ~5줄). coordinator 미소환.
- **큰 batch(task ≥ 3)**: Task tool로 **축소된** 통합 coordinator 소환 (컨텍스트 절약):
  - `subagent_type: coordinator`
  - prompt:
```
통합 모드 (축소).
merge-result.json 만 read. status.json 전량 재독·validate-status 재실행 금지.
방금 종료 워커: <task_ids>

PROGRESS.md 갱신: Recently Done(merged) · Blocked/Waiting(conflicted+failures+rejected, 사유 한 줄) · Verification Snapshot(verification_summary 그대로).
DECISIONS.md 에 decisions_to_record 누적 (사용자 승인 필요 건은 후보로 표시).
실패/블록 task 의 report.md 가 갱신에 필요하면 그 지목된 report.md 만 read (전량 X).
```

## 단계 8: 결과 보고 (한국어)

성공: `✅ Cycle 완료. 머지 <N>개. 검증 lint/tc/test/build 결과.`

부분: `⚠️ Cycle 부분 완료. 성공 <N>: ✓ ids. 실패 <M>: ✗ id 사유. 충돌 <C>: ✗ id → /pact:resolve-conflict. worktree 보존: .pact/worktrees/<id>.`

## 단계 9: 새 세션 권장 안내 (필수, 한국어)

성공·부분 무관 cycle 끝나면 **반드시** 다음 단락을 마지막에 출력 (생략 X):

> 💡 **다음 batch 는 새 세션에서 시작 권장** — 이 세션은 cycle 1회분 컨텍스트가 누적된 상태. 같은 세션에서 batch 를 계속 돌리면 매 턴 cache_read 가 누적분만큼 부풀어 토큰 비용이 사이클마다 배수로 증가함 (실측: 57시간 한 세션 = 209M 토큰, batch 단위 세션 분할 = 같은 작업 ~30M).
>
> 추천 흐름:
> 1. `/exit`
> 2. 같은 디렉토리에서 `claude` 재실행
> 3. `/pact:resume` — `.pact/state.json` + `batch.json` 자동 픽업, 다음 batch 부터 컨텍스트 0 에서 시작
>
> 충돌·blocked 처리만 남았으면 이 세션에서 마무리 후 /exit 해도 됨.

charge 부담 적은 짧은 follow-up (예: "lint 결과 보여줘", "방금 머지 한번 더 확인") 이면 이 세션 유지 OK. **새 batch 시작 (=`/pact:parallel` 재호출) 은 새 세션으로.**

## 의문 시

- 동시 `/pact:parallel` 두 번: G12에 따라 거부, /pact:status·/pact:abort 안내
- 워커 timeout: 대기 + 진행 보고
- prepare 후 fan-out 전(단계 2.6)에서 abort 결정: `pact run-cycle collect` 호출하면 결정적으로 정리 (status.json 없는 워커는 rejected로 처리됨)
