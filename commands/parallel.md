---
description: 워커 N개 동시 spawn (worktree 격리) → 머지 → PROGRESS 갱신 (run-cycle CLI 기반)
---

`/pact:parallel` 실행됨. 메인은 결정적 작업을 `pact run-cycle`로 묶어 호출하고 LLM 영역(워커 spawn·coordinator·사용자 보고)에 집중. 모든 안내는 한국어.

## 단계 1: Review 확인 게이트

한국어로 묻기: plan-task-review / plan-arch-review / plan-ui-review 중 어디까지 했는지. 답 [검토 없이] 시 PROGRESS.md에 `risk_acknowledged: true` + ts.

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

성공: `✅ Cycle 완료. 머지 <N>개. 검증 lint/tc/test/build 결과. 다음: /pact:status, /pact:parallel.`

부분: `⚠️ Cycle 부분 완료. 성공 <N>: ✓ ids. 실패 <M>: ✗ id 사유. 충돌 <C>: ✗ id → /pact:resolve-conflict. worktree 보존: .pact/worktrees/<id>.`

## 의문 시

- 동시 `/pact:parallel` 두 번: G12에 따라 거부, /pact:status·/pact:abort 안내
- 워커 timeout: 대기 + 진행 보고
- prepare 후 단계 3에서 abort 결정: `pact run-cycle collect` 호출하면 결정적으로 정리 (status.json 없는 워커는 rejected로 처리됨)
