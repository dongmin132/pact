---
description: 진행 중 cycle 강제 중단 — worktree 보존/삭제 사용자 선택
---

사용자가 `/pact:abort`를 실행했습니다.

## 단계 1: 사전 검사

`PROGRESS.md`의 status가 `not_started` 또는 `done` 같은 비활성 상태면:
```
중단할 활성 cycle 없음. /pact:status로 확인.
```
후 종료.

## 단계 2: 활성 워커 확인

```bash
ls -d .pact/worktrees/*/ 2>/dev/null
```

활성 worktree·워커들 사용자에게 표시.

## 단계 3: 사용자 결정 (한국어)

```
⚠️ 진행 중 cycle 강제 중단

영향:
  활성 워커: <N>개
  worktree: <목록>
  
worktree 처리:
  [1] 보존 (디버깅·재개용 — /pact:resume <id>로 재시도 가능)
  [2] 삭제 (디스크 회수, 작업 손실)

결정해주세요 [1/2]:
```

답변 외 입력 → "취소" 후 종료.

## 단계 4: 머지 상태 정리

`MERGE_HEAD` 있으면 abort:
```bash
git merge --abort 2>/dev/null
```

## 단계 5: 사용자 선택 따라 처리

### 5-A: 보존
- worktree 그대로 둠
- branch도 그대로

### 5-B: 삭제
각 worktree에 대해:
```bash
node -e "
const { removeWorktree } = require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
const r = removeWorktree('<task_id>', { force: true });
console.log('<task_id>:', r.ok);
"
```

## 단계 6: PROGRESS.md 갱신

```yaml
status: aborted
aborted_at: <ISO>
aborted_reason: <사용자 입력 또는 'manual'>
```

활성 task들을 Blocked에 추가:
```
- <task_id> — abort, worktree {보존|삭제}됨
```

## 단계 7: 결과 보고 (한국어)

```
⏸ Cycle <N> 중단됨

worktree: 보존 (3개) | 삭제 (3개)
PROGRESS.md status: aborted

다음:
  /pact:plan        # 새 cycle 시작
  /pact:resume      # 보존된 task 재개 (보존 선택 시)
```

## 의문 시

- 사용자가 답 안 주고 멈춤: 기본은 보존 (safer)
- 워커가 진짜 진행 중이면 (Task tool 응답 대기 중): 메인 Claude는 기다려야 함, abort 강제 X
