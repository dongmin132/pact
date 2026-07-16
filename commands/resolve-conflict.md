---
description: 머지 충돌 해결 — 사용자 직접 해결 후 cycle 재개 (자동 해결 X)
---

사용자가 `/pact:resolve-conflict`를 실행했습니다.

**원칙** (ADR-007 / ARCHITECTURE.md §15 #7): 머지 충돌 자동 해결은 **영구 out-of-scope**. 사용자가 직접 해결한 후 이 명령으로 재개.

## 단계 1: 충돌 상태 + 충돌 task 식별

```bash
git status
git diff --name-only --diff-filter=U
```

충돌 파일이 없으면:
```
충돌 상태가 아닙니다.
이미 해결됐다면 git commit으로 머지를 마무리하세요.
처음 시도하려면 /pact:parallel을 먼저 실행해주세요.
```
후 종료.

충돌한 **task_id**를 결정적으로 확인한다 (추측 X): `.pact/merge-result.json`의 `conflicted.task_id`(또는 `single_merge.conflicted.task_id`)를 읽거나, 없으면 `git rev-parse --abbrev-ref MERGE_HEAD`(= `pact/<task-id>`)에서 도출. 이 `<task-id>`를 이후 단계에서 사용한다.

## 단계 2: 충돌 정보 표시 (한국어)

```
🔧 머지 충돌 감지

충돌한 task: <task-id> (branch pact/<task-id>)
충돌 파일:
  - <git diff --diff-filter=U 결과>

다음 단계를 직접 진행해주세요:

[1] 충돌 파일들을 에디터로 열고 <<<<<<< 마커 해결
[2] 해결한 파일을 git add
[3] 모두 add 완료 후 이 명령에 "완료"라고 답해주세요

또는 [취소]: 머지를 취소하고 worker branch·worktree는 보존
```

## 단계 3: 사용자 답변 대기

### 3-1: "완료" 답변

충돌 마커가 남았는지 확인:
```bash
git diff --check; git status --porcelain | grep -E '^(UU|AA|DD|U.|.U)' && echo "아직 충돌 남음"
```

여전히 충돌이 있으면 파일 목록을 보여주고 계속 작업 요청 후 대기.

모두 해결됐으면 머지를 마무리:
```bash
git commit -m "pact: resolve merge conflict for <task-id>"
```

**중요 — 해결된 task를 done으로 확정하고 worktree를 정리한다.** 이 단계를 빠뜨리면 소스 status가 `todo`로 남아 다음 prepare가 같은 task를 **재spawn**하고, 보존된 worktree가 다음 `/pact:parallel` prepare를 `stage:worktree`로 막는다(H8). `collect-one`은 방금 머지된 branch를 `already_merged`로 멱등 인식해 status=done을 커밋하고 worktree를 정리한다 (재머지 아님):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle collect-one <task-id> --commit-status
```

stdout 필드로 분기 (판단 X):
- `already_merged: [<task-id>]` 또는 `merged: [<task-id>]` → status=done 커밋 + worktree 정리 완료. 단계 4로.
- `rejected` → 수동 해결본이 게이트(status.json/allowed_paths)를 못 넘음 → reason 표시 후 `/pact:takeover <task-id>`로 계약대로 마무리 안내.

이후 `coordinator`에게 PROGRESS.md 갱신 위임 (Blocked → Recently Done).

### 3-2: "취소" 답변

```bash
git merge --abort
```

worker branch·worktree는 보존됨. PROGRESS.md Blocked 섹션에 기록:
```
- <task-id> — 머지 충돌, 사용자 취소. /pact:resume 또는 /pact:takeover로 재개.
```

## 단계 4: 결과 보고 + 안전한 cycle 재개 (한국어)

### 해결 성공
```
✅ 충돌 해결 완료 — <task-id> status=done 커밋, worktree 정리됨.
```

**다음: cycle 재개.** 아직 안 끝난 task를 이어서 진행하되, 보존된 worktree를 파괴하지 않는다:

- `.pact/current_batch.json`이 **있으면** → `/pact:parallel` — `already_prepared` 재개 경로가 각 task를 collect-one으로 라우팅한다(done은 재spawn 안 함, 남은 task만 이어서).
- **없으면**(배치 collect가 정리함) → `/pact:parallel`이 남은 not-done task로 fresh prepare. prepare가 `stage:worktree`로 실패하면 그 task에 이전 사이클의 보존 worktree가 남은 것 —
  - 이미 done(`tasks/*.md` status done)이면 stale worktree → `pact run-cycle collect-one <id> --commit-status`(멱등 정리) 또는 `git worktree remove .pact/worktrees/<id>`로 안전 제거.
  - 미완 부분작업이면 → **force-remove 금지**. `/pact:resume <id>`(이어서 재투입) 또는 `/pact:takeover <id>`(직접 인계)로 보존된 worktree를 재사용해 마무리.

```
다음:
  /pact:parallel        # 남은 task 이어서 (already_prepared 재개 또는 fresh)
  /pact:status          # 진행 확인
```

### 취소
```
⏸  머지 취소 — worktree·branch 보존됨.
다음: /pact:resume <task-id> (이어서 재투입) 또는 /pact:takeover <task-id> (직접 인계)
```

## 안 하는 것

- ❌ 자동 충돌 해결 — 영구 X (안전 원칙)
- ❌ AI가 충돌 코드 추측 — 영구 X
- ❌ 보존된 worktree를 `git worktree remove --force`로 무조건 삭제 — 부분작업 손실 위험 (done 확인 후에만 정리)
- ❌ rebase·stash 자동화 — 사용자가 명시적으로

## 의문 시

- `git merge --abort`도 실패: 사용자에게 `git status` 확인 후 수동 정리 안내.
- collect-one이 `rejected`: 수동 해결본이 계약을 못 넘음 → `/pact:takeover <task-id>`로 done_criteria·allowed_paths 준수하며 마무리.
- 충돌 파일이 너무 많음 (>20): "이전 cycle 너무 큼 — /pact:plan에서 task 더 잘게 분해 권장" 안내.
