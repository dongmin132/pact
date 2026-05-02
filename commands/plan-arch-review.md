---
description: reviewer 호출 — 아키텍처 견고성 + 계약 정합성 (gstack /plan-eng-review 영감)
---

사용자가 `/pact:plan-arch-review`를 실행했습니다.

**범위**: 시스템 아키텍처 견고성 + pact 계약 정합성. gstack의 `/plan-eng-review` 영감 받음 — 우리는 추가로 API_CONTRACT·MODULE_OWNERSHIP·DB_CONTRACT 교차 검증.

## 단계 1: 사전 검사

- `TASKS.md` 존재 — 없으면 "/pact:plan 먼저"
- `API_CONTRACT.md` / `MODULE_OWNERSHIP.md` 있으면 정합성도 검증, 없으면 아키텍처만

## 단계 2: reviewer 서브에이전트 호출 (plan-arch-review 모드)

Task tool:
- `subagent_type`: `reviewer`
- `description`: "Plan architecture review"
- `prompt`:
  ```
  모드: plan-arch-review
  
  엔지니어 매니저 시각으로 plan 검토. 다음 7가지 cognitive pattern 적용:
  1. Boring by default — 새 인프라/패턴은 innovation token 가치 있나
  2. Blast radius — 결정의 worst case·영향 범위
  3. Reversibility — feature flag·canary 같은 안전망
  4. Complexity check — 8+ 파일/2+ 새 서비스면 smell
  5. DX as product quality — 느린 CI·local dev·deploy 영향
  6. Essential vs accidental complexity (Brooks)
  7. Make change easy first — refactor 분리
  
  4개 섹션:
  
  ### Section 1: Architecture
  - 데이터 흐름 명확한가
  - layer 분리 적절한가
  - cross-cutting concern 처리
  - ASCII 다이어그램 권장
  
  ### Section 2: Tests
  - 테스트 커버리지 계획
  - integration vs unit 균형
  - DB·외부 서비스 mock 정책
  
  ### Section 3: Performance
  - hot path 식별
  - N+1·메모리 누수 가능성
  - 큰 입력에 대한 지수적 복잡도
  
  ### Section 4: Pact 계약 정합성 (있으면)
  - task의 contracts 참조가 API_CONTRACT.md endpoint와 일치
  - allowed_paths가 MODULE_OWNERSHIP.md 모듈 안
  - 인증·rate limit·migration 같은 엣지 케이스
  - cross-cutting glob 처리
  
  각 섹션에서 0-10 점수 + "10이 되려면 무엇 필요한가".
  
  Scope challenge:
  - 8+ 파일/2+ 새 서비스면 분해 권장
  - 기존 코드로 부분 해결 가능한지
  - 최소 diff가 핵심 목적 달성하나
  ```

## 단계 3: 결과 + 다음 액션

```
다음 review:
  /pact:plan-task-review     # task 분해 품질
  /pact:plan-ui-review       # UI 디자인
  /pact:cross-review-plan    # Codex 외부 의견 (P2.5+)
권장 액션:
  /pact:contracts            # 계약 갱신
  /pact:plan                 # task 재분해
```
