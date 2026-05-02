---
description: 고아 worktree 일괄 삭제 (사용자 확인 필수, 자동 삭제 절대 X)
---

사용자가 `/pact:worktree-cleanup`을 실행했습니다.

**원칙**: 사용자 확인 없이 worktree 삭제 X (디버깅 자료 손실 방지, ARCHITECTURE.md §15 #8).

## 단계 1: 고아 식별

`/pact:worktree-status`와 동일한 로직으로 1주 이상 미사용 worktree 식별:

```bash
find .pact/worktrees -maxdepth 1 -mindepth 1 -type d -mtime +7
```

고아 0개면:
```
🌲 정리할 고아 worktree 없음.
모든 worktree가 1주 이내 활동 중입니다.
```
후 종료.

## 단계 2: 사용자 확인 (한국어, 한 번에)

```
🗑  정리할 고아 worktree (1주 이상 미사용):

  pact/PACT-042  .pact/worktrees/PACT-042  200MB  10d ago
  pact/PACT-099  .pact/worktrees/PACT-099  150MB  15d ago

총 2개, 350MB 회수 예상.

⚠️ 삭제 시 worktree 디렉토리 + 해당 branch 둘 다 제거됩니다.
   미머지 commit이 있으면 잃어버립니다.

진행할까요? [y/N]
```

답변 'y' 또는 '예' 외 모두 → 취소:
```
정리 취소됨. worktree는 그대로 유지됨.
```

## 단계 3: 삭제 실행

각 고아 worktree에 대해:

```bash
node -e "
const { removeWorktree } = require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
const r = removeWorktree('<task_id>', { force: true });
console.log(JSON.stringify(r));
"
```

`force: true` — 고아는 어차피 사용 안 했으니 강제 제거.

각 결과를 누적해서 마지막에 보고.

## 단계 4: 결과 보고 (한국어)

성공만 있을 때:
```
✅ 정리 완료

삭제된 worktree:
  ✓ pact/PACT-042
  ✓ pact/PACT-099

회수된 디스크: ~350MB
```

일부 실패:
```
⚠️ 일부 정리 실패

삭제됨:
  ✓ pact/PACT-042

실패:
  ✗ pact/PACT-099 — <git 에러>

수동 정리:
  git worktree remove --force .pact/worktrees/PACT-099
  git branch -D pact/PACT-099
```

## 안 하는 것

- ❌ 사용자 확인 없이 삭제 — 절대 X
- ❌ 활성 worktree(7일 이내) 삭제 — 의도된 작업 가능성
- ❌ 외부 worktree(.pact/worktrees/ 밖) 손대기 — 사용자 직접 작업 가능성

## 의문 시

- 1주 기준이 짧다고 사용자 피드백 → 지금은 hard-coded, 후속 cycle에서 옵션화 검토
- 삭제 도중 다른 프로세스가 같은 worktree 사용 중: git이 거부, 에러 보고
