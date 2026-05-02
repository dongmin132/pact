---
description: 머지 충돌 해결 — 사용자 직접 해결 후 cycle 재개 (자동 해결 X)
---

사용자가 `/pact:resolve-conflict`를 실행했습니다.

**원칙** (ADR-007 / ARCHITECTURE.md §15 #7): 머지 충돌 자동 해결은 **영구 out-of-scope**. 사용자가 직접 해결한 후 이 명령으로 재개.

## 단계 1: 현재 충돌 상태 확인

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

## 단계 2: 충돌 정보 표시 (한국어)

```
🔧 머지 충돌 감지

충돌한 task: pact/<task-id>
충돌 파일:
  - src/api/auth/login.ts
  - src/types/auth.ts

다음 단계를 직접 진행해주세요:

[1] 충돌 파일들을 에디터로 열고 <<<<<<< 마커 해결
[2] 해결한 파일을 git add
[3] 모두 add 완료 후 이 명령에 "완료"라고 답해주세요

또는 [취소]: 머지를 취소하고 worker branch는 보존
```

## 단계 3: 사용자 답변 대기

### 3-1: "완료" 답변

```bash
git status --porcelain | grep '^UU\|^AA\|^DD' && echo "아직 충돌 남음"
```

여전히 충돌 마커가 있으면:
```
아직 해결되지 않은 파일이 있습니다:
  - <파일 목록>
계속 작업 후 다시 답해주세요.
```

모두 해결됐으면:
```bash
git commit -m "pact: resolve merge conflict for <task-id>"
```

머지 완료 → coordinator에게 PROGRESS.md 갱신 위임.

### 3-2: "취소" 답변

```bash
git merge --abort
```

worker branch와 worktree는 보존됨. 사용자가 다음에 `/pact:resume <task-id>`로 재개 가능.

PROGRESS.md Blocked 섹션에 기록:
```
- <task-id> — 머지 충돌, 사용자 취소. /pact:resume으로 재시도.
```

## 단계 4: 결과 보고 (한국어)

### 해결 성공
```
✅ 충돌 해결 완료

해결된 task: <task-id>
머지 commit: <hash>

다음 단계:
  /pact:parallel        # 다음 task 진행
  /pact:status          # 진행 확인
```

### 취소
```
⏸  머지 취소

worktree·branch 보존됨. 다음에 재개 가능:
  /pact:resume <task-id>
```

## 안 하는 것

- ❌ 자동 충돌 해결 — 영구 X (안전 원칙)
- ❌ AI가 충돌 코드 추측 — 영구 X
- ❌ rebase 자동화 — 사용자가 명시적으로
- ❌ stash 자동 — 사용자 결정

## 의문 시

- `git merge --abort`도 실패: 사용자에게 `git status` 확인 후 수동 정리 안내
- 충돌 파일이 너무 많음 (>20): 사용자에게 "이전 cycle 너무 큼, /pact:plan에서 task 더 잘게 분해 권장" 안내
