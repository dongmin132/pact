# WORKTREE_POLICY — pact 워커 격리 정책

> ARCHITECTURE.md §18 sourcing.
> W1~W5 다섯 정책 중 W1~W3은 PACT-026, W4·W5는 PACT-028에서 결정.

## W1 — Worktree 위치

**채택**: `<repo>/.pact/worktrees/<task_id>/`

예: `myapp/.pact/worktrees/PACT-042/`

**이유**:
- IDE(VSCode·JetBrains)에서 같은 프로젝트 워크스페이스 안에 보여 디버깅 편함
- `.pact/.gitignore`로 git 자동 무시
- 사용자가 직접 `cd .pact/worktrees/<id>` 가능

**트레이드오프**:
- ❌ monorepo 같은 큰 프로젝트는 디스크 부담 (worktree 1개당 GB 가능)
- ❌ IDE 인덱싱이 worktrees까지 처리해 느려질 수 있음 (해결: IDE에 `.pact/` 제외 권장)
- ✅ git의 hard link 활용으로 전체 복사보다 가벼움

## W2 — Branch 전략

**채택**: `pact/<TASK-ID>` per task

예: `pact/PACT-042`, `pact/AUTH-007`

**이유**:
- task별 격리 추적성 — git log에서 어느 task의 변경인지 명확
- 머지 후 task 단위로 브랜치 정리 가능
- task 의존성 그래프와 1:1 대응

**트레이드오프**:
- ❌ task 수만큼 브랜치 폭증 — 정기 cleanup 필요 (`/pact:worktree-cleanup`)
- ✅ task 단위 추적성

## W3 — Base branch

**채택**: 직전 cycle 결과 (현재 main HEAD)

`/pact:parallel` 시작 시점의 main HEAD에서 worktree 분기.

**이유**:
- cycle 간 의존성 자연스러움 — 이전 cycle 산출물 위에 새 작업
- main이 cycle 단위 atomic 머지로 항상 일관된 상태 (W4 참조)

**트레이드오프**:
- ❌ 직전 cycle이 buggy면 새 cycle이 영향 받음 (해결: cycle 종료 시 verify 강제)
- ❌ main과 동기화는 사용자 책임 (rebase 등)

## 환경 요구사항

`/pact:init`과 `/pact:parallel` 시점 검사:

- ✅ git 2.5+ 설치 (worktree 지원)
- ✅ git 저장소 (`git rev-parse --git-dir` 성공)
- ✅ main branch 존재 (`git show-ref refs/heads/main` 성공) — 또는 `master`
- ✅ uncommitted changes 없음 — 있으면 사용자에게 stash 권장

검사 실패 시 명확한 한국어 에러 + 해결 안내.

## 실패 시 worktree 처리

| 실패 유형 | worktree 처리 |
|---|---|
| 워커 작업 실패 (test/build fail) | 보존 — `/pact:resume`으로 재개 |
| 워커 크래시 (timeout 등) | 보존 + 사용자 알림 |
| 머지 충돌 (W5에서 결정) | 보존 — `/pact:resolve-conflict` |
| 워커 정상 완료 + 머지 성공 | 자동 삭제 |
| 사용자 `/pact:abort` | 사용자에게 보존/삭제 선택 |
| 고아 worktree (1주 이상) | `/pact:worktree-cleanup`으로 사용자 확인 후 일괄 삭제 |

## W4·W5 (PACT-028에서 결정 예정)

- **W4**: 머지 전략 (default: cycle 단위 atomic)
- **W5**: 충돌 해결 (default: 즉시 사용자 위임, 자동 해결 X)

## 알려진 한계

- monorepo 거대 프로젝트: worktree 1개당 수GB 가능 → 동시 워커 수 제한 권장
- submodule 있는 repo: worktree 동작 미묘 → v1.0은 simple repo만 검증
- 사용자가 직접 worktree 만진 경우: 외부 변경 감지 어려움 → `/pact:worktree-status`로 점검 권장
