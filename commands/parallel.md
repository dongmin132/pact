---
description: 워커 N개 동시 spawn (worktree 격리) → 머지 → PROGRESS 갱신 (run-cycle CLI 기반)
---

`/pact:parallel` 실행됨. 메인은 결정적 작업을 `pact run-cycle`로 묶어 호출하고 LLM 영역(워커 spawn·coordinator·사용자 보고)에 집중. 모든 안내는 한국어.

## 단계 1: Review 확인 게이트

한국어로 묻기: plan-task-review / plan-arch-review / plan-ui-review 중 어디까지 했는지. 답 [검토 없이] 시 PROGRESS.md에 `risk_acknowledged: true` + ts.

리뷰를 했다면 추가 확인: **권장 액션을 `tasks/*.md`에 반영했는지.** 리뷰는 propose-only(철학 5번) — prepare는 `tasks/*.md`만 읽으므로 미반영이면 리뷰 **전** 원본 task가 워커에 넘어감. 미반영이면: 작은 fix는 **메인이 사용자 승인 후 `tasks/<domain>.md` 해당 task를 직접 `Edit`**, 구조 변경은 `/pact:plan` 재분해 — 그 후 다시 호출하도록 한국어 안내.

## 단계 2: prepare 호출

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle prepare
```

`--max=N`(1~5)로 이번 cycle만 batch 크기 줄이기 가능.

stdout JSON 분기:

- `ok: false` → `stage`별 한국어 안내 후 중단 (`stage`: `preflight` / `task-parse` / `tbd` / `batch` / `worktree` / `spawn-prepare`). 각 errors[i].fix 그대로 사용자에게 표시.
- `ok: true, empty: true` → "실행 가능 task 없음. /pact:status 또는 /pact:plan." 종료.
- `ok: true` → 단계 3.

prepare가 반환한 키:
- `task_prompts: [{task_id, title, task_prompt, status_path, working_dir, ...}]`
- `coordinator_review_needed: bool`
- `context_warnings: [...]` — 있으면 한국어 경고 (중단 X)
- `size_warnings: [{task, risk, reason}]` — 턴소진 위험(oversized/unbounded) task (중단 X)
- `scope_warnings: [{task, violations}]` — done_criteria ⊄ allowed_paths 계약모순 (중단 X)
- `bundle_warnings: [{task_id, ref, lines}]` — anchor 없이 통째 번들된 대형 shard (중단 X)

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

## 단계 2.6: 슬로우니스 경고 표면 (조건부, propose-only)

prepare 결과의 `size_warnings` / `scope_warnings` / `bundle_warnings` 중 **하나라도 비어있지 않으면**, fan-out **전에** 한국어로 요약 표시하고 진행 여부를 확인한다 (`context_warnings`와 동일 패턴 — 자동 수정 X, 철학 5번). 전부 빈 배열이면 이 단계 스킵.

> ⚠️ fan-out 전 슬로우니스 사전경보 (분해가 아직 무료인 지점):
> - 🔴 **턴소진 위험** (size_warnings): `<task>` — `<reason>`. 워커가 한 턴에 못 끝내 resume·salvage로 wall-time이 배로 늘 수 있음.
> - 🔴 **계약모순** (scope_warnings): `<task>` — done_criteria가 allowed_paths 밖 파일 생성을 요구 → merge 게이트가 통째 거부(작업 유실).
> - 🟡 **컨텍스트 bloat** (bundle_warnings): `<task_id>` — `<ref>`(`<lines>`줄)가 anchor 없이 K워커에 통째 복제.
>
> 어떻게 할까요?
> 1. **분해/수정 후 재시작** (권장): `/pact:plan` 재분해(oversized) 또는 사용자 승인 후 메인이 `tasks/<domain>.md`의 해당 task를 직접 `Edit`(계약모순=경로 추가/의무 제거, bloat=ref에 anchor 추가) → 다시 `/pact:parallel`.
> 2. **경고 무시하고 이대로 진행**: risk 감수하고 fan-out 계속.

사용자가 2를 택하면 그대로 단계 3으로. 1을 택하면 정리 안내(worktree·payload는 이미 생성됨 → `pact run-cycle collect` 또는 수동 cleanup) 후 재분해로 유도.

## 단계 3: coordinator 검토 (조건부)

`coordinator_review_needed: true`면 Task tool로 coordinator 검토 모드 spawn:
- `subagent_type: coordinator`
- prompt: `검토 모드. .pact/batch.json의 의도·논리·dependency를 점검 후 OK 또는 수정 사유.`

OK → 단계 4. 수정 필요 → 사용자 위임 (worktree·payload는 이미 만들어졌으므로 abort 시 `pact run-cycle collect` 또는 수동 cleanup 안내).

`coordinator_review_needed: false`면 바로 단계 4.

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

1. **같은 worktree(부분작업 보존)에 fresh worker 서브에이전트를 continuation 프롬프트로 재투입** (`scripts/worker-completion/resume.js`의 `continuationPrompt` 형식 그대로):
   - prompt 맨 앞에: `[RESUME n] 이전 워커가 턴 소진으로 미완. worktree에 부분작업 보존됨. 처음부터 다시 X — git status로 진행 확인 후 남은 done_criteria만 마저 완료. allowed_paths 동일.` + 원 `task_prompt`
   - `subagent_type: worker`, working_dir = 그 task의 worktree 그대로
2. 재투입 종료 후 `pact merge` 재시도.
3. **회로차단기**: 같은 task 재개 ≤ 2회(`MAX_RESUME`). 초과 시에만 아래 1~4 직접 처리 또는 사용자 위임.

> 헤드리스 `pact drive`는 driver.mjs `runResumableTask`가 이걸 자동으로 한다(토큰 0). 인터랙티브 `/pact:parallel`은 메인이 위 절차로 동일 효과를 낸다.

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

## 단계 7: coordinator 통합 (큰 batch만)

prepare가 `coordinator_review_needed: true`였으면 Task tool로:
- `subagent_type: coordinator`
- prompt:
```
통합 모드.
방금 종료 워커: <task_ids>
머지 결과: 성공 <merged>, 충돌 <yes|no>, 거부 <rejected.length>
verification_summary: <verification_summary>
decisions_to_record: <decisions_to_record>

PROGRESS.md를 갱신:
- Recently Done · Blocked / Waiting · Verification Snapshot
DECISIONS.md에 decisions_to_record 누적 (사용자 승인 필요한 건 후보로 표시).
```

작은 batch였으면 메인이 직접 PROGRESS.md 짧게 갱신 (Recently Done + Blocked만, ~5줄).

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
- prepare 후 단계 3에서 abort 결정: `pact run-cycle collect` 호출하면 결정적으로 정리 (status.json 없는 워커는 rejected로 처리됨)
