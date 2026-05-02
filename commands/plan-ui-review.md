---
description: reviewer 호출 — UI/UX 디자인 검토 (gstack /plan-design-review 영감, UI task 있을 때만 의미)
---

사용자가 `/pact:plan-ui-review`를 실행했습니다.

**범위**: UI/UX 디자인 차원. gstack의 `/plan-design-review` 영감. UI 관련 task가 없으면 빠르게 "검토 대상 없음" 출력.

## 단계 1: 사전 검사

- `TASKS.md` 존재 — 없으면 "/pact:plan 먼저"
- UI task 후보 식별 (allowed_paths에 frontend·components·views·ui 등 포함)
- UI task 0개면:
  ```
  검토할 UI task 없음. /pact:plan-arch-review로 진행 권장.
  ```
  후 종료

## 단계 2: reviewer 서브에이전트 호출 (plan-ui-review 모드)

Task tool:
- `subagent_type`: `reviewer`
- `description`: "Plan UI/UX review"
- `prompt`:
  ```
  모드: plan-ui-review
  
  UI 관련 task만 디자이너 시각으로 검토.
  
  UX 3법칙 (Krug):
  1. Don't make me think — 인지 부담 최소화
  2. 클릭 수 X, 명확함 O — 좋은 클릭은 카운트 X
  3. 절반은 빼기 — 80% 단순화 후 절반 더
  
  6개 디자인 차원, 각 0-10 + "10이 되려면":
  
  ### 1. Clarity (명확성)
  - 화면 목적이 한눈에 보이나
  - 다음 액션이 명확한가
  
  ### 2. Hierarchy (위계)
  - 가장 중요한 정보가 가장 두드러지나
  - 시선 흐름이 자연스러운가
  
  ### 3. Consistency (일관성)
  - 같은 행동은 같은 패턴으로
  - 디자인 토큰·spacing·typography 일관
  
  ### 4. Feedback (피드백)
  - 사용자 액션에 즉각 반응
  - 로딩·에러·성공 상태 모두 명시
  
  ### 5. Accessibility (접근성)
  - 키보드 navigation
  - 스크린리더 의미 박힘
  - 색 대비 WCAG AA 이상
  - focus indicator
  
  ### 6. Motion (모션)
  - 의미 있는 전환만
  - 200ms 이내, easing 자연스러움
  - prefers-reduced-motion 존중
  
  각 task당:
  - 6 차원 점수
  - 가장 약한 차원의 구체 fix 제안
  - "이 task 끝나면 사용자가 무엇을 느낄까" 한 줄 시뮬레이션
  ```

## 단계 3: 결과 + 다음 액션

```
다음:
  /pact:plan-task-review     # 분해 품질
  /pact:plan-arch-review     # 아키텍처
  /pact:plan                 # UI task 재분해 (디자인 fix 반영)
```
