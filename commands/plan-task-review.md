---
description: reviewer 호출 — task 분해 품질만 검토 (메타 수준). 아키텍처는 /pact:plan-arch-review.
---

사용자가 `/pact:plan-task-review`를 실행했습니다.

**범위**: 메타 수준의 task 분해 품질만. 아키텍처·UI는 별도 명령:
- `/pact:plan-arch-review` (아키텍처 + 계약 정합성)
- `/pact:plan-ui-review` (UI 디자인)

## 단계 1: 사전 검사

- `TASKS.md` 또는 `tasks/*.md` 존재 — 없으면 "/pact:plan 먼저"

## 단계 2: reviewer 서브에이전트 호출 (plan-task-review 모드)

Task tool:
- `subagent_type`: `reviewer-task`
- `description`: "Plan task decomposition review"
- `prompt`:
  ```
  
  docs/context-map.md를 먼저 보고 task corpus는 통째로 읽지 마세요.
  pact slice --headers로 TOC를 보고, 필요한 task만 pact slice --ids로 읽어 메타 품질만 검증:
  1. 크기 — task당 파일 ≤ 5
  2. done_criteria 측정 가능
  3. 의존성 — cycle 0개, contract_only 적절
  4. TDD 가능성 — task 성격에 맞나
  5. 교육 모드 — frontmatter 박힘
  
  분류: ✅ 양호 / ⚠️ WARN / ❌ FAIL.
  각 발견에 권장 액션.
  ```

## 단계 3: 결과 + 다음 액션

**리뷰는 propose-only** (철학 5번) — reviewer 서브에이전트는 ⚠️/❌ 권장사항을 prose로 낼 뿐 `tasks/*.md`를 직접 고치지 않는다 (일회용 워커가 SOT를 건드리면 안 됨). 단 "자동 반영 X"가 막는 건 **무승인 자동 적용**이지, **사용자 승인 후 적용**은 정상 흐름이다.

워커는 `tasks/*.md`(task SOT)만 보고 일하므로(`pact run-cycle prepare`가 `tasks/*.md` → `.pact/current_batch.json` → `task_prompts`), 권장사항을 실제 작업에 넣으려면 `/pact:parallel` **전에** 반영해야 한다. 반영 주체·방법:

- **작은 fix** (done_criteria 문구, context_refs/allowed_paths 한 줄 등) → **메인이 권장사항을 요약 → 사용자 승인 → 메인이 해당 task만 `pact slice --ids`로 읽고 `tasks/<domain>.md`를 직접 `Edit`.** `/pact:plan` 재호출은 불필요 (planner 재spawn = 토큰 낭비 + 멀쩡한 다른 task drift 위험).
- **구조 변경** (task 분할, 의존성 재배치) → `/pact:plan`으로 domain shard 재분해 (planner가 schema 정합 출력 보장).

손편집으로 schema가 깨져도 `prepare`의 `task-parse` 단계가 잡아낸다 (안전망).

⚠️ 반영 없이 바로 `/pact:parallel`을 돌리면 prepare가 리뷰 **전** 원본 task를 읽어 워커에 넘김 — 리뷰가 채팅에만 남고 작업엔 안 들어감.

reviewer prose 표시 후:
```
다음 review:
  /pact:plan-arch-review     # 아키텍처 + 계약 정합성
  /pact:plan-ui-review       # UI 디자인 (UI task 있을 때만)
  /pact:cross-review-plan    # Codex 외부 의견 (P2.5+)
반영:
  작은 fix   → 메인이 승인 후 tasks/<domain>.md 해당 task Edit
  구조 변경  → /pact:plan 재분해
```
