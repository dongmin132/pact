---
description: 사이클 회고 — 잘된 점·실패 원인·개선 후보 (propose-only, 자동 반영 X)
---

사용자가 `/pact:reflect`를 실행했습니다.

**원칙** (ARCHITECTURE.md 철학 5번): **propose-only**. reflect 결과를 자동으로 적용 X. DECISIONS.md ADR 후보로만 추가.

## 단계 1: 사전 검사

- `CLAUDE.md`, `PROGRESS.md`, `DECISIONS.md` 존재
- 마지막 cycle이 `done` 또는 `aborted`인 상태가 자연스러움 (running 중에도 호출은 가능)

## 단계 2: planner 서브에이전트 호출 (회고 모드)

Task tool:
- `subagent_type`: `planner`
- `description`: "Cycle reflection — 회고 분석"
- `prompt`:
  ```
  모드: reflect
  
  마지막 cycle을 회고:
  - 잘 된 부분 (3개 이내)
  - 안 된 부분 + 가능한 원인 (3개 이내)
  - 개선 후보 ADR (DECISIONS.md 추가용, 사용자 승인 전제)
  
  입력:
  - .pact/runs/*/status.json 들 (이번 cycle)
  - .pact/merge-result.json
  - PROGRESS.md
  - 워커 보고서들 (.pact/runs/*/report.md)
  
  출력은 채팅 prose로:
  
  📝 Cycle <N> 회고
  
  ### 잘 된 부분
  - <bullet>
  
  ### 안 된 부분
  - <bullet> — 원인 추정: <설명>
  
  ### 제안 ADR (사용자 승인 후 DECISIONS.md 추가)
  
  #### ADR-XXX (제안) — <제목>
  결정·이유·트레이드오프 한 단락
  
  ### 토큰·비용
  cycle 토큰: <합계> | cross-review 비용: <합계>
  ```

## 단계 3: 사용자 결정 (한국어)

planner가 제안 ADR을 출력하면:

```
제안된 ADR <N>개:
  [1] ADR-XXX — <제목>: 채택?
  [2] ADR-YYY — <제목>: 채택?
  ...

각 항목별로 답해주세요: y(채택) / n(거부) / e(편집)
```

## 단계 4: 채택된 ADR을 DECISIONS.md에 추가

`y` 답변만 DECISIONS.md에 prepend (최신이 위에).

`e` 답변은 사용자에게 직접 편집 안내 (자동 적용 X).

## 단계 5: skill·rule 변경 제안 — propose-only

reflect 결과 중 `agents/*.md`·`commands/*.md`·`prompts/*.md` 변경 제안이 있으면:

```
⚠️ 다음 변경은 자동 적용되지 않습니다 (propose-only 원칙):

제안된 변경:
  - agents/coordinator.md: <한 줄 요약>
  - commands/parallel.md: <한 줄 요약>

사용자가 직접 검토·수정 후 적용 결정해주세요.
DECISIONS.md ADR로도 사유 기록 권장.
```

## 안 하는 것

- ❌ skill·rule 자동 수정 (propose-only)
- ❌ ADR 자동 추가 (사용자 승인 후만)
- ❌ TASKS.md 자동 갱신 (회고는 회고일 뿐)

## 의문 시

- cycle이 너무 작아 회고 의미 없음: "회고할 cycle 데이터 부족" 안내 후 종료
- planner가 제안 0개: "이번 cycle은 특이사항 없음" 출력
