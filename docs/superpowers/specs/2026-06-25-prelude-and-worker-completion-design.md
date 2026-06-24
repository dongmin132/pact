# prelude 추출 + 워커-완료 — 저토큰·빠름·일관성 pact

> 상태: 설계 (구현 진행). 작성 2026-06-25.
> 목표: pact를 **저토큰 + 빠름 + 일관성** 세 축으로 끌어올린다. 사용자 위임("너가 골라서 만들어줘") → 핵심 결정은 이 문서에 고정.

## 0. 세 축이 무엇으로 달성되나

| 축 | 메커니즘 | 상태 |
|---|---|---|
| **저토큰** | 헤드리스 드라이버(오케스트레이터 0토큰)·문서 lazy-load·워커 일회용 | 이미 있음 (유지) |
| **빠름** | ① 워커-완료(salvage 제거 — brewdy ~65% 직격) ② prelude(병렬 폭 ↑) | 이 문서 |
| **일관성** | prelude(공유표면 고정 → 워커 갈림 제거) | 이 문서 |

근거: brewdy 포렌식 — "안 빠른" 원인은 머지/충돌(~10%)이 아니라 워커 미완료+달력공백+직렬QA(~65%). 갈림(클라/서버 불일치·틀린 INSERT)은 워커가 격리돼 공유표면을 각자 추측해서.

---

## PART 1 — prelude 추출 (`pact prelude`)

### 1.1 개념
fan-out 전에, 여러 task가 공유하는 **소비형 표면**(타입·스키마·deps·UI-kit)을 prelude task가 **먼저 한 번** 쓰고 고정 → 나머지 워커는 read-only import → 충돌·직렬화·갈림 동시 제거.

### 1.2 형태 — propose-only CLI (철학 5번)
`pact metrics`와 같은 결정적·0토큰 CLI. 대상을 **수정하지 않고 제안만**; `--apply` 시에만 `tasks/*.md` 변형.

```
pact prelude [--project <path>] [--min=N] [--json] [--apply]
  (기본)      tasks/*.md 분석 → 공유표면 freeze 제안 출력 (수정 안 함)
  --min=N     공유 task 임계 (기본 3). N개 이상이 같은 구체파일 declare 시 후보
  --json      기계용
  --apply     제안을 tasks/*.md에 실제 반영 (propose-only 게이트)
```

### 1.3 탐지 규칙 (안전 우선)
- **freeze 후보** = `allowed_paths`에 **구체 파일**(글롭 `*` 없음)로 등장하고 **≥ min개** task가 공유.
- **글롭 디렉토리**(`components/ui/**`, `docs/ui/**`)는 *기여형*일 수 있으므로 **freeze 안 함** — "샤딩 후보(v2)"로 **표시만**. (잘못 얼리는 사고 방지.)
- 재사용: `parse-tasks.js`(로드), `batch-builder.js`의 `pathsOverlap`, metrics의 커플링 카운팅 아이디어.

### 1.4 제안 내용 (계획 변형)
구체 freeze 후보들을 **top-level 디렉토리로 클러스터링**해 클러스터당 prelude task 1개 제안:
- **신설 prelude task** `PRELUDE-<area>`: `allowed_paths` = 그 클러스터의 공유파일들. `dependencies: []`(wave 0). `work` = "이 공유표면을 이번 배치용으로 한 번에 확정(freeze)". `done_criteria` = 파일 존재 + typecheck.
- **의존 task 재작성** (각 공유파일을 declare했던 task):
  1. `dependencies`에 `{task_id: PRELUDE-<area>, kind: complete}` 추가
  2. `allowed_paths`에서 그 공유파일 제거
  3. `forbidden_paths`에 그 공유파일 추가 (pre-tool-guard가 물리적 차단)

→ 그 뒤 `buildBatches`가 prelude를 wave 0, 의존들을 (이제 path-disjoint라) **한 wave에 병렬** 배치. `pre-tool-guard`가 공유파일 수정을 deny. **새 실행 엔진 0.**

### 1.5 출력
- 사람용: freeze 후보(파일·공유 task 수)·제안 prelude·재작성 목록·글롭 샤딩 후보(표시만).
- JSON: `{ freeze_candidates, proposed_preludes:[{id, allowed_paths, dependents:[{task, removed_path}]}], shard_candidates }`.
- `--apply`: 위 변형을 `tasks/*.md`에 atomic 반영(기존 `atomic-write`/shard 편집 패턴 재사용). 미적용 시 아무것도 안 씀.

### 1.6 안전·에러
- 대상 read-only(기본). `--apply`만 쓰기. brewdy 검증은 **--apply 없이** 제안만(무손상).
- 순환 의존 생성 금지: prelude는 deps 없음 + 의존 task가 prelude에 의존 → DAG 유지(`detectCycles`로 사후 검증).
- 이미 prelude 있는 파일·이미 forbidden인 파일은 스킵(멱등).

---

## PART 2 — 워커-완료 (속도 1순위 레버)

워커가 큰 task를 턴 안에 못 끝내 사람이 `main`에서 salvage하는 것 = brewdy "안 빠른"의 핵심. 두 부분.

### 2.1 turn-risk 사이징 체크 (`pact sizecheck`) — 지금 빌드
fan-out 전에 **턴 소진 위험 task를 결정적으로 플래그**하고 분해 제안.
- 신호: `allowed_paths`/`files` 수 과다(기본 >5), 또는 과거 같은 task가 턴소진 이력(있으면).
- 출력(propose-only): "이 task는 N파일 — 분해 권장" + 가능한 분할 힌트.
- 재사용: reviewer-task의 "파일 ≤ 5개" 휴리스틱을 결정적 CLI로 형식화.
- CLI: `pact sizecheck [--project] [--max-files=N] [--json]`.

### 2.2 fresh-worker 재개 (엔진) — 설계 + 단계적
턴소진 = 실패가 아니라 **이어서 끝낼 일**. `main` salvage 대신 fresh 워커가 worktree의 부분 산출물 + 연속 프롬프트로 이어받아 완료.
- **재사용 기반**: 헤드리스 드라이버는 이미 loop task에 **fresh 워커 재투입**(`loop_until.count`)을 한다. 이를 **"턴소진된 일반 task"**로 확장.
- 트리거: 워커가 `status.json` 없이 종료 또는 `clean_for_merge:false` + 턴 한도 도달.
- 연속 페이로드: worktree `git diff` 요약 + 원 task `done_criteria` 중 미충족분 + "남은 것만 마저" 지시.
- 회로 차단기: 동일 task 재개 ≤ 2회(철학), 초과 시 사용자 위임(현행 유지).
- 범위: `driver.mjs`(재투입 루프)와 `run-cycle collect`(턴소진 분류)에 집중. ADR-053 fallback과 통합.
- **단계**: 2.1(사이징) 먼저 → 2.2는 별 PR로 신중히(엔진 변경·테스트 큼).

### 2.3 계측 연동
`pact metrics`의 salvage_rate가 워커-완료 효과의 측정자. 2.1/2.2 적용 전후로 salvage_rate가 떨어지는지 같은 계측기로 검증.

---

## 구현 순서 (저토큰·점진)
1. **prelude detect + propose (코어, TDD)** — 순수함수, fixture 테스트.
2. **prelude CLI + format + `--apply`** — bin/cmds/prelude.js, scripts/prelude/*.
3. **brewdy 제안 검증** (--apply 없이, 무손상).
4. **sizecheck (TDD)** — bin/cmds/sizecheck.js.
5. **fresh-worker 재개** — 별 단계(엔진).

각 단계 후 전체 테스트 통과 + 커밋. prelude/sizecheck는 metrics와 같은 결정적·read-only(쓰기는 --apply만) 패턴.

## 테스트
- detect/propose 순수함수 단위 테스트(공유파일 탐지·글롭 제외·클러스터·재작성 정확성·순환 금지·멱등).
- `--apply` atomic 반영 + 재실행 멱등 테스트.
- sizecheck 임계 테스트.
- 회귀: 전체 `node --test test/` 그린 유지.

## 미해결(구현 중 결정)
- prelude 클러스터 단위: top-level dir vs domain shard. (시작: top-level dir.)
- dep kind: `complete`(안전) 고정. contract_only 최적화는 후속.
- sizecheck 임계 기본값(5) 튜닝.
