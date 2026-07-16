---
description: 회로 차단(escalation)된 task에 fresh 워커 재투입 — /pact:resume <task_id>
---

사용자가 `/pact:resume $ARGUMENTS`를 실행했습니다.

## 이 커맨드가 하는 일 (vs /pact:takeover)

- **`/pact:resume`** — 보존된 worktree에 **fresh 워커를 이어서 재투입**(자동). 부분작업 위에 "처음부터"가 아니라 "이어서" 마무리. 턴/예산 소진으로 미완이거나 머지 게이트가 거부한 task에 쓴다.
- **`/pact:takeover`** — 사람(이 세션)이 worktree를 직접 인계. 워커 재시도로 안 풀리는 판단·커플링 task에 쓴다.

**판단은 CLI, 릴레이는 LLM** (parallel.md와 동일 원칙). 재개 필요·상한·머지 합격은 스스로 판단하지 않고 `pact resume-prompt`/`collect-one`이 낸 **필드만** 따른다. 회로차단기는 LLM 기억이 아니라 파일(`.pact/runs/<id>/resume.json`)로 영속 — **재투입 상한 2회**(헤드리스 `pact drive`와 동일 예산).

## 단계 1: 인자 검증

`$ARGUMENTS`가 비어있거나 task_id 형식(`[A-Z][A-Z0-9]*-\d+`) 아니면:
```
Usage: /pact:resume <task-id>
예: /pact:resume PACT-042
```
후 중단.

## 단계 2: 사전 검사

1. `CLAUDE.md` 존재 — 없으면 "/pact:init 먼저" 후 중단.
2. `.pact/runs/<task_id>/payload.json` 존재 (이전 spawn 정보 보존됨).
3. `.pact/worktrees/<task_id>/` 보존돼있나 확인.

조건 미충족 시 한국어로 사유 + 안내 후 중단. worktree가 이미 정리됐으면 `/pact:plan` 재분해 권장.

## 단계 3: 재개 필요·상한 판정 + 이전 실패 사유 표시 (조회, 부수효과 없음)

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact resume-prompt <task_id>
```

stdout JSON `{incomplete_reason?, resume_needed, resumes_remaining, resumes_used, escalate}`을 사용자에게 한국어로 보여준다 (이 호출은 `--consume`이 없어 카운트를 늘리지 않는다):

```
PACT-042 재개 검토:
  이전 미완 사유: <incomplete_reason 또는 "worktree dirty(부분작업 보존)">
  재투입 사용: <resumes_used>/2회  (남은 <resumes_remaining>회)

재투입하시겠습니까? [y/N]
```

- `escalate: true` (재투입 상한 도달) → **재투입 X**. 아래 안내 후 중단:
  ```
  🚨 <task-id> 재투입 상한(2회) 도달 — fresh 재시도로는 같은 실패 반복 가능성 높음.
     /pact:takeover <task-id>   # 사람이 worktree 직접 인계해 마무리
     /pact:plan                 # DECISIONS.md에 "왜 실패하는가" ADR 기록 후 재분해
  ```
- 'y' 외 답변 → 취소.

## 단계 4: fresh 워커 재투입 (재개 1회 소비)

`--consume`으로 continuationPrompt를 받고 회로차단기 카운트를 영속 증가시킨다 (인라인 작문 금지 — driver.mjs와 동일 코어 단일소스):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact resume-prompt <task_id> --consume
```

`escalate: true`면 (방금 소비가 상한에 막힘) 단계 3의 escalate 안내로 분기하고 중단. 아니면 stdout의 `continuationPrompt`(직전 거부 사유가 접혀 있음)를 **그대로** Task tool의 프롬프트로 써서 **워커 서브에이전트 1개**를 호출한다:

- `subagent_type`: `worker`
- `prompt`: `continuationPrompt` (수정·재작문 X)

워커는 보존된 `.pact/worktrees/<task_id>/`에서 부분작업 위에 이어서 작업하고, 종료 시 `.pact/runs/<task_id>/status.json`을 갱신한다.

## 단계 5: 게이트 머지 (collect-one — 직접 머지 금지)

워커 종료 후 **그 task 하나만** 결정적 게이트(report-gen → planMerge)를 거쳐 머지한다. 메인이 직접 main에 머지하지 않는다 (검증 없이 병합 X):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle collect-one <task_id> --commit-status
```

stdout 필드로 분기 (**판단하지 말고 필드만**):
- `merged: [<id>]` → 성공. 단계 6 성공 보고.
- `rejected: [{task_id, reason}]` → 게이트 거부(base 미반영). reason 표시 후, 남은 재투입이 있으면 단계 3부터 재검토, 없으면 `/pact:takeover` 안내.
- `conflicted` / `ok:false, stage:"merge-in-progress"` → 머지 정지 신호. 자동 해결 X — `/pact:resolve-conflict` 안내 후 중단 (worktree 보존).

## 단계 6: 결과 보고 (한국어)

성공:
```
✅ <task-id> 재투입 성공 — collect-one 게이트 통과·머지됨.
PROGRESS.md Blocked에서 제거하고 Recently Done에 반영하세요.
```

미완(또 막힘):
```
⚠️ <task-id> 재투입 후에도 미완 (남은 재투입 <resumes_remaining>회)
사유: <collect-one rejected reason 또는 status.json blockers>

다음:
  /pact:resume <task-id>    # 남은 재투입이 있으면 또 시도
  /pact:takeover <task-id>  # 사람이 worktree 직접 인계
  /pact:plan                # task 재분해
```

## 의문 시

- worktree 외부에서 변경된 파일 있음: 사용자에게 알림, 강제 진행 X.
- payload schema가 옛 버전: 사용자에게 안내, /pact:plan 재호출 권장.
- 같은 task 상한 도달 반복: DECISIONS.md에 실패 원인 ADR 기록 후 재분해 (재투입 반복 금지).
