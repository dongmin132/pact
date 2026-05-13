---
description: 멀티세션 모드 가이드 — cmux/tmux로 여러 Claude Code 세션을 진짜 병렬로 굴리기 (v0.6.0+)
---

사용자가 `/pact:multi-session`을 실행했습니다. 멀티세션 모드 안내 + 사전 검사.

## 사전 검사 (Bash)

```bash
# .pact/batch.json 존재 확인
test -f .pact/batch.json || { echo "batch.json 없음. /pact:parallel 먼저 또는 pact run-cycle prepare." ; exit 2; }

# 현재 batch + 미점유 task 확인
pact next --all
```

## 흐름 안내 (한국어 출력)

```
🪟 pact 멀티세션 모드

설계:
  - 워커가 sub-agent(Task tool)가 아니라 별도 Claude Code 세션
  - 각 세션이 자기 worktree에서 독립 작업
  - 메인 컨텍스트 누수 0 (sub-agent 패턴 대비 최고 장점)
  - status.json 기록·머지·verify는 그대로

전제:
  1. pact 사이클은 이미 prepare까지 끝난 상태여야 함 (.pact/batch.json + worktrees/*/ + runs/*/prompt.md 존재)
  2. cmux/tmux 같은 멀티 터미널 도구 사용 권장
  3. 각 워커 세션은 yolo 모드 권장 (사람이 권한 모달 일일이 답할 X)

흐름 (한 worker 세션당):
  1. pact next                       # 미점유 task 한 개 추천
  2. pact claim <task_id>             # 명시적 점유 (lock 파일 생성)
  3. cd .pact/worktrees/<task_id>/    # worktree 진입
  4. claude                           # 새 세션 시작. prompt.md를 첫 입력으로 붙여넣음
  5. 워커가 작업 끝나면 status.json + report.md 남기고 종료
  6. lock은 SessionEnd hook이 정리 (또는 명시적 종료)

메인 세션 (collector):
  - pact status --watch              # 다른 세션 진행 추적
  - 모든 워커 종료 후: pact run-cycle collect  # 머지 + cleanup + summary
```

## 핵심 주의

| 주의점 | 대응 |
|---|---|
| 같은 task를 두 세션이 시작 | `pact claim`이 lock으로 차단 (pid 살아있으면 거부) |
| status.json mid-write race | 워커가 마지막에 한 번에 write (작은 파일이라 partial 가능성 낮음) |
| 비정상 종료한 워커가 남긴 lock | session-start / progress-check hook이 stale lock 자동 정리 |
| 머지 시점 | **단일 지점에서만** (`pact run-cycle collect`) |

## 의문 시

- batch.json 없음: "/pact:parallel 또는 pact run-cycle prepare 먼저"
- claim 실패 (이미 점유): 어떤 PID/세션이 잡고 있는지 출력 → 사용자 결정 (대기 또는 다른 task)
- 워커가 status.json 안 남기고 죽음: pact run-cycle collect 시 자동 blocked 분류 (기존 동작)
