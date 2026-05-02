---
description: reviewer 호출 — task 분해 품질만 검토 (메타 수준). 아키텍처는 /pact:plan-arch-review.
---

사용자가 `/pact:plan-task-review`를 실행했습니다.

**범위**: 메타 수준의 task 분해 품질만. 아키텍처·UI는 별도 명령:
- `/pact:plan-arch-review` (아키텍처 + 계약 정합성)
- `/pact:plan-ui-review` (UI 디자인)

## 단계 1: 사전 검사

- `TASKS.md` 존재 — 없으면 "/pact:plan 먼저"

## 단계 2: reviewer 서브에이전트 호출 (plan-task-review 모드)

Task tool:
- `subagent_type`: `reviewer`
- `description`: "Plan task decomposition review"
- `prompt`:
  ```
  모드: plan-task-review
  
  TASKS.md 메타 품질만 검증:
  1. 크기 — task당 파일 ≤ 5
  2. done_criteria 측정 가능
  3. 의존성 — cycle 0개, contract_only 적절
  4. TDD 가능성 — task 성격에 맞나
  5. 교육 모드 — frontmatter 박힘
  
  분류: ✅ 양호 / ⚠️ WARN / ❌ FAIL.
  각 발견에 권장 액션.
  ```

## 단계 3: 결과 + 다음 액션

reviewer prose 표시 후:
```
다음 review:
  /pact:plan-arch-review     # 아키텍처 + 계약 정합성
  /pact:plan-ui-review       # UI 디자인 (UI task 있을 때만)
  /pact:cross-review-plan    # Codex 외부 의견 (P2.5+)
```
