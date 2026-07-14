---
description: 사이클 회고 — 잘된 점·실패 원인·개선 후보 (propose-only, 자동 반영 X)
---

사용자가 `/pact:reflect`를 실행했습니다.

**원칙** (ARCHITECTURE.md 철학 5번): **propose-only**. reflect 결과를 자동으로 적용 X. DECISIONS.md ADR 후보로만 추가.

## 단계 1: 사전 검사

- `CLAUDE.md`, `PROGRESS.md`, `DECISIONS.md` 존재
- 마지막 cycle이 `done` 또는 `aborted`인 상태가 자연스러움 (running 중에도 호출은 가능)

## 단계 1.5: 드리프트·요약 결정적 수집 (`pact drift`)

드리프트 검출과 사이클 요약 추출은 판단이 아니라 결정적 사실 — CLI 한 번으로 수집한다 (A-3):

```bash
DRIFT=$(node ${CLAUDE_PLUGIN_ROOT}/bin/pact drift)
```

출력(JSON): `clean` / `code_changed[]` / `docs_changed[]` / `failures[]` / `rejected_count` / `verify_fails[]` / `verification_summary` / `decisions_to_record[]` / `standalone_merge?` / `no_cycle?`.

**조기 종료 (LLM 0토큰)**: `clean: true` 면 — 마지막 머지 이후 코드 변경 0 + failures 0 + rejected 0 + verify fail 0 — planner 를 호출하지 않고 사용자에게 한 줄만 출력 후 종료한다:

> ✅ 표류 없음 — 마지막 머지 이후 변경·실패가 없어 회고할 내용이 없습니다. (planner 미호출)

`clean: false` 면 아래 단계 2로 진행하고, `DRIFT` JSON 을 planner prompt 에 inline 주입한다. `standalone_merge: true`(요약 필드 없는 standalone `pact merge` 산출물)면 planner 가 status.json(소용량)으로 폴백한다. `no_cycle: true`(merge-result 없음 — 사이클 전)면 드리프트 항목 없이 일반 회고만 진행.

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
  - **Docs drift** — 마지막 머지 이후 사용자가 직접 수정했지만 갱신이 누락된 SOT 파일 (단계 1.5 `DRIFT.code_changed` / `DRIFT.docs_changed` 비교)
  
  **갱신 권장 시 SOT 우선순위 (역순 = 절대 금지)**:
  1. **1순위: shard** — `contracts/api/<domain>.md`, `contracts/db/<domain>.md`, `contracts/modules/<domain>.md`. 해당 domain shard가 존재하면 **무조건 shard를 가리킬 것**.
  2. **2순위: shard 없는 root SOT** — `ARCHITECTURE.md`, `CLAUDE.md`, `docs/*.md`
  3. ❌ **금지: legacy root** — `API_CONTRACT.md` / `DB_CONTRACT.md` / `MODULE_OWNERSHIP.md` 는 대응 shard 가 있으면 절대 가리키지 말 것. shard 가 진짜 SOT, 루트는 legacy index.
  4. shard 가 **없는** 경우에만 root 가리키되, 그때는 "shard 없음, `pact split-docs` 분할 권장" 한 줄 함께 표시.
  
  domain 매핑은 `contracts/manifest.md` 또는 `ls contracts/api/ contracts/db/` 로 먼저 확인할 것.
  
  입력 (요약은 inline 주입 · 전문은 lazy read):
  - 사이클 요약 (단계 1.5 `DRIFT`, inline): failures / verification_summary / decisions_to_record
    → done task의 status.json은 이 요약에 이미 반영됨. **개별 status.json 전량 read 금지.**
  - PROGRESS.md
  - 워커 보고서 report.md — **lazy**: `FAILURES`에 든 task + ADR 승격을 실제로 논할 task만 `.pact/runs/<id>/report.md`를 그때 read. N개 전문 통째 로드 금지.
  - standalone `pact merge` 경로(단계 1.6에서 STANDALONE_MERGE=1)면 요약 3필드가 없으니, 필요한 task의 status.json(소용량)으로 폴백. report.md 게이트·lazy 기준은 동일.
  - .pact/merge-result.json — 요약은 위에 inline됨. merged/conflicted/rejected 카운트가 더 필요하면 이 단일 파일만 read (소용량 SOT).
  - 단계 1.5의 CODE_CHANGED / DOCS_CHANGED 목록
  
  출력은 채팅 prose로:
  
  📝 Cycle <N> 회고
  
  ### 잘 된 부분
  - <bullet>
  
  ### 안 된 부분
  - <bullet> — 원인 추정: <설명>
  
  ### Docs Drift (마지막 머지 이후)
  - <코드 파일>: 대응 contracts/PROGRESS 갱신 누락 — <갱신 권장 경로>
  (없으면 "표류 없음")
  
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
