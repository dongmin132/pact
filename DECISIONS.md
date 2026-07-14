# DECISIONS — pact 빌드 중 발견·결정 누적

> ARCHITECTURE.md는 빌드 시작 시점의 설계 기록.
> 빌드 진행하며 발견되는 spec 제약·환경 사실·정책 변경은 여기에 ADR 형식으로 누적.
> 형식: ADR (Architecture Decision Record).

---

## ADR-058 — red_observed soft 경고 게이트 (옵션 B, hard reject 아님)

- **상태**: 채택
- **날짜**: 2026-07-14
- **출처**: docs/proposals/red-observed-merge-gate.md (사용자 옵션 B 채택)
- **관련**: ADR-012(워커 자기보고 불신), 철학 #3(검증 없이 병합 X), 철학 #5(자동 반영 X, 제안까지)

### 발견 / 배경

merge 게이트는 자기 보고를 git 현실로 교차검증한다(allowed_paths·files_changed). 그러나 `tdd_evidence.red_observed`는 스키마 검증만 받고 게이팅되지 않아 TDD가 머지 시점엔 명예 규칙이었다. 크럭스: red_observed는 **순수 자기보고**라 git으로 반증할 corroboration이 없다 → hard reject는 theater(정직한 워커만 막고, 대충 쓰는 워커는 `true`로 우회. 회귀 테스트가 이미 GREEN인 정당한 케이스도 오차단).

### 결정

**Soft 경고 게이트(propose-only)**: `tdd: true`인데 `red_observed !== true`면 `planMerge`가 `tdd_warnings`로 가시화하고 **머지는 진행**한다. `pact merge` 출력·`merge-result.json`·collect/collect-one emit에 노출. testguard/scopecheck/prelude와 같은 propose-only 패밀리 톤.

### 트레이드오프

- 강제력 없음(경고 무시 가능) ↔ theater 회피 + 철학 #5 정합. D(검증 가능 게이트 — RED 실행 로그/커밋 SHA 확인)는 이상적 종착지지만 v1.0 scope 초과라 별도 검토.

---

## ADR-057 — loop-until-dry: 측정된 진행 중에만 자동 재투입

- **상태**: 채택
- **날짜**: 2026-06-17
- **출처**: bulk cleanup 질식 반복 (CLEANUP-009/026/029), docs/proposals/loop-until-dry.md
- **관련**: ADR-012(워커 자기보고 불신), headless-driver

### 발견 / 배경

대량 기계적 정리 task에서 워커가 예산/턴 소진으로 절반만 하고 멈추는 질식 반복. 진짜 제약은 컨텍스트 윈도우가 아니라 턴/예산. 현 드라이버는 incomplete를 즉시 escalate. f5b2350(중간 커밋 강제)로 부분작업이 보존되므로 fresh 워커가 이어받으면 새 진행을 만든다.

### 결정

`loop_until.count`(stdout=남은 개수) 신호가 **엄격히 감소하는 동안에만** fresh 워커를 자동 재투입. 정체(cur ≥ prev)·max_iterations·budget 초과·측정 불가 시 즉시 사람 위임. done/progress는 워커 보고가 아니라 결정적 측정(measureCount)으로만 판정(ADR-012 정렬). 머지 게이트·verify는 우회 안 함. "자동 루프 금지"(2회 실패 위임)는 *실패 시 무한 재시도* 금지를 뜻하며, 측정된 단조 진행은 그 예외.

### 트레이드오프

- ✅ 질식 클래스 제거(각 iteration fresh 컨텍스트)
- ✅ 엄격 감소=무한루프 수학적 차단(+max_iterations+budget 백스톱)
- ✅ 드라이버 전용, /pact:parallel 무손상
- ❌ opt-in 측정 신호 필요(의도된 범위)
- ❌ 측정 명령 오작성 시 오판 → 측정 불가는 즉시 위임으로 방어

---

## ADR-027 — worker prompt에 `decisions` 형식 예시 + reject 메시지에 schema path + worker self-validate CLI

- **상태**: 채택
- **날짜**: 2026-06-01
- **출처**: GitHub issue #3 — brewdy cycle 3·4 worker decisions schema 위반 5건 누적
- **관련**: ADR-026 (required 완화), v0.8.1

### 발견 / 배경

v0.8.0 ADR-026이 schema 수용 폭을 넓혔지만 `decisions` 배열 item 형식 (`{topic, choice, rationale}`) 안내가 worker prompt 어디에도 없음. brewdy CLEANUP-003~006 + INFRA-111 5건이 `string[]` 패턴으로 작성 → merge gate reject (메시지 `must be object` 5번 반복) → worker self-correct 정보 없음 → 메인 수동 정규화 반복.

### 결정

3가지 보완 동시 적용:

1. **prompt에 형식 예시** (P0) — `prompts/worker-system.md`에 OK/금지 대조 yaml 1블록.
2. **reject 메시지 schema path 노출** (P1) — `validate-mini.js`에 받은 타입 명시 + `merge.js` reason에 `instancePath` 포함.
3. **worker self-validate CLI** (P2) — `pact validate-status <path>` 신규. worker가 status.json 작성 직후 호출 강력 권장. exit 3이면 위반 — 즉시 수정 후 종료.

### 트레이드오프

- ✅ 5건 패턴 즉시 차단 (P0 단독으로도 효과)
- ✅ 디버깅 시간 단축 (P1)
- ✅ 메인 fallback 호출 자체 제거 가능 (P2)
- ❌ `pact validate-status`는 강제 X 권장 — 워커가 안 부르면 효과 X. 의도적: 호출 강제는 worker harness 침범, 안내로만.

---

## ADR-026 — `status.json` schema 진화 시 required 완화 정책 (backward-compat)

- **상태**: 채택
- **날짜**: 2026-06-01
- **출처**: brewdy cycle 3 회고 (GitHub issue #1, brewdy ADR-056 매핑)
- **관련**: ARCHITECTURE.md L371 (schema_version X 룰 유지), v0.8.0

### 발견 / 배경

brewdy 운영 중 MANNER-101 (cycle 1.5 시점) 워커의 `status.json`이 `files_attempted_outside_scope`/`tdd_evidence`/`completed_at` 누락으로 merge gate에서 reject. schema 진화 시 구버전 워커 산출물과 호환 안 됨.

### 결정

**필수 필드 2개로 축소**: `task_id`, `status`만 required. 나머지는 optional.
누락된 필드는 merge gate가 안전 default (`|| []`, `|| {}`) 또는 명시 reject (예: `files_changed` 누락 시 git diff 대조 불가 사유로 reject)로 분기 처리.

`schema_version` 필드 도입 X — ARCHITECTURE.md L371 룰 ("archive·schema_version·frontmatter 모두 X") 유지.

### 트레이드오프

- ✅ 구워커 산출물 호환 — schema 진화 후에도 reject 노이즈 X
- ✅ schema_version 도입으로 인한 ARCHITECTURE 룰 충돌 회피
- ❌ 신규 워커가 필드 생략하기 쉬워짐 — `agents/worker.md`의 작성 지시로 보강
- ❌ schema 자체로는 약해짐 — merge gate가 사실상 강한 검증층

---

## ADR-025 — 워커 spec `yolo_mode + 빈 forbidden_paths` 조합 거부

- **상태**: 채택
- **날짜**: 2026-06-01
- **출처**: brewdy cycle 2 spec drift 4건 (PROFILE-107/SETTINGS-104/PROFILE-108/MEETUP-107, brewdy ADR-055 매핑)
- **관련**: ADR-012 (워커 자기 보고 X), v0.8.0

### 발견 / 배경

`yolo_mode: true` + `forbidden_paths: []` 조합에서 워커가 `allowed_paths`를 "권고"로 해석. yolo에서 permission prompt가 없으니 워커가 통과 — `prompts/worker-system.md`의 `{{forbidden_paths}}` 섹션이 비어 있어 "금지 경로 없음"으로 해석됨.

### 결정

`scripts/spawn-worker.js` `validatePayload()`에서 `yolo_mode === true`일 때 `forbidden_paths`가 누락이거나 빈 배열이면 거부. deny-all 의도면 `["**/*"]` 명시 강제.
`prompts/worker-system.md`의 forbidden 섹션에 "위 목록이 비어있더라도 allowed_paths 외 모든 경로는 자동 금지 (deny-all)" 명시.

### 트레이드오프

- ✅ spec drift 자동 차단 — yolo에서도 spawn 단계에서 reject
- ✅ 사용자에게 forbidden_paths 의도를 명시하게 강제 (deny-all vs explicit)
- ❌ batch-builder.js 측 default 처리는 별도 PR (보수적)

---

## ADR-024 — 워커 fallback 정책 명문화 (4종 시나리오)

- **상태**: 채택
- **날짜**: 2026-06-01
- **출처**: brewdy cycle 2~3 워커 fallback 2회 + decisions schema 위반 4건 (brewdy ADR-053 매핑)
- **관련**: ADR-012, v0.8.0

### 발견 / 배경

워커 fallback 시 메인이 매번 임시방편으로 status/commit/report/decisions 보정. 어떤 fallback이 안전하고 어떤 것이 사용자 결정 필요인지 일관성 없음.

### 결정

`commands/parallel.md` 단계 5.5에 "워커 실패 시 메인 fallback (4종)" 섹션 신설:

1. **status.json 미작성** — 메인이 worktree git/typecheck 결과로 작성, `verify_results`는 실측 가능 항목만
2. **commit 누락 + worktree 변경** — 메인이 worktree에서 salvage commit (`pact: salvage <id> (worker incomplete)`)
3. **report.md 미작성** — 메인이 워커 산출물 기반 작성, "워커 의도 추정" 명시
4. **decisions schema 위반** — 메인 정규화 + 원본 `decisions.raw.json` 보존

위 4종 외(`ownership 위반`, `verify fail`, `git diff에 allowed_paths 외 파일`)는 **메인 임의 우회 X** — 사용자 결정 필요. 같은 task 2회 fallback 실패 시 사용자 위임.

`agents/coordinator.md`에도 분류 테이블에 fallback 매핑 짧게 명시.

### 트레이드오프

- ✅ 메인 워크플로우 prompt 일관성 — 임시방편 의사결정 0
- ✅ 4종 외 사유는 명시적으로 사용자 결정 → silent recover 방지
- ❌ 문서 only — 자동화 X (v1.0 원칙 #5: 자동 제안만)

---

## ADR-023 — `report.md` 작성 강제 (merge gate, 비공백 10줄)

- **상태**: 채택
- **날짜**: 2026-06-01
- **출처**: brewdy cycle 2_batch_12~14 작성률 5/12 (brewdy ADR-049 매핑)
- **관련**: ADR-012, v0.8.0

### 발견 / 배경

`status.json`은 게이트라 100% 작성되지만 `report.md`는 선택적 산출물로 인식돼 5/12 작성률. 회고/coordinator 통합 시 워커 의도·결정·trade-off 추적 불가.

### 결정

`bin/cmds/merge.js` `planMerge()` 게이트에 `report.md` **파일 존재 + 비공백 10줄 이상** 검증 추가. 위반 시 `rejected.reason: "report.md missing"` 또는 `"too short"`로 reject. status.json self-report에 의존 X — ADR-012 정신 (워커 자기 보고 X, 외부 사실 검증) 유지.

`agents/worker.md` 종료 의무 §4에 작성 강제 + 비공백 10줄 기준 명시. `prompts/worker-system.md` 변수 표에는 자연스럽게 노출 중.

### 트레이드오프

- ✅ 회고·coordinator 입력 품질 — 의사결정 추적 가능
- ✅ 자기 보고 X — 파일 시스템 사실로만 게이트
- ❌ 워커 부담 증가 — 짧은 task도 10줄 보고 — `report.md` 가이드 5섹션으로 자연 채워짐 (무엇/왜/문제/결정/메인 알릴 것)
- ❌ 기존 cycle 산출물 호환 X — fallback (ADR-024 #3)으로 메인이 작성

---

## ADR-022 — `pact run-cycle collect`에서 task `status:done` 자동 sync

- **상태**: 채택
- **날짜**: 2026-06-01
- **출처**: brewdy cycle 2~3 매 머지 후 메인 수동 patch, rejected 102건 중 94건 원인 (brewdy ADR-048 매핑)
- **관련**: v0.8.0

### 발견 / 배경

`bin/cmds/merge.js`의 `executeMerge`는 머지 성공 시 `setTaskStatus(id, 'done')`로 source frontmatter에 박지만, **`bin/cmds/run-cycle.js`의 `doCollect`는 같은 sync 누락**. `run-cycle collect` 경로(= `/pact:parallel` 표준 흐름)로 진입 시 머지 끝나도 task가 `status: in_progress`인 채로 남음 → 다음 cycle의 `prepare`가 같은 task id를 또 batch 후보로 잡음 → batch-builder가 같은 spec으로 worker 또 spawn → 다음 머지에서 빈 diff로 reject 누적.

### 결정

`doCollect` 안에서 `result.merged` 순회하면서 `setTaskStatus(id, 'done', { cwd })` 호출. `merge-result.json`과 `emit` 양쪽에 `status_updates: [{task_id, ok, action, file, error}]` 포함.

### 트레이드오프

- ✅ 메인 수동 sync 절감 — cycle당 ~30분 누적 최대 ROI
- ✅ merge gate alert fatigue 해소 (rejected 노이즈 감소)
- ✅ 기존 `executeMerge` 경로와 일관 — 두 경로 모두 동일하게 박힘
- ❌ 없음 (executeMerge가 이미 검증된 로직)

---

## ADR-021 — 멀티세션 자유 수정 안전망 (edit-lock)

- **상태**: 채택
- **날짜**: 2026-05-15
- **출처**: dogfooding — 사이클 끝난 후 멀티세션 자유 수정 시 race 우려
- **관련**: ADR-020 (멀티세션 sibling), v0.7.0

### 발견 / 배경

v0.6.0~0.6.2로 빌드 단계 멀티세션은 안전(task lock + 분담 모드). 그러나 사이클 끝나고 사용자가 코드·contracts·PROGRESS 자유 수정할 때 멀티세션이면 race 가능:

- 같은 파일 동시 write → 마지막이 이김
- PROGRESS/DECISIONS 글로벌 md 동시 갱신 → 한쪽 손실
- 같은 모듈 코드 + contracts shard 동시 손대면 일관성 깨짐

운영 규율("모듈별 분담")로 피할 수도 있지만 사람 실수에 의존.

### 결정

**모듈/파일 edit-lock + pre-tool-guard 차단**으로 자동 안전망.

#### `acquireEditLock(target)` — target 두 종류

1. **모듈 이름** (예: `auth`): 그 도메인의 모든 파일 묶음 lock
   - `contracts/modules/auth.md`의 `owner_paths`
   - `contracts/api|db/auth.md`, `contracts/modules/auth.md`, `tasks/auth.md`
2. **파일 경로** (예: `PROGRESS.md`): 단일 파일 lock — 글로벌 md 보호용

#### pre-tool-guard 검사 흐름

```
Write/Edit/MultiEdit 요청 → 파일 경로 추출
  → findLockForFile(경로) — 잡힌 lock 중 매칭 검사
  → hit 있고 session_label != 내 세션이면 차단
  → hit 있고 같은 session이면 통과 (자기 작업)
  → hit 없으면 기존 ownership 검사로 fallthrough
```

### 트레이드오프

- ❌ 사용자가 명시적 lock 호출해야 작동 — 자동 안전망이지만 opt-in
- ❌ 모듈 정의 미흡(`contracts/modules/<m>.md` 없음) 시 lock 대상 paths 불완전 — fallback shard 매핑으로 일부 보강
- ❌ 명령 추가(`edit-lock`/`edit-release`) — 사용자 부담 일부 증가
- ✅ race 자동 차단, 운영 규율 의존 X
- ✅ 모듈 단위 묶음 — 코드·계약·task가 자연 일치
- ✅ 글로벌 md(PROGRESS·DECISIONS)도 같은 명령으로 보호
- ✅ stale takeover, SessionStart hook의 자동 정리와 일관

### 사용 패턴

```
세션 A: pact edit-lock auth --session a
        # 자유 수정
        pact edit-release auth --session a  → drift 알림

세션 B: pact edit-lock payment --session b  → OK (다른 모듈)
세션 C: pact edit-lock PROGRESS.md --session c  → OK (글로벌 md)
```

---

## ADR-020 — 멀티세션 sibling 패턴 (sub-agent 패턴과 공존)

- **상태**: 채택
- **날짜**: 2026-05-13
- **출처**: dogfooding — 사용자가 cmux로 여러 세션 동시에 굴리고 싶다는 요청
- **관련**: ARCHITECTURE.md §4 (워커), v0.6.0

### 발견 / 배경

기존 워커는 Task tool로 spawn된 sub-agent(부모 conversation의 자식). v0.4.1 run-cycle CLI로 메인 turn 95→5 압축해 cache_read -94% 달성했지만, 워커 결과가 부모 컨텍스트에 누적되는 구조 자체는 그대로. 진정한 "메인 컨텍스트 누수 0" 달성 불가.

사용자가 cmux/tmux로 N개 Claude Code 세션 동시 띄우면 OS 프로세스 수준 격리 → 메인 누수 진짜 0. 그러나 그러려면:

1. 같은 task를 두 세션이 잡지 못하게 막을 메커니즘 (lock)
2. 미점유 task 찾기 helper
3. 세션 간 진행 가시성 (메인이 polling)
4. 비정상 종료 시 lock 청소

### 결정

멀티세션 모드를 **sub-agent 패턴과 공존**하는 형태로 추가 (대체 X).

| | sub-agent (기존, default) | 멀티세션 (이번 추가) |
|---|---|---|
| spawn | Task tool | OS 프로세스 |
| 트리거 | `/pact:parallel` | `pact claim` + 사용자가 새 `claude` 세션 |
| 메인 누수 | 일부 누적 (v0.4.1 후 5%) | 0 |
| 관측성 | 메인 turn마다 통합 | `pact status --watch` 폴링 |
| 인터랙션 | 메인이 게이트 | 각 세션 자율 (yolo 권장) |

추가 산출물:
- `scripts/lock.js` — `.pact/runs/<id>/lock.pid` 기반 점유. acquire/release/stale takeover/list/cleanStale.
- `pact claim <task_id>` — 명시적 점유.
- `pact next` — 미점유 task 추천.
- `pact status --watch` — 주기 폴링 모니터.
- `commands/multi-session.md` — 사용자 가이드.
- `session-start` / `progress-check` hook에 `cleanStaleLocks` 호출 추가.

### 트레이드오프

- ❌ 통합 관측성 ↓ — 메인이 한눈에 진행 보려면 `pact status --watch` 별도 호출 필요
- ❌ 인터랙션 게이트 깨짐 — 워커 도중 사용자에게 묻는 패턴 사실상 불가, yolo 또는 명확한 done_criteria 필수
- ❌ 사용자 인지 부담 — N개 세션 띄우고 종료까지 챙기는 흐름. cmux/tmux 같은 도구 필요
- ❌ Claude Code CLI headless 모드 정식 지원 시 자동화 가능, 현재는 수동 시작
- ✅ **메인 컨텍스트 누수 0** — sub-agent 패턴 한계 돌파
- ✅ 진짜 OS 동시성 — Anthropic API 호출 N개 시작 즉시 보장
- ✅ 각 세션이 독립 hooks·독립 모델 가능 (실험 자유)
- ✅ sub-agent 패턴 그대로 작동 — Breaking change 0

PID 재사용 위험: macOS/Linux에서 PID 재활용은 짧은 시간 내엔 드물지만 이론적 가능. 락 파일에 `acquired_at`도 박아 향후 "오래된 stale" 보강 가능. v0.6.0은 isAlive 단일 검사로 시작.

---

## ADR-019 — 매니저·워커 모델 차등 (ADR-004 supersede)

- **상태**: 채택 (ADR-004 폐기)
- **날짜**: 2026-05-09
- **출처**: dogfooding 비용 분석 + v0.4.1 책임 재분배
- **관련**: ARCHITECTURE.md §3 (매니저), §4 (워커), ADR-009 (coordinator 책임 축소), ADR-004 (폐기)

### 발견 / 배경

ADR-004는 "모든 매니저·워커 `model: inherit`"로 채택했다. 메인 모델 단일 변수로 비용·품질 제어. 그러나 v0.4.1 시점에 전제가 바뀜:

1. **ADR-009 coordinator 책임 축소** (30k → 15k 토큰 예산). 결정적 작업이 `pact batch`/`pact merge`로 빠짐.
2. **v0.4.1 `pact run-cycle prepare/collect`**. 사전검사·worktree·payload·머지·cleanup이 CLI로 응집. 매니저는 "판단"만 남음. 즉 매니저별 판단의 무게가 명확히 차등화됨.
3. **dogfooding 결과**: planner/architect는 사이클당 1회·첫 단추. coordinator는 사이클당 2회·통합 작업. reviewer-task는 메타 분류. 모두 같은 모델로 굴리면 ROI가 안 맞음.

또한 실제 frontmatter는 이미 `inherit`이 아니라 `opus`/`sonnet` 명시 상태로 표류. ADR-004와 코드가 어긋남 → 사실 일치 필요.

### 결정

매니저·워커별 모델을 frontmatter에 **명시**하고 차등 채택.

| agent | 모델 | 근거 |
|---|---|---|
| `planner` | opus | 첫 단추. 잘못되면 워커 N명 재작업. 사이클당 1회로 비용 부담 적음. PRD 흡수에 1M 컨텍스트 가치. |
| `architect` | opus | 계약 정의. 잘못되면 워커 N명 재작업. 사이클당 1회. cycle 검증·TBD 해소에 추론 가치 큼. |
| `coordinator` | **sonnet** (← opus) | ADR-009로 책임 축소. 배치 의도 검토 + status 통합은 Sonnet으로 충분. 사이클당 2회 + opus 가격 → 절감 ROI 1순위. |
| `reviewer-arch` | opus | 아키텍처 정합성·계약 cycle 검증. 사용자 명시 호출이라 빈도 낮음. |
| `reviewer-code` | sonnet | 4축 검증은 도구 실행 위주. |
| `reviewer-task` | **haiku** (← sonnet) | 메타 분류 (크기·done_criteria 체크리스트). 실패 위험 낮음. |
| `reviewer-ui` | sonnet | 코드/마크업 검토. 시각적 판단 X. |
| `worker` | sonnet | TDD evidence 정확성 + 코드 품질 필요. N개 병렬이라 비용 민감하지만 haiku는 위험 (재시도 비용이 더 큼). |

워커 spawn 시 `Task` tool의 `model` 파라미터는 frontmatter 값을 그대로 사용 (생략 X).

### 트레이드오프

- ❌ 사용자가 메인을 swap해도 매니저·워커는 frontmatter 값으로 고정 (단일 변수 통제 불가)
- ❌ 모델 ID/네이밍 변경 시 8개 파일 일괄 수정 필요
- ✅ ROI 정렬 — 비싼 모델은 첫 단추(planner/architect)에만, 메타·통합 작업은 저렴한 모델
- ✅ ADR-004와 코드의 표류 정리 — 사실 일치
- ✅ v0.4.1 책임 분배(LLM=판단, CLI=결정적 작업)에 맞게 차등화

### 기대 효과

대략 사이클당 비용 ~10~20% 절감 (워커 비용이 베이스 가장 큼). 가장 큰 lever는 coordinator opus→sonnet.

### ADR-004 (폐기) 요약

> "모든 매니저·워커 `model: inherit`"

전제: 단일 변수 통제가 사용자 친화. 폐기 사유: v0.4.1 책임 분배 후 매니저별 작업 무게 차이가 커짐. 차등 모델이 ROI 명확.

---

## ADR-015 — Context-light SOT: 문서는 shard로 보관하고 필요한 섹션만 읽는다

- **상태**: 채택
- **날짜**: 2026-05-03
- **출처**: 실제 dogfooding 중 `/pact:contracts`, `/pact:plan-*-review`가 20분 이상 걸리는 병목
- **관련**: 토큰 효율 4원칙 #2, #3

### 발견 / 배경

긴 `TASKS.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`, PRD를 manager/reviewer가 통째로 읽으면 한 명령이 20분 이상 걸린다. 기존 `pact slice`가 있어도 SOT 구조와 명령 지침이 단일 긴 파일 중심이면 agent가 전체 문서를 읽는 경향이 남는다.

### 결정

문서는 SOT로 보관하되 기본 컨텍스트에서 제외한다.

1. `docs/context-map.md`를 read profile index로 둔다.
2. task SOT는 `tasks/<domain>.md` shard로 나눈다. `TASKS.md`는 legacy/index다.
3. API contract SOT는 `contracts/api/<domain>.md`, DB contract SOT는 `contracts/db/<domain>.md` shard로 둔다.
4. `contracts/manifest.md`는 domain → shard 경로만 기록한다.
5. task yaml에 `context_refs`를 넣어 architect/reviewer/worker가 읽을 shard를 직접 가리킨다.
6. `pact batch`와 `pact slice`는 `tasks/*.md`가 있으면 이를 기본 task source로 사용한다.

### 트레이드오프

- ❌ 파일 수 증가, domain 이름 관리 필요
- ❌ 기존 단일 파일 mental model보다 초기 학습 비용 있음
- ✅ `/pact:contracts`와 review 계열이 전체 SOT 대신 관련 task/contract shard만 읽음
- ✅ worker payload가 `context_refs`로 더 작아짐
- ✅ 긴 문서는 보존하되 컨텍스트 비용을 명령별로 통제 가능

### 후속

- `.pact/runs/<task_id>/context.md` bundle 생성은 ADR-016에서 채택.
- Read hook으로 긴 파일 전체 read 경고를 추가할 수 있음.

---

## ADR-016 — Worker context bundle 생성

- **상태**: 채택
- **날짜**: 2026-05-03
- **출처**: ADR-015 후속. worker/reviewer가 context_refs를 다시 찾아 읽는 비용 제거
- **관련**: ADR-015, prompts/worker-system.md, scripts/spawn-worker.js

### 발견 / 배경

`docs/context-map.md`와 `context_refs`만으로도 전체 문서 read는 줄지만, 워커는 여전히 참조 파일을 열고 섹션을 찾는 작업을 반복한다. 병렬 worker가 많아질수록 같은 shard 검색 비용이 중복된다.

### 결정

`prepareWorkerSpawn` 시점에 `.pact/runs/<task_id>/context.md`를 생성한다.

포함 내용:

1. task payload 핵심 필드
2. `context_refs` 목록
3. 각 context ref의 anchor section slice

워커 prompt는 긴 SOT 대신 이 `context.md`를 먼저 읽도록 한다.

### 트레이드오프

- ❌ context bundle이 생성 시점 snapshot이라 contract shard가 이후 바뀌면 stale 가능
- ❌ anchor naming이 부정확하면 해당 slice가 누락될 수 있음
- ✅ worker가 긴 문서와 contract shard를 직접 찾는 비용 감소
- ✅ `.pact/runs/<task_id>/`에 재현 가능한 task context가 남음
- ✅ 실패 분석 시 payload/status/report/context가 한 폴더에 모임

### 테스트

`test/spawn-worker.test.js`에 context_refs 기반 `context.md` 생성 테스트 추가.

---

## ADR-017 — Legacy long docs split migration

- **상태**: 채택
- **날짜**: 2026-05-03
- **출처**: 기존 프로젝트의 `TASKS.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`가 각각 1,000~2,000줄 이상으로 커지는 문제
- **관련**: ADR-015

### 결정

`pact split-docs` CLI를 추가한다.

동작:

1. `TASKS.md`를 task section 단위로 읽고 domain을 추정해 `tasks/<domain>.md`로 분리
2. `API_CONTRACT.md`를 endpoint section 단위로 읽고 `contracts/api/<domain>.md`로 분리
3. `DB_CONTRACT.md`를 table section 단위로 읽고 `contracts/db/<domain>.md`로 분리
4. `contracts/manifest.md`와 `docs/context-map.md`를 생성/갱신
5. 원본 legacy 파일은 삭제하지 않는다

### 안전 정책

- 기존 shard 파일은 기본적으로 덮어쓰지 않는다.
- `--force`를 명시한 경우에만 overwrite한다.
- `--dry-run`으로 생성 대상만 확인할 수 있다.

### 트레이드오프

- ❌ domain 추정은 완벽하지 않음. path/endpoint/table 이름 기반 보수적 추정
- ❌ split 후 `context_refs` 세밀화는 architect가 보정해야 함
- ✅ 기존 8,000줄급 SOT를 shard 구조로 이전하는 첫 마이그레이션 경로 제공
- ✅ 원본 삭제가 없어 되돌리기 쉬움

### Out of scope (v1.x)

- **PRD 자동 분할** — `split-docs`는 TASKS/API/DB/MODULE_OWNERSHIP만. PRD는 `pact slice-prd` 섹션 lazy-load만 지원하고 자동 shard 분할은 v1.1+. 이유: PRD는 사용자 작성 문서라 자동 도메인 추정의 risk가 계약 문서보다 높음. 도메인별 사전 분할은 사용자 책임.

---

## ADR-018 — MODULE_OWNERSHIP shard화 (계약 일관성)

- **상태**: 채택
- **날짜**: 2026-05-03
- **출처**: ADR-015~017 검토 중 발견. API/DB는 shard로 분리됐는데 ownership만 단일 파일로 남아 일관성 깨짐
- **관련**: ADR-015, ADR-017

### 결정

`MODULE_OWNERSHIP.md`를 `contracts/modules/<domain>.md`로 shard화한다.

1. 각 모듈 yaml block은 자기 domain shard로 이동
2. `contracts/manifest.md`에 Modules 표 추가 (domain → shard 경로)
3. legacy `MODULE_OWNERSHIP.md`는 유지 (호환성). 있으면 우선 read
4. `pact split-docs`가 legacy 파일을 자동으로 shard로 이전
5. `pre-tool-guard` hook과 reviewer는 두 위치 모두 인식 (legacy + shard 합집합)

### 트레이드오프

- ❌ 또 하나의 shard 디렉토리 (`contracts/modules/`)
- ❌ legacy + shard 양쪽 동시 read 로직 필요 (loadAllOwnership 헬퍼)
- ✅ API/DB와 동일 패턴 — 멘탈 모델 일관
- ✅ 큰 프로젝트에서 ownership 한 파일 1000줄+ 방지
- ✅ 도메인 단독 작업 시 ownership shard 하나만 read

---

## ADR-001 — Task tool은 working_dir 강제 불가, post-hoc 검증으로 간다

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-000 (docs/CLAUDE_CODE_SPEC.md §3.4)
- **관련**: ARCHITECTURE.md §4.2, §14.5

### 발견

Claude Code 공식 문서에 Task tool의 `working_dir`/`cwd` 강제 파라미터 명시 없음. 서브에이전트는 부모 cwd 상속이 기본.

### 결정

워커 격리는 **하이브리드**:

1. **사전 유도**: 워커 시스템 프롬프트에 "이 working_dir 안에서만 작업" 박기 + payload에 `working_dir` 필드
2. **사후 게이트**: `pact merge` CLI가 머지 시점에 `git diff`로 worktree 외부 변경 검증, 위반 시 거부

사전 차단(pre-block) X, 사후 게이트(post-gate) O.

### 트레이드오프

- ❌ 워커가 잘못 만든 파일이 worktree 안에 남을 수 있음 — cleanup 필요
- ✅ 진실은 `git diff` — ARCHITECTURE.md §15 #13("채팅 보고만 믿지 말 것") 정신과 일치
- ✅ Task tool spec 변경되면 사전 차단으로 강화 가능 (forward-compat)

---

## ADR-002 — Yolo 모드 자동 감지 불가, 사용자 명시로 받는다

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-000 (docs/CLAUDE_CODE_SPEC.md §4)
- **관련**: ARCHITECTURE.md §19.6

### 발견

`--dangerously-skip-permissions` 활성화 여부를 hook 또는 플러그인 코드에서 감지하는 공식 메커니즘 없음. 환경 변수·hook payload 모두 노출 X.

### 결정

ARCHITECTURE.md §19.6 변경:

- **기존**: yolo 모드 감지 시 첫 게이트에서 한 번만 묻기
- **변경**: `/pact:init` 시점에 사용자가 본인 환경이 yolo인지 명시. CLAUDE.md에 `yolo_mode: true|false` 박힘.

### 트레이드오프

- ❌ 사용자가 거짓말 또는 깜빡하면 정책 작동 안 함
- ✅ 명시적 입력은 추측보다 정확
- ✅ 안티패턴 #11("yolo여도 사용자 의도 추측 X") 정신 그대로

---

## ADR-014 — Reviewer 4 분할 + 8 agent 일괄 polish (gstack 영감)

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: 사용자 토론 (review마다 다른 agent / gstack 패턴 흡수)
- **관련**: ADR-008 (reviewer 3 모드), gstack /plan-eng-review·/plan-design-review

### 발견 / 배경

기존: `agents/reviewer.md` 단일 파일 4 모드 (250줄). 한 파일에 code-review·plan-task·plan-arch·plan-ui 모두.

문제:
- 매 호출마다 4 모드 prompt 전부 컨텍스트에 로드 (낭비)
- 모드별 tools·model·maxTurns 차등 불가
- subagent_type=reviewer + prompt에 mode 박는 우회 패턴

### 결정

**4개 별도 agent로 분할**:
- `agents/reviewer-code.md` — 머지 후 4축 검증
- `agents/reviewer-task.md` — task 분해 품질 (메타)
- `agents/reviewer-arch.md` — 아키텍처 + 계약 정합성 (gstack 영감, WebSearch tool 추가)
- `agents/reviewer-ui.md` — UI 디자인 차원 (gstack 영감)

**전체 8 agent gstack 패턴 polish**:
- planner, architect, coordinator, worker도 동일 구조로 재정리
- 각 agent: 정체성·호출시점·입력·출력·동작 단계·출력예시·금지·의문시·토큰 예산
- Severity·Confidence·Finding 형식 통일
- gstack cognitive pattern (reviewer-arch에 흡수)
- gstack UX 3법칙·Goodwill reservoir (reviewer-ui)
- gstack Step 0 Scope Challenge (reviewer-task·reviewer-arch)
- 명령마다 명확한 subagent_type (`reviewer-arch` 등)

### 트레이드오프

- ❌ agent 파일 수 증가 (5 → 8)
- ❌ 일부 prose 중복 ("절대 안 하는 것" 등)
- ✅ 모드별 컨텍스트 효율 (호출마다 자기 prompt만 로드)
- ✅ tools 차등 가능 (reviewer-arch만 WebSearch)
- ✅ 명확한 subagent_type — Task tool 호출 의도 명시
- ✅ gstack 성숙한 패턴 흡수
- ✅ 8 agent 일관 구조

### 명령 갱신

| 명령 | 새 subagent_type |
|---|---|
| `/pact:verify` | `reviewer-code` |
| `/pact:plan-task-review` | `reviewer-task` |
| `/pact:plan-arch-review` | `reviewer-arch` |
| `/pact:plan-ui-review` | `reviewer-ui` |

테스트 회귀: 133/133 (영향 없음 — agent definition 변경, 코드 인터페이스 동일).

---

## ADR-013 — Zero-dependency 전환 (마켓플레이스 캐시 친화)

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: 사용자 지적 (배포형 캐시 설치 시 npm install 불가)
- **관련**: ARCHITECTURE.md §16, README

### 발견 / 배경

마켓플레이스에서 설치 시 Claude Code는 plugin을 `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`에 clone. 이 디렉토리는:
- 사용자가 자연스럽게 `npm install` 실행하지 않음
- 권한 / 네트워크 / npm 가용성 가정 위험
- `${CLAUDE_PLUGIN_DATA}`도 자동 npm install엔 부적합

기존 deps (`js-yaml`, `ajv`, `ajv-formats`)는 README가 `npm install` 전제로 함 → 분포에 약점.

### 결정

**외부 의존성 0** 전환:

1. `scripts/lib/yaml-mini.js` — 우리 yaml subset에 한정된 파서 (`load`, `parseScalar`)
2. `scripts/lib/validate-mini.js` — `validateStatus`·`validateTask` hand-written
3. `package.json` `dependencies` 모두 제거
4. `node_modules` 제거 (3.4M → 0)

### 트레이드오프

- ❌ yaml-mini 우리 subset만 (anchors·multi-doc·복잡 flow 미지원) — 우리 형식 강제하면 OK
- ❌ validate-mini 하드코딩 (schema 변경 시 코드 수정) — schema 자체가 stable
- ✅ 캐시 설치 zero-friction (`git clone` 후 즉시 작동)
- ✅ npm install·네트워크 불필요
- ✅ 3.4M → 0 (cache 디스크 절약)
- ✅ Node.js 자체만 있으면 됨

### 테스트

133/133 통과 (yaml-mini 11개·validate-status 7개·task-schema 7개 + 기존 회귀 포함).

`schemas/*.json`은 reference·문서로 유지 (사람이 읽기용).

---

## ADR-012 — 워커 자기 보고 신뢰 X, 실제 git diff 대조 강제

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: 사용자 지적 (핵심 약속 빈틈)
- **관련**: ARCHITECTURE.md §15 #13, 5가지 철학 #2·#3

### 발견 / 배경

1. `pact merge`가 워커 status.json의 `files_attempted_outside_scope`만 체크 — 워커 자기 보고에 의존
2. `pre-tool-guard`는 MODULE_OWNERSHIP 전체 영역만 검사 — task별 `allowed_paths` 미강제

→ "계약 없이 병렬화하지 않는다 / 검증 없이 병합하지 않는다" 약속에 직접 닿는 구멍.
워커가 거짓말하거나 실수로 다른 task의 파일을 수정해도 통과 가능했음.

### 결정

#### `pact merge` 강화 (bin/cmds/merge.js)
1. payload.json의 `allowed_paths` 읽기
2. `git diff --name-only <base_branch>...pact/<task_id>` 로 **실제 변경 파일** 산출
3. 실제 변경이 `allowed_paths` 외 → 거부 (워커 보고와 무관)
4. `status.files_changed` ≠ 실제 diff → 거부 (보고 거짓 감지)

#### `pre-tool-guard` 강화 (hooks/pre-tool-guard.js)
워커 컨텍스트(.pact/worktrees/<id>) 안에서:
1. payload.json의 `allowed_paths` 읽기
2. 수정 시도 파일이 task별 `allowed_paths` 외이면 즉시 deny (PreToolUse)
3. `allowed_paths` 매칭되면 통과 (MODULE_OWNERSHIP 검사 스킵 — 더 정확한 contract)

### 트레이드오프

- ❌ payload.json 의존성 — 없으면 검증 불가 → 이 경우도 거부
- ❌ git diff 실패 시(브랜치 누락 등) 거부 — 안전 기본값
- ✅ 워커 거짓 보고 사전·사후 둘 다 차단
- ✅ 5가지 철학(계약·검증) 약속 회복

### 테스트

`test/integration-e2e.test.js`에 새 시나리오 추가:
- 워커가 `unauthorized.ts` commit + status.json은 거짓 보고
- → `pact merge` rejected에 박힘 (`allowed_paths 외|files_changed`)

122/122 통과.

---

## ADR-011 — Yolo 모드 감지 가능 (ADR-002 supersede)

- **상태**: 채택 (ADR-002 폐기)
- **날짜**: 2026-05-02
- **출처**: 공식 hook 문서 — `permission_mode: "bypassPermissions"` 필드 확인
- **관련**: ARCHITECTURE.md §19.6, ADR-002 (폐기)

### 발견 / 배경

PACT-000 시점엔 yolo 모드 자동 감지 불가능으로 판단(ADR-002) → 사용자 명시 정책 채택.
이후 공식 Claude Code hook 문서에서 **hook payload에 `permission_mode` 필드** 명시 확인. 값이 `"bypassPermissions"`면 yolo 모드.

### 결정

자동 감지 활성화:

1. `hooks/session-start.js` — SessionStart 시점에 `permission_mode` 캡처해 `.pact/state.json`에 기록
2. `scripts/detect-yolo.js` — 우선순위 fallback 체인 (payload → state.json → settings.json)
3. `/pact:init` 자동 감지 시도, 실패 시만 사용자에게 묻기

### 트레이드오프

- ❌ ADR-002 폐기 — 두 ADR 비교 필요 (학습용)
- ✅ 더 정확한 yolo 인지 (사용자 거짓·깜빡 방지)
- ✅ `bypassPermissions` 환경에서 SessionStart 즉시 사용자에게 위험 알림 (systemMessage)

### ADR-002 (폐기) 요약

> "yolo 자동 감지 불가, 사용자 명시"

이 결정의 전제(=감지 불가)가 잘못됨. 공식 문서 확인이 부족했음. 학습: spec 변화·신규 필드는 정기 재확인 필요.

---

## ADR-010 — 슬래시 명령 17개로 확장 (ARCHITECTURE §6의 16개에서)

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: 빌드 진행 중 자연스러운 확장
- **관련**: ARCHITECTURE.md §6, ADR-008

### 발견 / 배경

ARCHITECTURE.md §6은 빌드 시작 시점에 16개 명령 명시. 빌드 중 다음 변화 발생:

- `plan-eng-review`·`plan-design-review` 2개 → `plan-task-review`·`plan-arch-review`·`plan-ui-review` 3개 (ADR-008)
- `worktree-cleanup` 1개 → `worktree-status` + `worktree-cleanup` 2개 (PACT-029 분리)
- `merge` 슬래시 명령은 `pact merge` CLI로 옮김 (ARCHITECTURE §15 #14)

순 변화: -1(merge) + 1(plan-review 분리) + 1(worktree-status) = +1 → 16 → 17.

### 결정

README·문서 표기는 실제 17개 그대로. ARCHITECTURE.md §6은 "당시 설계"의 기록이라 수정 X (자기참조 원리: 결정 시점 보존).

### 트레이드오프

- ❌ ARCHITECTURE.md와 실제 표면 영역 미세하게 다름
- ✅ 진화의 흔적 ADR로 추적 가능 (ADR-008·010)

---

## ADR-009 — Contract-First / TDD Guard / Async hooks 도입

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: 시장 조사 (TDD Guard, Contract-First 패턴, Hook async 패턴)
- **관련**: ARCHITECTURE.md §4.3, §7

### 결정

3가지 영감 흡수:

1. **Worker status.json JSON Schema 강제**:
   - `schemas/worker-status.schema.json` (draft-07)
   - `scripts/validate-status.js` (ajv) — coordinator가 통합 전 검증
   - 형식 위반 워커 자동 blocked

2. **TDD Guard hook** (PreToolUse Write):
   - `hooks/tdd-guard.js`
   - 워커 worktree 안에서 tdd:true task가 코드 신규 작성 시 대응 테스트 파일 검사
   - 없으면 `permissionDecision: deny` 차단
   - 워커 자기 보고(`tdd_evidence`)에만 의존하지 않고 사전 차단으로 강화

3. **Hook async 분리**:
   - `post-edit-doc-sync`, `progress-check`은 `async: true`
   - 메인 흐름 안 막음, 텔레메트리만 백그라운드

### 트레이드오프

- ❌ ajv·ajv-formats dep 추가 (npm install 필요)
- ❌ tdd-guard가 false positive 가능 (테스트 파일 명명 패턴 휴리스틱)
- ✅ 워커 보고 신뢰성 대폭 향상
- ✅ TDD 강제가 자기 보고 → 사전 차단으로 격상
- ✅ async hook으로 메인 응답성 유지

---

## ADR-008 — Plan-review 3개로 재편성 (gstack 영감 자체 구현)

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-016 작업 중 사용자 토론
- **관련**: TASKS.md PACT-016, ARCHITECTURE.md NEW-3

### 발견 / 배경

ARCHITECTURE.md NEW-3은 `plan-eng-review` / `plan-design-review` 두 모드 명시. 하지만:

- gstack에 같은 이름 스킬이 있고 **영역이 다름**:
  - gstack `/plan-eng-review`: 아키텍처·data flow·성능 (구현 전 큰 그림)
  - gstack `/plan-design-review`: UI 시각 디자인 0-10 평가
- 우리 원래 정의:
  - `plan-eng-review`: task 분해 품질
  - `plan-design-review`: 계약 정합성

→ 이름 충돌. 의미도 다름.

### 결정

3개 review로 재편성, 의미 명확히:

| 명령 | 책임 | 영감 |
|---|---|---|
| `/pact:plan-task-review` | task 분해 품질 (메타) | 우리 고유 |
| `/pact:plan-arch-review` | 아키텍처 + 계약 정합성 | gstack `/plan-eng-review` + 우리 계약 검증 흡수 |
| `/pact:plan-ui-review` | UI 디자인 차원 | gstack `/plan-design-review` |

원래 `plan-design-review`(계약)는 `plan-arch-review`에 흡수 (계약 = 아키텍처의 일부).

gstack 코드 직접 호출 X — 영감만 받아 우리 reviewer 모드로 자체 구현 (gstack 인프라 의존 회피).

### 트레이드오프

- ❌ 명령 수 증가 (2 → 3)
- ❌ ARCHITECTURE.md NEW-3과 명칭 어긋남
- ✅ gstack과 이름·의미 충돌 X (사용자 헷갈림 X)
- ✅ 4가지 review layer 모두 다룸 (분해/아키텍처/계약/UI)
- ✅ pact 자립 — gstack 미설치 환경에서도 작동

---

## ADR-007 — Worktree 정책 W4·W5 default 채택

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-028
- **관련**: ARCHITECTURE.md §18.2 W4~W5, §18.3

### 결정

| 항목 | 채택값 |
|---|---|
| W4 (머지 전략) | cycle 단위 sequential 머지 (모든 워커 종료 후 일괄 시도) |
| W5 (충돌 처리) | 즉시 사용자 위임, 자동 해결 영구 X |

충돌 발생 시:
1. 즉시 멈춤
2. 충돌 worktree 보존
3. 사용자에게 `/pact:resolve-conflict` 안내

### 트레이드오프

- ❌ cycle 단위라 부분 실패 시 일부만 머지된 상태 가능 (롤백 X)
- ❌ 자동 머지보다 사용자 수동 작업 늘어남
- ✅ 안전 — 머지 충돌 자동 해결의 위험 회피 (ARCHITECTURE.md §15 #7)
- ✅ 사용자가 진실(`git status`)을 직접 확인 후 결정

---

## ADR-006 — worker 시스템 프롬프트는 단일 파일로 통합

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-027
- **관련**: TASKS.md PACT-027

### 발견 / 배경

TASKS.md PACT-027은 `prompts/worker-worktree.md`를 별도 파일로 명시. 그러나 P1.5 이후 모든 워커는 worktree 모드로 동작하므로 분리 의미가 약함.

### 결정

`prompts/worker-system.md` 한 파일에 worktree 섹션 추가. 별도 `worker-worktree.md` 파일 생성 X.

### 트레이드오프

- ❌ TASKS.md 한 줄 어긋남 (파일명 변경)
- ✅ 두 템플릿 concat 로직 불필요
- ✅ placeholder 중복 X
- ✅ 워커가 한 파일만 컨텍스트로 받음

---

## ADR-005 — Worktree 정책 W1~W3 default 채택

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-026
- **관련**: ARCHITECTURE.md §18.2, docs/WORKTREE_POLICY.md

### 결정

| 항목 | 채택값 |
|---|---|
| W1 (위치) | `<repo>/.pact/worktrees/<task_id>/` |
| W2 (branch) | `pact/<TASK-ID>` per task |
| W3 (base) | 직전 cycle 결과 = 현재 main HEAD |

상세는 [docs/WORKTREE_POLICY.md](docs/WORKTREE_POLICY.md).

### 트레이드오프

- ❌ monorepo 디스크 부담 / branch 폭증 / cycle 의존성 누적
- ✅ IDE 추적 편의 / task별 격리 / cycle 간 자연스러운 흐름

W4·W5는 PACT-028에서 결정.

---

## ADR-004 — 매니저·워커 모델은 `inherit` (부모 컨텍스트 상속)

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: 사용자 결정 (다른 플러그인 패턴 조사 후)
- **관련**: ARCHITECTURE.md §3 (매니저), §4 (워커)

### 발견 / 배경

다른 플러그인 패턴 조사 결과:
- `everything-claude-code`: 매니저급은 `opus`, 일반 작업은 `sonnet`, 단순 작업은 `haiku`로 차등 명시
- `superpowers`: `model: inherit`로 부모 컨텍스트 모델 상속

매니저·워커별 모델을 강제하면 사용자의 모델 선택권을 빼앗고, 비용·속도가 코드에 박혀버림.

### 결정

**모든 매니저(planner·architect·coordinator·reviewer)와 워커**: `model: inherit`.

- 사용자가 메인 세션에서 opus 쓰면 매니저·워커도 opus
- sonnet 쓰면 sonnet
- 단일 변수로 전체 비용·품질 제어

워커 spawn 시 Task tool의 `model` 파라미터는 **생략** (부모 상속이 default).

### 트레이드오프

- ❌ 매니저별 차등 불가 — coordinator(통합 작업) 같은 가벼운 매니저도 opus 시 비싼 호출
- ❌ 메인이 haiku면 매니저도 haiku로 품질 저하 가능
- ✅ 사용자 모델 선택권 존중
- ✅ 비용·속도 단일 변수로 단순화
- ✅ 개발 중 sonnet, 프로덕션 opus 같은 swap 자유

P0 walking skeleton 검증 후 매니저별 차등 필요하면 ADR-005로 변경 가능.

---

## ADR-003 — plugin.json 위치는 .claude-plugin/plugin.json

- **상태**: 채택
- **날짜**: 2026-05-02
- **출처**: PACT-000 (docs/CLAUDE_CODE_SPEC.md §1.1)
- **관련**: TASKS.md PACT-001

### 발견

TASKS.md PACT-001은 `files: [plugin.json]`(루트)로 표기. 공식 spec은 `.claude-plugin/plugin.json` 요구.

### 결정

`.claude-plugin/plugin.json`로 채택. 루트 plugin.json은 인식되지 않음.

### 트레이드오프

- TASKS.md 한 줄 어긋나지만, 공식 spec이 진실. ADR로 기록.
