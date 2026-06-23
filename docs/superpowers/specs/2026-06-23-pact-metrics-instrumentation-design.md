# pact metrics — 사이클 계측기 (instrumentation) 설계

> 상태: 설계 (구현 전). 작성 2026-06-23.
> 한 줄: pact 사이클이 **어디서 벽시계 시간·재작업을 흘리는지**를 결정적·0토큰·read-only CLI로 측정해 보여준다. 고치기 전에 **재는 것**이 목적.

---

## 1. 배경 — 왜 계측기부터인가

dogfood 프로젝트 **brewdy**(Expo/RN + Supabase, pact로 ~수십 사이클 운영)의 `.pact/` 기록을 포렌식 분석한 결과, "pact가 솔로보다 빠르지 않다"는 체감의 진짜 원인은 처음 두 가설이 **아니었다**:

| 가설 | 실제 비중 | 근거 |
|---|---|---|
| ① 선언 안 한 공유파일 → 머지 충돌 → 재작업 | ~10% | 133머지 중 실충돌 ~4%. worktree 격리 작동. |
| ② 공유파일 직렬화로 병렬 폭 붕괴 | ~25% | 초기 5-wide. CLEANUP/STORE 꼬리에서만 1로 붕괴. |
| ③ **워커 미완료 + 달력 공백 + 직렬 QA 꼬리** | **~65%** | salvage/resume 커밋 45개. 7주 경과·활성 19일. |

핵심: **머지 레이어는 무죄.** 시간을 먹은 건 (a) 워커가 큰 coupled task를 턴 안에 못 끝내 사람이 `main`에서 손으로 마무리(= 솔로 작업 + ceremony), (b) 사이클 사이 달력 공백(병렬 무관), (c) 직렬 verify/QA 꼬리.

→ 두 번의 오진을 겪었으므로, **고치기 전에 새는 곳을 계측으로 못박는다.** 이 계측기는 pact 철학과 정합: *"기록 없이 반복하지 않는다"* + *"결정적 작업 = CLI"* + *"propose-only(측정만, 수정 안 함)"*. 방금 73K 토큰짜리 1회성 에이전트 분석을 **0토큰 반복 가능 CLI**로 대체한다.

## 2. 목표 / 비목표

**목표**
- pact 프로젝트의 `.pact/` + read-only git을 읽어 "사이클 스코어카드"를 산출.
- 지금 pact가 **못 보는** 지표 — 특히 **salvage rate(pact가 대신 안 해준 비율)** — 를 드러낸다.
- 기존 brewdy 기록에 즉시 돌려 포렌식 결론을 재현(검증)할 수 있다.
- 사람용 readout + 기계용 JSON 둘 다. proxy/heuristic 수치엔 신뢰도 태그.

**비목표 (이번 범위 아님)**
- 고치는 것 자체 — 워커-완료(turn-budget 사이징·fresh-worker 재개), 공유표면 prelude 추출, 무인 모드 — 는 **별도 후속**. 이건 측정만.
- 대상 프로젝트를 **어떤 식으로도 수정**(소스·git·`.pact/` 상태). 자동 수정·제안 적용 없음.
- 실시간 대시보드(`pact status`/`drive` watch와 별개). 이건 사후 readout.

## 3. 제약 — 철저한 read-only (최우선)

대상 프로젝트(brewdy 포함)는 **읽기만** 한다.
- ✅ 읽기: `.pact/**`의 JSON/log, `tasks/*.md`, **read-only git 명령**.
- ❌ 금지: 대상 소스 수정, git 히스토리 변경, `.pact/` 상태 쓰기, `checkout`/`merge`/`stash`/`reset`/`clean`/브랜치·태그 조작.
- 📦 코드는 **pact repo**에서 개발. 대상은 read-only fixture일 뿐. 대상의 pact 설치도 안 건드림.
- 📤 출력은 **stdout only**. 대상 tracked 파일에 아무것도 안 씀(`--out`로 명시 시 pact repo/임의 경로에만).

## 4. 접근법 — C(하이브리드), A를 MVP로

- **A (MVP): 기존 산출물 read-only 재구성.** `.pact/` + git을 읽어 지표 계산. 결정적·0토큰. brewdy 과거 기록에 즉시 적용.
- **B (후속): 소스 이벤트 방출.** run-cycle/drive/hook에서 `wave_start`/`worker_done{completed|turn_exhausted}`/`merge`/`salvage`/`verify` 이벤트를 `.pact/events.jsonl`에 append → fragile 신호(정밀 타이밍·턴소진 분류·salvage)를 1급으로 잡음.
- **C: A로 시작, 재구성이 불안정한 지표만 B로 보강.** YAGNI — 이벤트 방출은 정말 필요한 곳에만.

이 문서의 구현 범위 = **A (MVP)**. B는 §13 향후로 명시.

## 5. 아키텍처

기존 `batch-builder.js`와 같은 결정적·순수함수 스타일. `bin/cmds/metrics.js`가 엔트리.

```
bin/cmds/metrics.js            CLI 레이어 — arg 파싱 → collect → compute → format → stdout

scripts/metrics/
  collect.js     read-only 로더:  readRuns(), readMergeResults(), readBatch(),
                 readTasks()(allowed_paths), readVerifyLogs(), gitTopology()
  git-ro.js      read-only git 래퍼 (명령 화이트리스트, §10)
  compute.js     지표별 순수함수 (입력=collected data, 출력={value, confidence})
  format.js      formatHuman()  /  formatJson()
```

**레이어 격리 원칙**: collect는 디스크/ git만 만지고 plain 데이터 반환. compute는 순수함수(부작용 0)라 단위 테스트 쉬움. format은 데이터→문자열. CLI가 배선.

**재사용**: `batch-builder.js`의 순수함수를 그대로 import — `globToRegex`/`matchesGlob`(스코프 드리프트 매칭), `pathsOverlap`/`buildBatches`(이상 병렬폭·직렬화 세금 재계산). 새 글롭/배치 로직을 다시 짜지 않는다.

## 6. 지표 정의 (스코어카드)

`done_clean`/`done_salvaged`/`blocked`/`failed`는 워커 결말. `total` = 고유 task 수(`.pact/runs/` 디렉토리 기준; 재배치돼도 1로 셈).

| 지표 | 계산식 | 출처 | 신뢰도 |
|---|---|---|---|
| **worker outcomes** | status별 분류 (아래 정의) | `status.json.status` + git topology | done/blocked/failed ✅, salvaged 🟡 |
| **completion_by_worker_rate** | `done_clean / total` (진짜 승률) | 위 | ✅ |
| **salvage_rate** ⭐ | `done_salvaged / total` (숨은 사람 작업) | git topology(아래) | 🟡 heuristic |
| **unfinished_rate** | `(blocked + failed) / total` | status.json | ✅ |
| **"pact가 대신 안 해준 일"** | `salvage_rate + unfinished_rate` (헤드라인) | 위 합 | 🟡 |
| **turn-exhaustion proxy** | `tokens_used` 상위 + `commits_made` 적음 / `clean_for_merge:false` | status.json | 🟡 proxy |
| **scope drift** (재계산) | `files_changed ∖ ⋃allowed_paths` (글롭 매칭) | status.json + tasks/*.md | ✅ (framework detector 무시) |
| **width (actual)** | `completed_at` 클러스터링 → wave별 동시 task 수(평균/최대) | status.json `completed_at` | 🟡 proxy |
| **width/waves (ideal)** | `buildBatches()` 재실행 → 이론상 wave 수·폭 | tasks allowed_paths/deps | ✅ 결정적 |
| **serialization tax** | `mutual_path_conflict`로 다음 wave 밀린 task 수 + 범인 파일 | `buildBatches()` skipped | ✅ |
| **effective parallelism** | `Σ(worker duration) / cycle wall-clock`. `ideal` = `total / ideal_wave_count` | completed_at(start 추정) + ideal waves | 🟡 proxy |
| **coupling chokepoints** | allowed_paths·files_changed에 가장 많이 등장한 top 파일 | tasks/*.md + status.json | ✅ |
| **merge conflict rate** | `conflicted≠null 수 / 전체 merged 수` | merge-result(+archive) | ✅ |
| **verify/QA tail** | verify-*.log 시각·크기 + 마지막 머지 후 `qa:` 커밋 수 | 로그 파일명 + git log | 🟡 proxy |
| **cost** | `Σ tokens_used` | status.json | ✅ |
| **calendar** | active_days(고유 completed_at 날짜) / elapsed(first..last) | status.json + git | ✅ |
| **time_attribution** | worker_exec_rework / inter_cycle_gaps / verify_tail / merge 비중 | 위 지표 롤업 | 🟡 proxy |

**worker outcome 분류 (정확한 정의)**
- `done_clean` — `status=done` **AND** `clean_for_merge=true` **AND** `completed_at` 이후 그 task의 `files_changed`를 건드린 `main` 커밋이 없음(= `branch_name`에서만 작업됨).
- `done_salvaged` — `status=done` **이지만** `completed_at` 이후 `branch_name`이 아닌 `main`(또는 다른 브랜치) 커밋이 `files_changed` 파일을 건드림. 보조 신호: 커밋 메시지 `salvage|resume|grind|수동` 매칭. → 🟡 heuristic, B에서 정밀화.
- `blocked` — `status=blocked`.
- `failed` — `status=failed` **또는** 배치됐는데 `status.json` 부재.

## 7. CLI 표면

```
pact metrics [--project <path>] [--json] [--cycle <prefix>] [--task <ID>] [--out <file>]

  (기본)            cwd pact 프로젝트, 전체 히스토리 사람용 readout
  --project <path>  다른 프로젝트 대상 (read-only)
  --json            기계용 JSON
  --cycle CLEANUP   task-family 하나로 드릴다운
  --task STORE-102  단일 task 상세
  --out <file>      JSON을 파일로(대상 아닌 임의 경로). 기본 stdout.
  --help            도움말
```
- exit 0 = 정보성 정상. `.pact/` 없으면 ≠0 + 안내. 출력은 stdout(또는 `--out`). 대상엔 안 씀.

## 8. 출력

### 8.1 사람용 readout (예시 — 실제 brewdy로 채워짐)

```
pact metrics — brewdy   (read-only)
87 tasks · 133 merges · 2026-05-03→06-22  (활성 19일 / 경과 51일)

⏱  시간이 어디로 갔나                              🟡 proxy
   워커실행+재작업   ████████████████░░░░  ~65%   ← salvage가 먹음
   사이클 사이 공백  ██████░░░░░░░░░░░░░░  ~25%   (병렬 무관·무인모드만 해결)
   verify/QA 꼬리    ██░░░░░░░░░░░░░░░░░░   ~8%
   머지             ░░░░░░░░░░░░░░░░░░░░    ~2%

🔧  워커 결말 (87)
   done(clean) 61 · done(salvaged) 9 ⚠ · blocked 11 · failed 6
   ▶ pact가 대신 안 해준 일 = (9+11+6)/87 = 30%   ("솔로보다 안 빠른" 직접 원인)   🟡

⚡  병렬성   waves 21 · width 평균 2.4/최대 5 · 유효 2.1×(이상 ~3.8×) 🟡 · 직렬화세금 18 ✅
🔗  커플링 병목   docs/ui/** 16 · package.json 14 · BrewdyUIKit.tsx 11   ✅
🧭  스코프 드리프트   8 task가 allowed_paths 밖 (MEETUP-006→app/index.tsx,package.json; DS-005/008→docs/ui/**) ✅
🔀  머지 133 · 충돌 4 (3%) ✅      💸 12.4M tokens
```
✅/🟡 신뢰도 태그를 readout에 표시 → proxy 수치를 단정처럼 안 보이게(정직성).

### 8.2 JSON 스키마 (요지)

```json
{
  "project": "brewdy", "generated_at": "<ISO>",
  "range": { "first": "...", "last": "...", "active_days": 19, "elapsed_days": 51 },
  "totals": { "tasks": 87, "merges": 133 },
  "time_attribution": { "worker_exec_rework": 0.65, "inter_cycle_gaps": 0.25, "verify_qa_tail": 0.08, "merge": 0.02 },
  "worker_outcomes": { "done_clean": 61, "done_salvaged": 9, "blocked": 11, "failed": 6 },
  "rates": { "completion_by_worker": 0.70, "salvage": 0.10, "unfinished": 0.20 },
  "parallelism": { "waves": 21, "width_avg": 2.4, "width_max": 5, "effective": 2.1, "ideal": 3.8, "serialization_tax": 18 },
  "coupling_chokepoints": [ { "path": "docs/ui/**", "tasks": 16 } ],
  "scope_drift": [ { "task": "MEETUP-006", "files": ["app/index.tsx", "package.json"] } ],
  "merge": { "total": 133, "conflicts": 4, "conflict_rate": 0.03 },
  "cost_tokens": 12400000,
  "confidence": { "time_attribution": "proxy", "salvage": "heuristic", "effective_parallelism": "proxy" }
}
```

## 9. 데이터 출처 매핑

- `status.json`: `status`, `clean_for_merge`, `files_changed`, `commits_made`, `tokens_used`, `completed_at`, `branch_name` → 결말·드리프트·비용·타이밍.
- `tasks/*.md` frontmatter `allowed_paths`/`dependencies` → 이상 병렬폭·직렬화·드리프트 기준·커플링.
- `merge-result.json` (+ `.pact/archive/*`): `merged[]`, `conflicted` → 머지/충돌률.
- `batch.json`: 현재 배치(참고).
- `verify-*.log` 파일명 시각·크기 → verify 꼬리.
- read-only git: 브랜치 토폴로지(salvage), `qa:` 커밋, 커밋 날짜.

## 10. read-only git 보장 (불변식)

`scripts/metrics/git-ro.js`는 **명령 화이트리스트**만 실행: `log`, `show`, `diff`, `rev-list`, `cat-file`, `for-each-ref`, `merge-base`, `name-rev`. 그 외(특히 mutating)는 거부. 항상 `git -C <target> --no-pager`. 워킹트리 변경·인덱스·HEAD 이동 일절 없음. 단위 테스트로 "화이트리스트 밖 명령 거부" 검증.

## 11. 검증 계획 (brewdy 대조)

`pact metrics --project /…/brewdy` (read-only) 실행 → 포렌식 에이전트 결론과 대조:
- 머지 ~133 · 충돌 ~4% ✅
- 병렬 최대 5-wide ✅
- salvage/미완료 다수(CLEANUP/STORE) — salvage_rate가 유의미하게 잡히나
- 커플링 top: `docs/ui/**`(16), `package.json`(14), `BrewdyUIKit.tsx`(11) ✅
- 스코프 드리프트가 framework `files_attempted_outside_scope`보다 **더** 잡나(DS-005/008 docs/ui 포함) ✅

재현되면 지표셋·계산식이 옳다는 증거. 어긋나면 계산식 수정.

## 12. 테스트 전략

- **compute.js 순수함수 단위 테스트**: 소형 fixture(status/merge/tasks JSON)로 각 지표 함수 검증 — 결말 분류, 드리프트 글롭 매칭, 직렬화 세금(`buildBatches` 재사용), 충돌률, 커플링 랭킹.
- **collect.js**: 누락 필드(`files_attempted_outside_scope` 없는 status, status.json 부재) graceful 처리.
- **git-ro.js**: 화이트리스트 밖 명령 거부.
- **read-only 불변식 테스트**: 임시 git fixture에 `metrics` 실행 후 `git status`·mtime 불변 확인.
- TDD: 계산 로직은 비즈니스 로직이므로 RED→GREEN.

## 13. 향후 (이 문서 범위 밖)

- **B 이벤트 방출**: `worker_spawn`/`worker_done{turn_exhausted}`/`salvage` 이벤트로 🟡 지표(정밀 타이밍·턴소진·salvage)를 ✅로.
- **크로스사이클 롤업·추세**, 달력 공백 리포트.
- 측정 다음 단계의 **고침**(워커-완료, prelude 추출, 무인 모드)은 계측 결과를 보고 별도 설계.

## 14. 미해결 질문

- `--cycle`의 "cycle" 경계: task-prefix family로 충분한가, 아니면 merge-result/archive 타임윈도로 끊나? (MVP: prefix family.)
- `time_attribution` proxy 산식을 MVP에 넣을지, B까지 보류할지. (현재: 넣되 🟡 명시.)
- effective parallelism의 worker `start` 추정 방식(이전 wave 완료 시각 vs run-dir mtime).
