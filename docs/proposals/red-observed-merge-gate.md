# 제안: red_observed 머지 게이트 (TDD 증거 강제)

> **상태: 옵션 B 채택 (2026-07-14, 사용자 결정) — ADR-058로 기록·구현 완료.**
> `planMerge`가 `tdd:true`+`red_observed!==true`를 `tdd_warnings`로 가시화(머지는 진행).
> `pact merge` 출력·merge-result.json·collect/collect-one emit에 노출. 아래는 결정 당시 원문.

## 배경 (현재 동작)

merge 게이트(`bin/cmds/merge.js`)는 `.pact/runs/<id>/status.json`을 다음 순서로 검사한다:

1. status.json 존재·파싱·**스키마 검증**(`validate-mini.js`)
2. `status === "done"`
3. `clean_for_merge === true`
4. `files_attempted_outside_scope` 비어있음 *(자기 보고)*
5. `verify_results`에 `fail` 없음 *(자기 보고)*
6. payload.json 존재
7. **git diff가 allowed_paths 안** *(git 현실로 교차검증 — "워커 자기 보고와 무관")*
8. `files_changed` 보고 == 실제 diff *(git 현실로 교차검증)*
9. report.md 존재 + 최소 10줄

핵심 설계: 게이트는 **자기 보고를 git 현실로 교차검증**한다(7·8번). git으로 확인 가능한 건 확인한다.

`tdd_evidence: {red_observed, green_observed}`는 워커가 status.json에 보고하고 **스키마 검증까지 받지만**(`validate-mini.js`가 boolean 타입 강제), **merge 게이트는 이 값을 전혀 게이팅하지 않는다.**

## 문제

TDD가 머지 시점엔 **명예 규칙(honor system)**이다. `tdd: true`인 task가 `red_observed: false`(=테스트가 먼저 실패하는 걸 관측한 적 없음)로도 머지된다. RED→GREEN을 건너뛰고 구현 후 테스트를 맞춰 쓴 것과 게이트가 구분하지 못한다.

이는 두 원칙과 긴장한다:
- 철학 **"검증 없이 병합하지 않는다"** — TDD 증거는 검증의 일부인데 게이트가 안 본다.
- `pact testguard`의 **"test-as-law"** 정신 — 테스트가 법이면, 테스트가 실제로 먼저 실패했는지도 법이어야 일관적.

## 크럭스 (왜 미결정인가)

`red_observed`는 **순수 자기 보고**다. allowed_paths(7번)나 files_changed(8번)와 달리 **git으로 교차검증할 corroboration이 없다.** 워커가 `red_observed: true`라고 쓰면 게이트는 그걸 반증할 수단이 없다.

→ **hard reject 게이트는 theater가 될 수 있다.** 강제해도 워커가 `true`로 보고하면 통과하므로, 규율을 실제로 강제하는 게 아니라 "true라고 쓰게" 강제할 뿐이다. 이게 이 항목이 지금까지 미결정인 근본 이유다.

## 옵션

**A. 현행 유지** — 자기 보고만, 게이트 X. (지금 상태)
   - +: 단순, theater 없음. −: TDD가 머지 시점에 명예 규칙.

**B. Soft 경고 게이트 (propose-only)** — `tdd: true`인데 `red_observed !== true`면 merge 출력에 **경고**(reject 아님, 머지는 진행).
   - +: 철학 #5("자동 반영 X, 제안까지")와 정합. testguard/scopecheck/prelude와 **같은 propose-only 톤**. theater 회피(강제 아님). 워커·사람에게 "RED 증거 없음" 가시화.
   - −: 강제력 없음(경고 무시 가능).

**C. Hard reject 게이트** — `tdd: true` + `red_observed !== true` → merge reject.
   - +: TDD 증거를 법으로. −: **self-report라 theater** — 실익 < 리스크(정직한 워커만 막고, 대충 쓰는 워커는 `true`로 우회). RED 증거 없는 정당한 케이스(회귀 테스트가 이미 GREEN 등)도 오차단.

**D. 검증 가능 게이트** — 워커가 RED를 **관측 가능한 증거**로 남기고(실패 테스트 실행 로그/RED 커밋 SHA) 게이트가 그걸 확인.
   - +: 진짜 강제(theater 아님). loop-until-dry의 `measureCount`처럼 **결정적 관측** 원칙과 일관. −: 구현 비용 큼(워커 프로토콜 + 게이트 확인 로직). **v1.0 scope 초과 가능성**(TDD 러너별 RED 캡처 표준화 필요).

## 권고

**B(soft 경고 게이트)를 기본 채택** 권고:
- 철학 #5(propose-only)와 정합하고, self-report theater(C)를 피하며, testguard·scopecheck·prelude와 같은 "제안까지만" 패밀리 톤을 유지한다.
- 강제가 아니라 **가시화**가 현 단계의 올바른 레버 — red_observed 공백을 merge 출력과 스코어카드(`pact metrics`)에 드러내 사람이 판단하게 한다.
- D(검증 가능)는 이상적 종착지지만 v1.0 scope를 넘을 수 있으므로 별도 검토(ADR + 비용 산정) 후에. C(hard)는 self-report 한계로 비권장.

## 열린 질문 (사용자 결정 필요)

1. B(soft 경고)로 갈지, A(현행 유지)로 둘지, 아니면 D(검증 가능)를 v1.x 과제로 올릴지.
2. B 채택 시 경고 노출 위치: merge 출력만 vs `pact metrics` 스코어카드에도 "TDD 증거 없는 done N건" 지표 추가.
3. `green_observed`도 같은 취급인지(보통 verify_results가 GREEN을 이미 교차검증하므로 red_observed만으로 충분할 수 있음).

## 결정

미결정. B 채택 시 `bin/cmds/merge.js`에 reject 아닌 `warnings[]` 채널 추가 + ADR-058 기록. 결정 전까지 현행(A) 유지.
