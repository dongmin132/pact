---
description: 활성·고아 worktree 목록 + 디스크 사용량 표시
---

사용자가 `/pact:worktree-status`를 실행했습니다.

## 단계 1: git 환경 검사

```bash
git rev-parse --git-dir 2>/dev/null
```

git 저장소가 아니면 "여기는 git 저장소가 아닙니다" 후 중단.

## 단계 2: worktree 목록 조회

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js
```

위 명령 대신 직접 git을 호출해도 OK:

```bash
git worktree list --porcelain
```

각 worktree의 `path`/`branch`/`HEAD`를 추출.

## 단계 3: 분류

각 worktree에 대해:

- **활성**: `.pact/worktrees/<id>` 안에 있고 mtime 7일 이내
- **고아**: `.pact/worktrees/<id>` 안에 있지만 mtime 7일 초과
- **외부**: `.pact/worktrees/` 외 (사용자가 직접 만든 것 — 출력하지만 분류 X)

mtime 확인:

```bash
find .pact/worktrees -maxdepth 1 -mindepth 1 -type d -mtime +7
```

## 단계 4: 디스크 사용량 측정

```bash
du -sh .pact/worktrees/<id> 2>/dev/null
```

각 worktree별 사이즈, 합계.

## 단계 5: 한국어 출력

```
🌲 Worktree 상태

활성 (3):
  pact/PACT-001  .pact/worktrees/PACT-001  120MB  3h ago
  pact/PACT-002  .pact/worktrees/PACT-002   80MB  1h ago
  pact/PACT-003  .pact/worktrees/PACT-003  140MB  30m ago

고아 (1, 1주 이상 미사용):
  pact/PACT-042  .pact/worktrees/PACT-042  200MB  10d ago

외부 worktree (1):
  feature/x      ../another-wt              50MB

총 디스크: 590MB
정리 가능 (고아): 200MB

다음:
  /pact:worktree-cleanup    # 고아 worktree 일괄 삭제 (확인 필수)
```

worktree 0개:
```
🌲 활성 worktree 없음.
```

## 의문 시

- `du` 명령 없거나 실패: 사이즈 표시 생략, 나머지는 정상 출력
- `.pact/worktrees/` 자체가 없음: 정상 (아직 cycle 안 돌린 프로젝트). "활성 worktree 없음" 표시
