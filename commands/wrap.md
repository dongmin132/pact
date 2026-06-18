---
description: pact drive 후 1턴 문서 갱신 — merge-result.json(결정적)을 읽어 PROGRESS.md/DECISIONS.md 서사만 갱신 (drive는 0토큰 grind, 기록은 LLM 1턴)
---

`/pact:wrap` 실행됨. `pact drive`(헤드리스, 오케스트레이터 0토큰)는 머지·status.json·report.md·merge-result.json까지 **결정적으로** 남기지만 PROGRESS.md/DECISIONS.md **서사 갱신은 안 한다**(LLM 판단이라). 이 스킬이 그 1턴을 담당 — `/pact:parallel` 단계 7 coordinator와 같은 포맷·같은 결과. 모든 안내는 한국어.

> 철학: 결정적 작업(머지·사실 기록)은 이미 CLI가 끝냄. 이 스킬은 **판단(서사 rollup)만** = "결정적=CLI, 판단=LLM". drive·parallel 둘 다 기록을 남기게 만드는 마지막 조각.

## 입력 (결정적 — read만, 토큰 최소)

```bash
cat .pact/merge-result.json
```

키: `merged[]` · `rejected[]{task_id,reason}` · `conflicted` · `failures[]{task_id,status,blockers}` · `verification_summary{lint,typecheck,test,build}` · `decisions_to_record[]{task_id,topic,choice,rationale}` · `status_updates`.

- 파일 없음 → "직전 cycle 산출물 없음. `pact drive` 또는 `pact run-cycle collect` 먼저 실행." 종료.
- 머지된 task의 서사가 더 필요하면 **그 task만** `cat .pact/runs/<id>/report.md` (lazy — 전부 읽지 말 것).

## 단계 1: PROGRESS.md 갱신

`PROGRESS.md`를 read 후 **해당 섹션만** 교체/추가 (없으면 생성). 기존 내용 보존.
- **Recently Done**: `merged` 각 task_id + title 한 줄 요약(report.md에서). 날짜 포함.
- **Blocked / Waiting**: `failures` + `rejected` → task_id별 사유(blockers/reason) 한 줄씩.
- **Verification Snapshot**: `verification_summary` 그대로 (lint/typecheck/test/build).

사실 위주로 짧게. 서사를 길게 늘이지 말 것.

## 단계 2: DECISIONS.md 누적 (자동 제안까지만 — 5철학 #5)

`decisions_to_record`가 비어있지 않으면 `DECISIONS.md`에 **후보로** append:
- 각 항목 → `### (후보) <task_id> — <topic>` + `choice` / `rationale`.
- **확정 X**: "사용자 승인 후 ADR 번호 부여" 명시. 자동 반영 안 함.
- 빈 배열이면 이 단계 건너뜀.

## 단계 3: 보고 (한국어)

`✅ 문서 갱신 — PROGRESS(Recently Done <N> · Blocked <M>) · DECISIONS 후보 <K>건.`
- `conflicted` 있으면: `⚠️ 충돌 <task_id> — /pact:resolve-conflict` 한 줄.
- `failures` 있으면: task_id별 status·blockers 요약.

## 안 하는 것

- ❌ merge-result.json 외 큰 SOT 통째 read (필요한 `report.md`만 lazy)
- ❌ DECISIONS 자동 **확정** — 후보까지만 (사용자 승인 후 fix task)
- ❌ 코드·머지·git 손대기 — 이 스킬은 **문서 전용**
- ❌ blocked/실패 task를 임의로 done 처리
- ❌ verify fail/충돌을 임의 우회 — 사실 그대로 기록만
