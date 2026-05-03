# pact Architecture

> v1.0 설계의 모든 결정 사항. Claude Code가 의문 시 돌아올 sourcing.

## 1. 한 줄 정의

Claude Code 사용자가 프로젝트를 시작하면, 문서를 먼저 만들고, 계약을 정의하고, 워커를 안전하게 병렬화하고, 검증·회고하는 일련의 흐름을 자동화하는 플러그인.

**자기참조 원리**: pact는 pact의 철학(문서→계약→검증→병렬→회고)을 따라 만들어진다.

## 1.1 Context-light SOT (ADR-015)

긴 문서는 SOT로 보관하되 기본 컨텍스트에는 올리지 않는다.

```text
docs/context-map.md          # 명령별 read profile
tasks/<domain>.md            # task shard
contracts/manifest.md        # contract shard index
contracts/api/<domain>.md    # API contract shard
contracts/db/<domain>.md     # DB contract shard
```

명령과 agent는 `docs/context-map.md`를 먼저 읽고, `pact slice --headers` → 선택 task → `context_refs` 순서로 필요한 섹션만 lazy-load한다. `TASKS.md`, `API_CONTRACT.md`, `DB_CONTRACT.md` 단일 파일은 legacy/index로 유지한다.

## 2. 2계층 구조 (매니저 + 워커)

```
[매니저 4명 — 항상 살아있음, 단일 인스턴스]
planner → architect → coordinator → reviewer
                            │
                    (Build phase에서만)
                            ▼
                  [워커 — 일회용, 병렬, N개]
                  ┌──────────────────────┐
                  │ 모듈 단위로 분배       │
                  │ (도메인 타입 없음)     │
                  └──────────────────────┘
```

토큰 베이스라인 (1 사이클): ~85k (매니저 4명 합산) + 워커 비용 별도

## 3. 매니저 명세

### 3.1 planner

```yaml
한_줄: 요구사항 → 검증 가능한 작은 task로 분해
트리거: /pact:plan
읽기:  [CLAUDE.md, ARCHITECTURE.md, 사용자 요구사항,
       (선택) --from 인자가 가리키는 docs/* (PRD 등 .md)]
쓰기:  [TASKS.md]
종료_조건:
  - 모든 task에 done criteria 있음
  - 각 task의 파일 ≤ 5
  - TBD 마커 박힌 task는 architect가 해소할 것으로 표시
  - PRD 입력 시: 모든 task에 prd_reference 박힘 (역참조 가능)
토큰_예산: ~10k (PRD 없음) / ~30k+ (PRD 있음, 크기 비례)
```

**필수 동작**: `/pact:plan` 시작 시 사용자에게 교육 모드 ON/OFF 묻기.

**입력 모드 두 가지** (§20 참조):
- `/pact:plan "한 줄 설명"` — 짧은 작업, PRD 없음
- `/pact:plan --from docs/PRD.md` — PRD 기반 (.md만 지원)
- `/pact:plan --from docs/` — docs/ 폴더 내 .md 모두

### 3.2 architect

```yaml
한_줄: API/DB/모듈 경계 계약 정의 (구현 X, 시그니처만)
트리거: /pact:contracts
읽기:  [CLAUDE.md, ARCHITECTURE.md, TASKS.md, DECISIONS.md]
쓰기:  [API_CONTRACT.md, DB_CONTRACT.md, MODULE_OWNERSHIP.md]
종료_조건:
  - 모든 task의 allowed_paths가 ownership 안에 들어감
  - planner의 TBD 마커 모두 해소
  - cycle 없음 (의존성 그래프)
토큰_예산: ~20k
```

**금지**: 구현 디테일 결정 (그건 워커 영역).

### 3.3 coordinator (구 orchestrator — 책임 축소됨)

```yaml
한_줄: 배치 계획 검토·결과 통합 (실행자 X, 검토자)
트리거: /pact:parallel
읽기:  [.pact/batch.json (CLI가 생성), TASKS.md, MODULE_OWNERSHIP.md, API_CONTRACT.md(포인터만)]
쓰기:  [.pact/state.json 갱신, PROGRESS.md (사이클 단위), DECISIONS.md (워커 결정 통합)]
도구:  
  - .pact/batch.json 검토 (충돌 가능성·논리 오류 LLM 판단)
  - 워커 결과 (.pact/runs/*/status.json) 읽기·통합
  - **워커 spawn은 메인 Claude가 함** (서브에이전트는 다른 서브에이전트 못 spawn)
종료_조건:
  - 모든 task가 done | failed | blocked 중 하나의 명시적 상태
  - .pact/state.json이 최신 상태
토큰_예산: ~15k (책임 축소로 30k → 15k)
```

**책임 명시**:
- ✅ 배치 계획 검토 (`pact batch`가 만든 .pact/batch.json의 의도 vs 실제 매칭)
- ✅ 워커 보고서 통합 → PROGRESS.md
- ❌ 워커 spawn (메인 Claude가 직접 Task tool 호출)
- ❌ 머지 실행 (`pact merge` CLI가 함)
- ❌ 배치 계획 생성 (`pact batch` 스크립트가 함, 결정적 알고리즘)

**왜 책임 축소**:
- 서브에이전트는 다른 서브에이전트 spawn 불가 (Anthropic 제한)
- 결정적 작업(배치 계산·머지)은 LLM 영역 X — 코드로
- LLM은 판단 영역에만 집중 (충돌 의도 검토, 보고서 통합)

**금지**: 비즈니스 결정. 결정 필요 시 사용자에게 위임.

**병렬 진입 게이트** (`/pact:parallel` 시작 시 사용자 확인):

```
이 plan에 대해 review를 진행하셨나요?
  [1] plan-eng-review 실행 완료
  [2] plan-design-review 실행 완료
  [3] 둘 다 실행 완료
  [4] 검토 없이 진행 (위험 인수)
```

4번 선택 시 PROGRESS.md에 `risk_acknowledged` 기록.

### 3.4 reviewer

```yaml
한_줄: 코드·계약·문서·통합 4축 검증 + plan-review 두 모드
트리거:
  - 자동: 메인 Claude의 머지 종료 직후 (code review)
  - 수동: /pact:plan-eng-review, /pact:plan-design-review (plan review)
읽기:  .pact/merge-result.json + 변경 파일 목록 + 실패 로그 요약 (전체 코드 X)
쓰기:  PROGRESS.md의 Verification Snapshot, DECISIONS.md (필요 시)
       (별도 REVIEW_REPORT.md 파일 생성 X)
출력:  채팅창에 prose 보고
토큰_예산: ~25k
```

**4축 검증** (각각 PASS/FAIL/WARN):
1. **Code**: lint·typecheck·test·build (워커 결과 신뢰 X, 재실행)
2. **Contract**: 계약 vs 실제 라우트/스키마
3. **Docs**: PROGRESS·ARCHITECTURE 동기화
4. **Integration**: ownership 위반 / 동시 수정 흔적

**금지**: 코드 직접 수정. 문제 발견 시 planner 재호출 제안 (사용자 승인 필요).

**plan-review 두 모드**:
- `plan-eng-review`: task 분해 품질 (크기, criteria, cycle, TDD 가능성)
- `plan-design-review`: 계약 정합성, 모듈 경계, 엣지 케이스

## 4. 워커 설계

### 4.1 핵심 원칙

- **일회용**: 작업 종료 시 컨텍스트 폐기
- **타입 없음**: 도메인별 워커 타입(backend/frontend/ai) 폐기. 모듈 단위로만 분배
- **병렬**: 같은 배치 내 N개 동시 실행
- **격리**: 다른 워커의 컨텍스트 못 봄, 매니저(coordinator)와만 통신

### 4.2 Spawn Payload (메인 Claude → 워커)

```json
{
  "task_id": "PACT-042",
  "title": "로그인 API 핸들러",
  "working_dir": ".pact/worktrees/PACT-042",
  "branch_name": "pact/PACT-042",
  "base_branch": "main",
  "allowed_paths": ["src/api/auth/login.ts", "src/types/auth.ts"],
  "forbidden_paths": ["src/components/**", "prisma/migrations/**"],
  "contracts": {
    "api_endpoints": ["POST /api/auth/login"],
    "db_tables": ["users"]
  },
  "done_criteria": [
    "POST /api/auth/login가 200 반환 (valid creds)",
    "typecheck pass",
    "관련 unit test pass"
  ],
  "verify_commands": ["npm run typecheck", "npm test -- auth/login"],
  "context_budget_tokens": 20000,
  "retry_count": 0,
  "tdd": true,
  "educational_mode": false,
  "prd_reference": "docs/PRD-auth.md §3.2"
}
```

**중요**:
- `contracts`는 **포인터만** (전체 API_CONTRACT.md X). 워커가 lazy하게 해당 endpoint 슬라이스만 읽음.
- `allowed_paths`/`forbidden_paths`는 워커 시스템 프롬프트에 강제 박힘. **단 worktree 격리로 인해 의미가 약해짐** — 머지 시점 검증으로 강제됨.
- 워커는 `working_dir` 안에서만 활동. 다른 worktree 접근 X.
- `prd_reference`는 PRD 슬라이스 포인터. 워커가 필요할 때 lazy-load. 전체 PRD 읽지 않음 (§20).

### 4.3 Worker Report (워커 → 파일 시스템)

**워커는 채팅 메시지로만 보고하지 않음. 반드시 파일에 기록.** 채팅 보고는 LLM이 거짓말할 수 있어 신뢰 X. git diff와 파일이 진실.

각 워커가 작업 종료 시 다음 파일들 생성:

```
.pact/runs/PACT-042/
├── payload.json           # 워커가 받은 명세 (재현용)
├── status.json            # 핵심 결과 (아래 형식)
├── report.md              # 사람용 prose 보고
└── verify-output.log      # lint/test/build 원본 출력
```

**status.json 형식 (필수)**:

```json
{
  "task_id": "PACT-042",
  "status": "done",
  "branch_name": "pact/PACT-042",
  "commits_made": 3,
  "clean_for_merge": true,
  "files_changed": ["src/api/auth/login.ts", "src/types/auth.ts"],
  "files_attempted_outside_scope": [],
  "verify_results": {
    "lint": "pass", "typecheck": "pass",
    "test": "pass", "build": "pass"
  },
  "tdd_evidence": {
    "red_observed": true,
    "green_observed": true
  },
  "decisions": [
    { "topic": "JWT 만료 시간", "choice": "1h", "rationale": "..." }
  ],
  "blockers": [],
  "tokens_used": 18234,
  "completed_at": "2026-04-29T15:23:00Z"
}
```

**worktree 관련 필드**:
- `branch_name`: 워커가 작업한 브랜치 (`pact merge`가 머지 대상 식별)
- `commits_made`: 커밋 개수 (0이면 빈 작업, 의심)
- `clean_for_merge`: working tree clean 여부 (false면 머지 불가, 사용자 위임)

**왜 파일에 박는가**:
- 채팅 보고만 믿으면 LLM 환각·요약 손실 위험
- coordinator·`pact merge`가 status.json을 기계 검증 가능
- 실패 시 payload.json으로 정확한 재현 가능
- `/pact:status`가 .pact/runs/* 읽기로 즉시 정보 표시
- 감사 추적·디버깅 자료

### 4.4 의존성 타입

```yaml
dependencies:
  - task_id: PACT-040
    kind: complete       # 완료까지 대기
  - task_id: PACT-035
    kind: contract_only  # 계약 정의되면 ready
```

`contract_only`는 병렬도 향상에 핵심. batch-builder.js가 이 두 타입을 다르게 처리해야 함.

### 4.5 회로 차단기

- 1회 자동 재시도 (lint/typecheck/docs 등 mechanical 실패만)
- 2회 실패 시 사용자 위임, PROGRESS.md의 Blocked 섹션에 기록
- 권한 위반 시도(`files_attempted_outside_scope` 비어있지 않음): 즉시 차단, 재시도 X
- `/pact:resume <task_id>`로 사용자 재개

## 5. 문서 구조

### 5.1 마크다운 스키마 (모든 문서 공통)

```
## <Section>

설명 prose...

```yaml
key: value
list:
  - item
```

추가 prose...
```

파서는 yaml 코드블록만 추출. 사람과 기계 둘 다 친화적.

### 5.2 문서 종류

| 파일 | 작성자 | 갱신 | 비고 |
|---|---|---|---|
| `CLAUDE.md` | 사용자 + planner (init) | 드물게 | 프로젝트 메모리 |
| `PROGRESS.md` | coordinator | 매 사이클 | **현재 상태만**, archive X |
| `TASKS.md` | planner | 매 사이클 | task당 yaml 블록 |
| `API_CONTRACT.md` | architect | 계약 변경 시 | prose + yaml |
| `DB_CONTRACT.md` | 자동 생성 (마이그레이션) | 마이그 변경 시 | read-only |
| `MODULE_OWNERSHIP.md` | architect | 모듈 변경 시 | yaml 위주 |
| `DECISIONS.md` | 모든 매니저 | 누적 | ADR 포맷 |
| `ARCHITECTURE.md` | 사용자 | 큰 변경 시 | 시스템 구조 |
| `TESTING.md` | 사용자 | 정책 변경 시 | 테스트 전략 |

### 5.3 PROGRESS.md (간단)

```markdown
# PROGRESS.md

## Current Goal
<현재 목표 한 줄>

## Active Cycle
Cycle N | Started: <timestamp>

## Recently Done
- PACT-001 ✅ 로그인 API
- PACT-003 ✅ 관리자 페이지

## Blocked / Waiting
- PACT-042 — typecheck 반복 실패, 사용자 결정 대기

## Verification Snapshot
lint:✅  typecheck:❌  test:✅  build:✅
```

archive·schema_version·frontmatter 모두 X. git history가 자연스러운 archive.

## 6. 슬래시 명령 (16개)

| 명령 | 트리거 | 비고 |
|---|---|---|
| `/pact:init` | 프로젝트 시작 | 인터랙티브 — 신규 전용, Codex 감지 포함 |
| `/pact:plan` | 요구사항 → tasks | **교육 모드 질문** 박힘 |
| `/pact:contracts` | 계약 정의 | TASKS.md 존재 전제 |
| `/pact:plan-eng-review` | 기술 검토 | 사용자 직접 호출 |
| `/pact:plan-design-review` | 설계 검토 | 사용자 직접 호출 |
| `/pact:cross-review-plan` | 설계 단계 외부 의견 | architect 산출물에 Codex 의견 |
| `/pact:parallel` | 워커 spawn | **기본 3명 병렬, 명확 분리 시 최대 5명** |
| `/pact:cross-review-code` | 완성 후 외부 의견 | cycle diff에 Codex 의견 |
| `/pact:merge` | 머지 게이트 실행 | **CLI 호출, .pact/runs/*/status.json 모두 통과한 것만** |
| `/pact:verify` | 코드 검증 | cycle 종료 시 자동, 수동도 가능 |
| `/pact:reflect` | 회고 | propose-only |
| `/pact:status` | 진행 확인 | **.pact/state.json 읽어서 표시** |
| `/pact:abort` | 강제 중단 | worktree 보존 옵션 제공 |
| `/pact:resume` | 회로 차단 task 재개 | 보존된 worktree에서 재개 |
| `/pact:worktree-cleanup` | 고아 worktree 정리 | 사용자 확인 후 일괄 삭제 |
| `/pact:resolve-conflict` | 머지 충돌 해결 | 사용자 위임 워크플로우 |

**워커 동시 한도** (제안 7):
- **default 3명**: 안전 + 충돌 위험 최소
- **최대 5명**: 명확히 분리된 작업일 때만 (path 겹침 0, 의존성 0)
- 사용자가 `/pact:parallel --max=5` 같은 옵션으로 명시적 상향
- 절대 5명 초과 X (LLM 응답 품질·디버깅 난이도 폭증)

UX: 인자 없는 인터랙티브 기본. `/pact:plan "리포트 기능"`처럼 인자 허용은 plan만.

## 7. Hooks (5개) — ⚠️ Spec 확인 필요

| Hook | 시점 | 역할 |
|---|---|---|
| `pre-tool-guard` | 파일 수정 전 | MODULE_OWNERSHIP.md 위반 차단 |
| `post-edit-doc-sync` | 파일 수정 후 | 문서 갱신 필요성 알림 |
| `stop-verify` | 작업 종료 | lint/test/typecheck/docs 실행 |
| `subagent-stop-review` | 서브에이전트 종료 | 결과 검사 |
| `progress-check` | 세션 종료 | PROGRESS.md 최신성 확인 |

**⚠️**: hook의 정확한 trigger event, payload, 차단(block) 가능 여부는 docs.claude.com 직접 확인. 추측 시 작동 안 할 수 있음.

## 8. 충돌 감지 — `pact batch` CLI 스크립트

**중요한 변경**: batch-builder.js는 **서브에이전트가 호출하는 도구**가 아니라 **`pact batch` CLI 명령으로 직접 실행**되는 결정적 스크립트.

```bash
$ pact batch  # CLI 명령, LLM 안 거침
  → TASKS.md, MODULE_OWNERSHIP.md 읽기
  → batch-builder.js 알고리즘 적용
  → .pact/batch.json 출력
```

**왜 분리**:
- 배치 계획은 결정적 알고리즘 (정적 path 충돌 감지·의존성 그래프)
- 결정적 작업을 LLM이 다시 검증하면 비결정성·토큰 낭비
- coordinator(LLM)는 batch.json의 **의도 검토**만 (예: "MYH-040과 042가 정말 분리해도 되는가" 같은 판단)

**핵심 동작**:

- ~~정적 path 기반 (dynamic lock X)~~  ← **worktree 도입으로 무력화** (§18)
- 그리디 패킹 (NP-hard 회피)
- Cycle 감지 (Kahn's algorithm)
- Cross-cutting glob은 보수적으로 충돌 처리
- Skipped는 명시적 사유와 함께 반환

⚠️ **worktree 도입에 따른 변경**:
- 정적 path 충돌 감지는 **무력화** (각 워커가 별도 worktree → 동일 파일 동시 수정 OK)
- batch-builder는 **의존성 그래프 + cycle 감지**에만 활용
- 진짜 충돌은 머지 시점에 git이 감지 (§18 참조)

⚠️ **변경 필요**: 의존성에 `kind: complete | contract_only` 타입 추가 (현재는 string[]). 4.4 참조.

## 9. 실패 처리 — 하이브리드

| 실패 유형 | 자동 처리 | 이유 |
|---|---|---|
| lint fail | 1회 자동 재시도 | mechanical |
| typecheck fail | 1회 자동 | 구체 에러 |
| test fail (1-2개) | 1회 자동 | flake 가능성 |
| test fail (다수) | **사용자 위임** | 설계 문제 가능 |
| contract violation | **사용자 위임** | 비즈니스 영역 |
| ownership violation | **즉시 차단** | 학습 안 됨 |
| docs out of sync | 1회 자동 | 안전 |
| integration conflict | **사용자 위임** | 사람 판단 |

자동 처리는 **딱 1회**. 2회 이상 자동 루프 금지.

## 10. 교육 모드

- `/pact:plan` 시작 시 매번 묻기 (옵션 A)
- 답변이 TASKS.md frontmatter에 박힘
- 워커가 코드 짤 때 동시에 `docs/learning/PACT-XXX.md` 생성

학습 노트 형식:
```markdown
# PACT-XXX — <task title>

## 1. 무엇을
## 2. 왜
## 3. 핵심 코드 설명
## 4. 연결 관계
## 5. 새로운 개념
```

⚠️ 워커가 코드 짜고 **나서** 따로 작성하는 패턴 X. 코드 짜는 동시에 작성.

## 11. TDD

- 기본 ON
- task별 `tdd: false` opt-out 가능 (문서/설정/마이그레이션)
- TDD task의 워커는 RED → GREEN → REFACTOR 순서 강제
- Worker Report에 `tdd_evidence.red_observed` 등 명시 (조작 방지)

## 12. 18개 결정 매트릭스

| # | 항목 | 결정 |
|---|---|---|
| G1 | 문서 스키마 | prose + yaml 블록 |
| G2 | 슬래시 UX | 인터랙티브, plan만 인자 허용 |
| G3 | 프레임워크 scope | stack-agnostic, 모듈 단위 병렬 |
| G4 | plugin.json | docs.claude.com 위임 |
| G5 | Hook spec | docs.claude.com 위임 |
| G6 | Dependency 타입 | `complete` / `contract_only` |
| G7 | init scope | 신규 전용 |
| G8 | PROGRESS 갱신 | 현재 상태만, archive X |
| G9 | budget 초과 | 워커 보고 → 재분해 |
| G10 | 회로 차단 state | PROGRESS Blocked + /pact:resume |
| G11 | 테스트 소유권 | TDD task: 같은 워커가 테스트+코드 |
| G12 | 동시 실행 | Refuse + status/abort |
| G13 | 워커 권한 | MODULE_OWNERSHIP.md에 통합 |
| G14 | REVIEW_REPORT | 파일 X, 채팅 보고 |
| G15 | OpenAPI | v1.0에서 제외 |
| NEW-1 | 교육 모드 | plan 시 매번 질문 |
| NEW-2 | TDD | 기본 ON, opt-out 가능 |
| NEW-3 | plan-review | 사용자 직접 호출 + parallel 게이트 |

## 13. 매니저 핸드오프 인터페이스

| From | To | 매체 | 비고 |
|---|---|---|---|
| user | planner | prose (자연어) | |
| planner | architect | TASKS.md | 단방향 + TBD 마커 |
| architect | coordinator | API_CONTRACT.md, MODULE_OWNERSHIP.md | |
| coordinator | reviewer | JSON change manifest | 인메모리 가능 |
| reviewer | user | 채팅 prose | |
| reviewer | planner | fix tasks list | 사용자 승인 후 |

**원칙**: 매니저 간 정보는 **파일을 거친다** (coordinator→reviewer 예외). 메모리 누수 방지.

## 14. 매니저·워커 격리와 spawn 책임

### 14.1 격리

- 각 매니저는 **독립 서브에이전트** (Claude Code Task tool)
- 워커도 **독립 서브에이전트**, 일회용
- 매번 fresh 컨텍스트로 시작
- 메인 Claude는 "지휘자" — 라우팅·spawn 결정·결과 통합

### 14.2 ⚠️ 중대한 제약: 서브에이전트 nesting 불가

> Anthropic 공식 제한: **서브에이전트는 다른 서브에이전트를 spawn할 수 없음.**
> Task tool이 서브에이전트 컨텍스트에서는 노출되지 않음.

**이게 우리 설계에 미치는 영향**:

❌ ~~coordinator(서브에이전트)가 워커 N명을 spawn한다~~  ← 불가능
✅ **메인 Claude가 워커를 직접 spawn한다**

### 14.3 정확한 spawn 흐름

```
[사용자: /pact:parallel]
       ↓
[메인 Claude Code]
       ├─ pact batch CLI 실행 → .pact/batch.json 생성
       │
       ├─ coordinator 서브에이전트 호출
       │   └─ batch.json 검토 (의도·논리 점검)
       │   └─ "OK" 또는 "수정 필요" 반환
       │   (coordinator 종료, 컨텍스트 폐기)
       │
       ├─ 메인 Claude가 worktree N개 생성 (bash)
       │
       ├─ 메인 Claude가 한 메시지에서 Task tool N번 호출
       │   ↓ ↓ ↓ ↓ (병렬 spawn, 최대 5개)
       │   워커1, 워커2, 워커3, 워커4, 워커5
       │   ↓
       │   각자 자기 worktree에서 작업, .pact/runs/<id>/ 파일 출력
       │
       ├─ 메인 Claude가 모든 워커 종료 대기
       ├─ 메인 Claude가 pact merge CLI 실행
       ├─ 메인 Claude가 reviewer 서브에이전트 호출
       └─ 메인 Claude가 사용자에게 결과 보고
```

### 14.4 동시 spawn 한도

Claude Code는 한 메시지에서 최대 10개 서브에이전트 동시 spawn 가능. 우리 정책은 **default 3, 최대 5** (§6 참조). LLM 응답 품질·디버깅 난이도를 고려한 보수적 한도.

### 14.5 메인 Claude의 책임 명시

메인 Claude는 다음을 직접 함:
- 슬래시 명령 인터페이스 처리
- `pact batch`, `pact merge` 같은 CLI 호출 (bash)
- 매니저 서브에이전트 호출 (planner, architect, coordinator, reviewer)
- 워커 서브에이전트 spawn (Task tool 다중 호출)
- worktree 생성·정리 (git 명령)
- 사용자 결정 게이트 (parallel review 확인, yolo 모드 등)
- 결과 통합·사용자 보고

**메인 Claude가 안 하는 것**:
- 코드 직접 작성 (워커가 함)
- 배치 알고리즘 추론 (`pact batch` CLI가 함)
- 머지 결정 (`pact merge` CLI gate가 함)
- 비즈니스 판단 (사용자에게 위임)

⚠️ Task tool이 "이 파일만 읽으세요" 강제 가능 여부는 docs.claude.com 확인 필요.

## 15. 안티패턴 (Claude Code가 빠지면 안 될 함정)

1. **"전능한 architect"**: 계약 외에 task 분해, 구현 결정까지 함 → planner·coordinator 빈 껍데기
2. **"보고 안 하는 reviewer"**: "잘 짜여진 듯" 같은 vague. 4축 PASS/FAIL/WARN 강제
3. **"비즈니스 결정하는 coordinator"**: 결정 위임이 정답
4. **"큰 task 통과시키는 planner"**: "백엔드 구현" 같은 거대 task 금지. task당 파일 ≤ 5
5. **"매번 갱신되는 PROGRESS.md"**: 토큰 폭증. 사이클당 1-2회만
6. **"자기 수정 skill"**: propose-only 위반. v1.0에 절대 X
7. **"머지 충돌 자동 해결"**: 절대 X. 항상 사용자 위임 (§18 W5)
8. **"실패 worktree 자동 삭제"**: 디버깅 자료 손실. 보존이 default (§18)
9. **"Cross-review를 차단 게이트로"**: Codex 의견은 정보만, 머지 차단 권한 X (§19)
10. **"Cross-review 결과 자동 fix task로"**: 사용자 명시 수용 후에만 task 추가 (§19)
11. **"Yolo 모드에서 게이트 자동 default"**: yolo는 도구 권한 자동 승인이지 사용자 의도 추측 X. 결정 게이트는 yolo에도 묻기 (§19.6)
12. **"coordinator가 워커 직접 spawn"**: 서브에이전트는 다른 서브에이전트 spawn 불가 (Anthropic 제한). spawn은 메인 Claude가 함 (§14)
13. **"채팅 보고만 믿기"**: 워커 결과는 반드시 .pact/runs/<id>/status.json에 박힘. 채팅은 사람용 prose만 (§4.3, §21)
14. **"LLM이 머지 실행"**: 머지는 `pact merge` CLI gate. ownership·contract·verify 통과한 것만 (§21)
15. **"배치 계획을 LLM이 만듦"**: 결정적 알고리즘은 코드 (`pact batch`). LLM은 의도 검토만 (§8)

## 16. v1.0 Out of Scope

만들지 말 것:
- 자동 컨텍스트 압축 (v1.5)
- 자동 진화·자기 수정 (v2.0)
- Brownfield 지원 (`/pact:adopt` v1.1)
- OpenAPI 자동 검증 (v1.1+)
- 다국어 (v1.1+)
- 마켓플레이스 배포 (v1.1+)
- 풀스택 워커 타입 분리
- 머지 충돌 자동 해결 (영구 X — 안전 원칙)
- **Cross-review 차단 게이트화** (영구 X — 의견만)
- **Cross-review 결과 자동 fix task 변환** (영구 X — propose-only)
- **Codex 외 어댑터 (Gemini/Cursor 등)** — 인터페이스만 열어두고 v1.1+
- **Cross-review 비동기 호출** (v1.1)
- **PRD 자동 변환 (.docx/.pdf/Notion 등)** — 사용자가 .md로 변환 후 사용 (§20)
- **PRD 자동 인덱싱·요약** (v1.1+)
- **워커 6명 이상 동시 실행** (영구 X — LLM 응답 품질 저하, 디버깅 폭증)
- **LLM이 머지·배치 계획 실행** (영구 X — 결정적 작업은 CLI)

## 17. Reference 자료

- `batch-builder.js`: 충돌 감지 알고리즘 (작성 완료, reference로 활용)
- 외부 영감: gstack (역할 기반), superpowers (TDD·skill 프레임워크), revfactory/harness (계층적 위임)
- worktree 패턴 영감: `crystal` (stravu), `uzi` (devflowinc), `claude-squad`

## 18. Git Worktree 기반 격리

### 18.1 핵심 정신

**각 워커는 자기만의 worktree에서 작업한다.** 동일 파일도 다른 worktree에서 동시 수정 가능. 충돌은 머지 시점에 git이 감지.

이 결정의 의미:
- batch-builder의 정적 path 충돌 감지 무력화 (§8)
- coordinator + 메인 Claude 책임 확장 — worktree 생성·할당·머지·정리 (§3.3)
- 워커 페이로드/보고서에 worktree 필드 추가 (§4.2, §4.3)
- 새 슬래시 명령 3개 (§6)

**왜 도입했나**:
- 정적 분리의 보수성(같은 파일 동시 수정 불가) 제거 → 병렬도 향상
- 워커 격리 강화 — 빌드·테스트 서로 영향 X
- 실패 시 worktree 통째 폐기 = 깔끔한 롤백
- git diff가 워커 작업의 진실 (조작 방지)

### 18.2 정책 5개 (빌드 중 실제 환경에서 확정)

다음 5개는 빌드 시 실제 git 환경에서 검증하며 결정. 각 항목의 default를 우선 적용하고, 환경에 안 맞으면 변경 후 DECISIONS.md에 사유 기록.

```yaml
W1_worktree_location:
  default: <repo>/.pact/worktrees/<task_id>/
  대안: ~/.pact/worktrees/<repo-name>/<task_id>/  # 프로젝트 외부
  결정_기준: 사용자 IDE에서 추적 편의성 + .gitignore 추가 가능 여부

W2_branch_strategy:
  default: pact/<TASK-ID> per task  # 예: pact/PACT-042
  대안: pact/cycle-<N>  # cycle 단위
  결정_기준: task별 격리 추적성 + git history 가독성

W3_base_branch:
  default: 직전 cycle 결과 (없으면 main)
  대안: 항상 main에서 분기
  결정_기준: cycle 간 의존성 자연스러움 + 충돌 빈도

W4_merge_strategy:
  default: cycle 단위 atomic 머지 (모든 워커 종료 후 일괄)
  대안: 워커 종료 즉시 머지
  결정_기준: cycle 단위 검토 가능성 + 부분 실패 시 복구

W5_conflict_resolution:
  default: 즉시 사용자 위임 (자동 해결 X)
  대안: 없음 (안전 원칙)
  결정_기준: 자동 머지는 영구 out-of-scope (§16)
```

### 18.3 워크플로우

```
/pact:parallel 실행
    ↓
coordinator: 배치 검토 / 메인 Claude: 배치별로
    ↓
  각 task당:
    1. worktree 생성: git worktree add .pact/worktrees/PACT-042 -b pact/PACT-042 <base>
    2. 워커 spawn (working_dir, branch_name 전달)
    3. 워커 작업 (자기 worktree 안에서만)
    4. 워커 보고 (commits_made, clean_for_merge 등)
    ↓
  배치 완료 후:
    5. cycle 단위 머지 시도:
       각 worker branch → main으로 순차 머지
    6. 충돌 감지 시:
       - 즉시 멈춤
       - 충돌 worktree 보존
       - 사용자에게 /pact:resolve-conflict 안내
    7. 모두 성공:
       - main 갱신
       - 성공한 worktree 삭제
       - 실패한 worktree 보존 (디버깅용)
```

### 18.4 실패 시 worktree 처리

| 실패 유형 | worktree 처리 |
|---|---|
| 워커 작업 실패 (테스트/빌드 fail) | 보존 — `/pact:resume`으로 재개 가능 |
| 워커 크래시 (timeout 등) | 보존 + 사용자 알림 |
| 머지 충돌 | 보존 — 사용자가 직접 해결 후 `/pact:resolve-conflict` |
| 워커 정상 완료 + 머지 성공 | 자동 삭제 |
| 사용자 `/pact:abort` | 사용자에게 보존 vs 삭제 선택 |
| 고아 worktree (1주 이상) | `/pact:worktree-cleanup`으로 사용자 확인 후 일괄 삭제 |

### 18.5 디스크 비용 인지

N개 동시 워커 = N개 worktree. 큰 프로젝트(예: monorepo)에선 GB 단위 사용 가능.

**완화 정책**:
- worktree는 git의 hard link 활용 (전체 복사보다 가벼움)
- 동시 worker 수 한도 (default 4)
- 실패 worktree 보존 정책 + 정기 cleanup 안내

### 18.6 사용자 환경 검증 (`/pact:init` 시점)

worktree 사용 가능 여부 사전 체크:
- git 저장소인가?
- git version 2.5+ (worktree 지원)?
- main branch 존재하나? (W3 기본값)
- uncommitted changes 있나? (있으면 init 거부 또는 stash 안내)

체크 실패 시 명확한 한국어 에러 + 해결 안내.

### 18.7 알려진 한계

- **monorepo 거대 프로젝트**: worktree 1개당 수GB 가능. 동시 워커 수 제한 권장.
- **submodule 복잡**: submodule 있는 repo는 worktree 동작 미묘. v1.0은 simple repo만 검증, 복잡한 케이스는 빌드 중 발견.
- **사용자가 직접 worktree 만진 경우**: 외부 변경 감지 어려움. `/pact:worktree-status`로 점검 권장.

## 19. Cross-Tool Second Opinion

### 19.1 정신

**다른 모델의 시각을 추가 의견으로 받는 보조 도구.** 차단 게이트 아님.

Claude reviewer가 통과시킨 코드·계약은 그대로 진행됨. Cross-review는:
- Claude의 맹점을 다른 모델이 잡아줄 가능성 추가
- 결과는 **정보 제공**, 사용자가 보고 결정
- 자동 차단 X, 자동 fix task 추가 X

### 19.2 두 시점

#### 19.2.1 설계 단계 (`/pact:cross-review-plan`)
- 입력: architect 산출물 (TASKS.md, API_CONTRACT.md, MODULE_OWNERSHIP.md)
- 가치: 잘못된 설계로 워커 N개 돌리는 비용 방지 (shift-left)
- 호출 시점: `/pact:contracts` 완료 후 ~ `/pact:parallel` 진입 전
- 자동 모드: contracts 완료 직후 자동 호출
- 결과: 채팅 prose 보고 → 사용자 수용 시 architect 재호출 또는 planner 보강

#### 19.2.2 완성 후 (`/pact:cross-review-code`)
- 입력: cycle 머지 결과 diff
- 가치: Claude가 못 잡은 패턴(보안·N+1·null 처리 등)을 다른 모델이 발견
- 호출 시점: cycle 머지 직후
- 자동 모드: 머지 직후 자동 호출 (단 머지 자체는 차단 X)
- 결과: 채팅 prose 보고 → 사용자 수용 시 다음 cycle의 fix task로 추가

### 19.3 어댑터 인터페이스

```
CrossReviewAdapter (인터페이스):
  - check_available() → boolean
  - call_review(input: ReviewInput) → Finding[]

ReviewInput:
  - target: "plan" | "code"
  - artifacts: 파일 경로 또는 commit 범위
  - context: 사용자 요구사항·CLAUDE.md 발췌

Finding:
  - file: string
  - line?: number
  - severity: "info" | "warn" | "error"
  - message: string (한국어)
```

**v1.0 구현체**: `codex` 어댑터 1개.
- `codex exec` headless 모드 활용
- JSON 스키마 출력으로 Finding[] 변환
- 한국어 prose 변환은 pact가 처리

**v1.1+ 추가 가능**: gemini-cli, cursor-agent, 사용자 커스텀 명령. 인터페이스 동일.

### 19.4 Codex 감지 (`/pact:init`)

`/pact:init` 시점에 Codex CLI 설치 여부 자동 검증:
- `codex --version` 실행 시도
- 설치됨 → 사용자에게 cross-review 사용 의사 묻기
- 미설치 → cross-review 자동 비활성화 (조용히, 강제 X), 안내 메시지만

CLAUDE.md의 `cross_review` 섹션에 결과 박힘:
```yaml
cross_review:
  adapter: codex | null
  mode: auto | manual | off
```

### 19.5 호출 모드

전체 단일 설정 (시점별 분리 X — v1.0 단순화):

| 모드 | 설계 단계 | 완성 후 |
|---|---|---|
| `auto` | contracts 후 자동 호출 | 머지 후 자동 호출 |
| `manual` | `/pact:cross-review-plan` 명시 호출만 | `/pact:cross-review-code` 명시 호출만 |
| `off` | 비활성화 | 비활성화 |

설계와 완성 후 다른 모드 적용은 v1.1+.

### 19.6 Yolo 모드 처리

Claude Code의 yolo 모드(`--dangerously-skip-permissions`) 감지 시:

**Cross-review 정책**:
- 세션 첫 `/pact:parallel` 또는 `/pact:contracts` 시 **한 번만 묻기**
- 선택지: 모두 자동 / 모두 skip / 명시 호출만
- 답은 세션 변수에 기록, 같은 세션 내 다시 안 묻음
- 새 세션에선 다시 결정

**다른 사용자 결정 게이트**:
- `/pact:plan` 교육 모드 질문: yolo여도 묻기 (사용자 의도 영역)
- `/pact:parallel` review 확인 게이트: yolo여도 묻기 (사용자 결정 영역)
- yolo는 "도구 권한 자동 승인"이지 "사용자 의도 자동 추측" 아님

⚠️ Claude Code의 yolo 모드 감지 메커니즘은 빌드 시 docs.claude.com에서 확인 필요.

### 19.7 결과 처리

**보고 형식**: 채팅창 prose, 별도 파일 X.

```
🔍 Cross-Review (Codex) — Cycle 7

발견된 의견 2건:

1. src/api/auth/login.ts:42  [warn]
   "SQL injection 가능성. 파라미터 바인딩 사용 권장."

2. src/types/user.ts:18  [info]
   "isPremium 필드가 nullable인데 null 체크 누락."

다음 액션:
  [1] 두 의견 모두 fix task로 추가 (planner 재호출)
  [2] 1번만 추가
  [3] 모두 무시
```

**감사 추적**: PROGRESS.md에 요약 기록
```yaml
last_cross_review:
  cycle: 7
  target: code
  findings_count: 2
  user_action: partial_accept  # 1번만 수용
  cost_external: $0.04
```

### 19.8 비용 인식

**Claude 토큰**: cross-review 한 번당 ~4k-8k tokens (orchestration만, 무거운 분석은 Codex가 함). 토큰 효율 4원칙 깨지지 않음.

**OpenAI 비용**: 별도 발생. 본인 코드 크기·findings 수에 비례.

**누적 비용 관리**:
- PROGRESS.md에 `external_review_cost` 추적
- auto 모드 + 큰 cycle 다수 = 누적 비용 큼 → 사용자 인지 필요
- /pact:init에서 비용 발생 가능성 명시 동의 후 활성화

### 19.9 v1.0 미포함

- 결과 자동 fix task 변환 (영구 X — propose-only 원칙)
- 도구 간 결과 통합 (Codex와 Gemini 다른 의견 시 어떻게? — v1.1+)
- 시점별 모드 분리 (설계는 auto, 완성은 manual 같은 — v1.1)
- 비동기 호출 (백그라운드 실행, 알림) — v1.1
- 차단 게이트화 (영구 X — 본인 시스템 철학)

## 20. 외부 Docs 통합 (PRD 등)

### 20.1 정신

PRD-driven workflow 지원. 본인 실무 패턴(PRD를 먼저 만들고 작업)을 그대로 흡수.

**핵심 원칙**: PRD는 **plan 시점에만 전체 읽음**. 다른 매니저·워커는 슬라이스 lazy-load. 토큰 효율 4원칙 그대로 유지.

### 20.2 지원 형식

**v1.0**: 마크다운 (.md) 만.

다른 형식(.docx, PDF, Notion, Google Docs 등)은 **사용자가 직접 .md로 변환** 후 사용. 자동 변환 통합은 v1.1+.

이유:
- 변환 라이브러리 의존성 줄임 (mammoth/pandoc 등 X)
- 변환 품질은 사용자가 직접 검증·수정 가능
- pact 코어를 단순하게 유지

### 20.3 입력 모드

세 가지:

```yaml
"한 줄":
  명령: /pact:plan "사용자 인증 — JWT 기반"
  용도: 짧은 작업, 빠른 프로토타입
  PRD: 없음

"단일 PRD":
  명령: /pact:plan --from docs/PRD-auth.md
  용도: 정식 PRD 기반 개발
  PRD: 단일 .md 파일

"PRD 폴더":
  명령: /pact:plan --from docs/
  용도: 큰 프로젝트, 여러 모듈 PRD
  PRD: 폴더 내 .md 모두
```

### 20.4 PRD 흐름

```
[사용자가 docs/PRD-auth.md 작성, .md 형식]
          ↓
[/pact:plan --from docs/PRD-auth.md]
          ↓
[planner 서브에이전트]
  - PRD 전체 읽기
  - 요구사항을 task로 분해
  - 각 task에 prd_reference 박기:
    sourcing: docs/PRD-auth.md §3.2
          ↓
[TASKS.md 생성, prd_reference 포함]
          ↓
[/pact:contracts]
[architect 서브에이전트]
  - PRD 전체 X, task의 prd_reference만 슬라이스 lazy-load
  - 계약 정의에 PRD 비기능 요구사항 반영
          ↓
[/pact:plan-eng-review, plan-design-review, cross-review-plan]
[reviewer / Codex]
  - PRD 슬라이스 + TASKS 매칭 검토
          ↓
[/pact:parallel]
[메인 Claude → 워커]
  - 워커 페이로드의 prd_reference 필드로 슬라이스 식별
  - 워커는 자기 task의 PRD 부분만 lazy-load
```

### 20.5 prd_reference 필드 형식

```yaml
prd_reference: <파일경로>[ §<섹션 마커>]
```

예시:
- `docs/PRD-auth.md`              # 파일 전체
- `docs/PRD-auth.md §3.2`          # 특정 섹션
- `docs/PRD-auth.md §3.2-3.4`      # 섹션 범위

섹션 마커는 마크다운 헤더 번호(`### 3.2`)에 매칭. planner가 task 분해 시 자동으로 박음.

### 20.6 PRD 변경 시

PRD가 도중에 수정되면:
- **v1.0 단순화**: 매 `/pact:plan` 호출 시 PRD를 새로 읽음. 이전 task와 비교 X.
- 사용자가 PRD 변경했으면 `/pact:plan --from ...`을 재실행하여 새 cycle 시작.
- 자동 변경 감지·영향 분석은 v1.1+.

### 20.7 짧은 plan 모드 유지

`/pact:plan "한 줄"` 모드는 **유지**. 강제 X.

이유:
- 빠른 버그 수정·작은 변경에는 PRD까지 안 만드는 게 자연스러움
- pact 다른 사용자가 PRD 안 쓸 수도 있음
- 두 모드 모두 지원이 사용자 자유도 ↑

## 21. `.pact/` 폴더 — Single Source of Truth

### 21.1 정신

**이 도구의 모든 동적 상태는 `.pact/` 안에 박힌다.** 매니저·워커·CLI가 이 폴더를 읽고 쓴다. 채팅 메시지나 LLM 컨텍스트에만 의존하지 않는다.

영구 보존 자료(소스 코드, 마크다운 문서, git commits)와 **임시 작업장**(워커 페이로드, 로그, 상태)을 분리하는 게 핵심.

### 21.2 폴더 구조

```
.pact/
├── .gitignore              # 자기 자신을 무시 ("*\n!.gitignore")
├── state.json              # 전체 상태 스냅샷 (현재 cycle, active workers 등)
├── batch.json              # 현재 사이클 배치 계획 (pact batch가 생성)
├── merge-result.json       # 최근 머지 결과 (pact merge가 생성)
├── runs/                   # 워커별 실행 결과
│   ├── PACT-001/
│   │   ├── payload.json    # 워커가 받은 명세 (재현용)
│   │   ├── status.json     # 핵심 결과 (기계 검증용)
│   │   ├── report.md       # 사람용 prose 보고
│   │   └── verify.log      # lint/test/build 원본 출력
│   └── PACT-002/
├── worktrees/              # 워커별 git worktree (§18)
│   ├── PACT-001/           # git이 관리, 폴더 자체는 ignore
│   └── PACT-002/
└── archive/                # 완료된 cycle 백업 (선택)
```

### 21.3 git 관리 정책

**`.pact/` 통째로 git ignore**.

이유:
- 대부분이 휘발성·임시·기계 생성 파일
- git에 넣으면 매 commit마다 거대한 변경 + PR 노이즈
- 영구 가치 있는 정보는 별도로 보존 (TASKS.md·PROGRESS.md·DECISIONS.md·코드 자체)
- worktree commits는 메인 .git이 알아서 보존 (worktree 폴더 삭제해도 commit 살아있음)

**구현 방법**: `/pact:init` 시점에 `.pact/.gitignore` 자동 생성:
```
*
!.gitignore
```

이러면 `.pact/` 폴더 내용 모두 git 무시. 사용자 프로젝트의 `.gitignore` 수정 X (침입적 X).

**명시적 보존이 필요하면**: 사용자가 가치 있다고 판단한 자료는 `docs/postmortem/` 같은 별도 위치로 직접 복사. v1.0은 자동 archive 명령 X.

### 21.4 누가 읽고 누가 쓰는가

| 파일 | 작성자 | 독자 |
|---|---|---|
| `state.json` | coordinator, pact CLI | `/pact:status`, 사용자 |
| `batch.json` | `pact batch` (CLI) | coordinator (검토용) |
| `runs/<id>/payload.json` | 메인 Claude (워커 spawn 시) | 워커, 재현 |
| `runs/<id>/status.json` | 워커 | coordinator, `pact merge`, reviewer |
| `runs/<id>/report.md` | 워커 | 사용자 |
| `runs/<id>/verify.log` | 워커 (verify 명령 출력 리다이렉트) | 디버깅 |
| `merge-result.json` | `pact merge` (CLI) | reviewer |
| `worktrees/<id>/` | git worktree | 워커 (자기 worktree만) |

### 21.5 머지 게이트 (제안 5)

`pact merge` CLI 명령은 **결정적 코드 게이트**:

```
$ pact merge
  → .pact/runs/*/status.json 모두 읽기
  → 각 워커에 대해:
    ✓ status == "done"
    ✓ files_attempted_outside_scope == [] (ownership 위반 X)
    ✓ verify_results.* 모두 "pass"
    ✓ clean_for_merge == true
    ✓ contract 검증 (API_CONTRACT vs 실제 변경)
  → 모두 통과한 워커만 git merge 시도
  → 충돌 시 즉시 멈춤, 충돌 worktree 보존
  → 결과를 .pact/merge-result.json에 기록
```

**LLM이 안 함**. 결정적 코드. 안전.

### 21.6 사용자가 직접 보면 안전

`.pact/`는 사람이 읽기 좋게 설계:
- JSON은 pretty-print
- 디렉토리는 task ID로 정렬
- report.md는 한국어 prose

문제 발생 시 사용자가 직접 들어가서 디버깅 가능. 블랙박스 X.
