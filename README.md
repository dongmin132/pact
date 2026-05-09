# pact

> Claude Code 위에 얹는 **계약 기반 AI 개발 운영 시스템**.
> 문서·계약·검증·worktree 격리 병렬 에이전트로 통제하는 플러그인.

[![tests](https://img.shields.io/badge/tests-177%2F177-brightgreen)](./test) [![version](https://img.shields.io/badge/version-0.5.1-blue)](./.claude-plugin/plugin.json) [![deps](https://img.shields.io/badge/deps-zero-success)](./package.json) [![license](https://img.shields.io/badge/license-MIT-blue)](#라이선스)

---

## 한 줄 요약

`/pact:init`으로 프로젝트 시작 → 매니저 4명이 task 분해·계약 정의·병렬 워커 spawn·머지 게이트·회고를 자동화. **결정적 작업은 CLI, 판단은 LLM**으로 분리해 메인 컨텍스트 토큰을 95% 이상 절감.

## v1.0 헤드라인 4개

1. **Contract-first parallelization** — 계약 없이 병렬 X. API/DB/모듈 경계가 정의된 후에야 워커가 spawn된다.
2. **Git worktree 격리** — 같은 파일도 안전한 동시 수정. 충돌은 머지 시점에 git이 감지 → 사용자 위임.
3. **Cross-tool second opinion** — Codex CLI에게 plan/code 의견을 묻되, 차단하지 않는다 (의견만, propose-only).
4. **결정적 작업 = CLI, 판단 = LLM** — `pact run-cycle prepare/collect`로 메인 turn 95→5 압축. batch15 측정 baseline 11.3M cache_read → ~700k (-94%).

## 5가지 철학 (절대 양보 X)

1. **문서 없이 코딩 X** — `/pact:init`이 4 문서 + shard 구조부터 깐다.
2. **계약 없이 병렬화 X** — `/pact:contracts`가 끝나야 `/pact:parallel`이 동작한다.
3. **검증 없이 머지 X** — `pact merge` CLI가 schema·실제 diff·allowed_paths를 모두 검증.
4. **기록 없이 반복 X** — PROGRESS·DECISIONS에 매 사이클 누적.
5. **자동 반영 X** — propose-only. 모든 변경은 사용자 게이트를 통과해야 한다.

## 토큰 효율 4원칙

설계 결정의 가드레일.

1. **워커는 일회용** — 작업 후 컨텍스트 폐기, 매니저로 누적 X
2. **문서 lazy-loading** — `pact slice`로 필요한 섹션만 그 시점에 read
3. **상태 압축** — PROGRESS.md / state.json이 single source of truth
4. **매니저↔워커 통신은 구조화 페이로드** — 긴 자연어 X, JSON Schema 강제

---

## 다른 시스템과의 차이

| 시스템 | 초점 | pact가 다른 점 |
|---|---|---|
| **[gstack](https://github.com/gauntlet-ai/gstack)** | 한 명의 슈퍼 개발자(Claude) 옆에 붙는 **개인 워크플로우 도구박스** — design / qa / ship / review 같은 단계별 skill 모음 | pact는 **여러 워커를 동시에 굴리는 오케스트레이터**. 워커 분할·계약 정의·머지 게이트가 핵심. gstack의 cognitive 7 패턴·UX 3법칙은 흡수했지만, 단일 개발자 1인칭 흐름이 아니라 매니저↔워커 다인칭 흐름이다. |
| **[superpowers](https://github.com/anthropic-experimental/superpowers)** | TDD·debugging·brainstorming 같은 **개발 프로세스 skill** 묶음. "어떻게 일할지"를 일관된 절차로 정착 | pact는 **프로젝트 운영 시스템**. skill이 아니라 매니저(planner/architect/coordinator/reviewer)·워커·hook·CLI를 한 패키지로 제공한다. TDD 강제·verification은 hook으로 박혀있어 우회 불가. |
| **[TDD Guard](https://github.com/nizos/tdd-guard)** | PreToolUse hook으로 RED→GREEN 위반을 차단하는 **단일 hook 라이브러리** | TDD Guard의 차단 패턴을 흡수해 `tdd-guard.js` hook으로 박았지만, pact는 그것 + worktree 격리 + 계약 검증 + 머지 게이트까지 묶은 풀 시스템이다. |
| **Claude Code Agent Teams** | 멀티 에이전트 협업 패턴·hook 예시 | TeammateIdle hook 패턴은 흡수. 하지만 pact는 "에이전트는 spawn하면 끝"이 아니라 **worktree·status.json·머지 게이트**까지 강제한다. |

요약: **gstack은 1인 개발자의 도구박스, superpowers는 프로세스 skill 묶음, pact는 다인 워커 오케스트레이터.** 셋 다 같이 써도 충돌 X — 영역이 다르다.

---

## 설치

### 정석 (권장)

```bash
git clone https://github.com/dongmin132/pact.git ~/pact   # zero-dep, npm install 불필요
cd /path/to/your/project
claude --plugin-dir ~/pact
```

### Marketplace 설치

```bash
/plugin marketplace add github:dongmin132/pact
/plugin install pact@pact-marketplace
```

명령 namespace: `/pact:init`, `/pact:plan`, `/pact:parallel`, …

### dogfooding (개발용 심볼릭 링크)

```bash
cd /path/to/your/project && mkdir -p .claude
for d in commands agents hooks scripts schemas templates prompts bin skills; do
  ln -s ~/pact/$d .claude/$d
done
```

`.claude/settings.local.json`에 환경변수:
```json
{ "env": { "CLAUDE_PLUGIN_ROOT": "/Users/<you>/pact" } }
```

---

## 빠른 시작

```bash
mkdir myproject && cd myproject
git init -b main
echo "# myproject" > README.md && git add . && git commit -m init

claude --plugin-dir ~/pact
```

Claude Code 안에서:

```
/pact:init                            # 4 문서 + .pact/ + shard 구조 생성, 스택 자동 감지
/pact:plan "사용자 인증 추가"          # planner가 task 분해 → tasks/<domain>.md
/pact:contracts                       # architect가 API/DB/모듈 계약 정의
/pact:plan-task-review                # task 분해 품질 검토 (옵션)
/pact:plan-arch-review                # 아키텍처 정합성 검토 (옵션)
/pact:parallel                        # 워커 N개 병렬 spawn → 머지 → 통합
/pact:verify                          # 4축 검증 (Code·Contract·Docs·Integration)
/pact:reflect                         # 사이클 회고 (propose-only)
```

PRD 기반 plan:
```
/pact:plan --from docs/PRD.md         # PRD .md 파일 기반 task 분해 (각 task에 prd_reference 박힘)
```

---

## 핵심 개념

### 2계층 구조

```
[매니저 4명 — 항상 살아있음, 단일 인스턴스]
  planner → architect → coordinator → reviewer
                           │
                   (Build phase에서만)
                           ▼
                 [워커 — 일회용, 병렬, N개]
                 ┌────────────────────────┐
                 │ 모듈 단위로 분배          │
                 │ 자기 worktree에서 작업    │
                 │ status.json으로 보고     │
                 └────────────────────────┘
```

- **planner** — 요구사항 → 검증 가능한 task로 분해
- **architect** — API/DB/모듈 경계 계약 정의 (시그니처만, 구현 X)
- **coordinator** — 배치 계획 검토·결과 통합·회로 차단기 (실행자 X, 검토자)
- **reviewer** — 4 모드 (`code-review`·`plan-task`·`plan-arch`·`plan-ui`)

워커는 **모듈 단위**로만 분기 (도메인 타입 분리 X — frontend/backend 같은 풀스택 분할 안 함, ADR 결정).

### Worktree 격리

```
myproject/
├── src/                              # 메인 작업 트리 (main branch)
├── .pact/
│   ├── worktrees/PACT-001/           # 워커1 격리 작업장 (자기 브랜치)
│   ├── worktrees/PACT-002/           # 워커2 격리 작업장
│   ├── runs/PACT-001/
│   │   ├── context.md                # 워커가 읽을 작은 bundle
│   │   ├── prompt.md                 # 렌더된 시스템 프롬프트
│   │   └── status.json               # 워커 보고 (schema 강제)
│   ├── batch.json                    # pact batch CLI 출력 (배치 계획)
│   ├── current_batch.json            # run-cycle prepare가 영속, collect가 소비
│   ├── merge-result.json             # pact merge 결과
│   └── state.json                    # 사이클 진행 상태
└── tasks/<domain>.md                 # task SOT (shard)
```

같은 파일도 다른 worktree에서 동시 수정 OK. 충돌은 `pact merge` 시점에 git이 감지 → 사용자 위임 (`/pact:resolve-conflict`).

worktree 생성 시 `node_modules` symlink 자동 (워커가 `tsx`/`tsc` 경로 디버깅하던 누수 차단). opt-out: `linkNodeModules: false`.

### Contract-First 검증

워커 보고는 JSON Schema로 강제:
```json
{
  "task_id": "PACT-042",
  "status": "done | failed | blocked",
  "files_attempted_outside_scope": [...],
  "verify_results": { "lint": "pass", "typecheck": "pass", "test": "pass", "build": "pass" },
  "tdd_evidence": { "red_observed": true, "green_observed": true }
}
```

형식 위반 → `pact merge` CLI가 자동 거부.

**자기 보고 신뢰 X** (ADR-012): `pact merge`는 status.json만 믿지 않고 실제 git diff와 `payload.allowed_paths`를 대조한다. 워커가 거짓말해도 잡힘.

### Context-light SOT

긴 문서는 SOT로 보관하되 기본 컨텍스트에는 올리지 않는다 (ADR-015~018).

```text
docs/context-map.md          # 명령별 read profile (어떤 명령이 무엇을 읽는지)
tasks/<domain>.md            # task shard (legacy 단일 TASKS.md 대체)
contracts/manifest.md        # contract shard index
contracts/api/<domain>.md    # API contract shard
contracts/db/<domain>.md     # DB contract shard
contracts/modules/<domain>.md # module ownership shard (구 MODULE_OWNERSHIP.md)
```

매니저와 워커는 `docs/context-map.md` → `pact slice --headers` → 선택 task의 `context_refs` 순서로 lazy-load. 통째 read는 `pre-tool-guard` hook이 차단(7개 큰 SOT: `TASKS`/`ARCHITECTURE`/`DECISIONS`/`API_CONTRACT`/`DB_CONTRACT`/`MODULE_OWNERSHIP`/`PRD`).

기존 프로젝트 마이그레이션:
```bash
pact split-docs --dry-run             # 미리보기
pact split-docs                       # 실행 (legacy 원본 보존)
pact context-map sync                 # Domains 표 갱신
```

### TDD 강제 (선택)

`tdd: true` task에서 코드 파일 신규 작성 시 대응 테스트 파일 없으면 `tdd-guard` hook이 차단 (TDD Guard 영감).

opt-out은 마크다운/설정/마이그레이션 task에서만: `tdd: false` frontmatter 명시.

### 회로 차단기

워커 2회 실패 → 자동 루프 금지, 사용자 위임 (`/pact:resume`로 재시도).

---

## 슬래시 명령 (17개)

| 명령 | 책임 |
|---|---|
| `/pact:init` | 프로젝트 초기화 (4 문서 + .pact/ + shard 구조, 스택 자동 감지) |
| `/pact:plan` | 요구사항 → tasks. PRD 입력 가능 (`--from docs/PRD.md`) |
| `/pact:contracts` | architect 호출, API·DB·모듈 계약 정의 |
| `/pact:plan-task-review` | task 분해 품질 검토 |
| `/pact:plan-arch-review` | 아키텍처 + 계약 정합성 (gstack 영감) |
| `/pact:plan-ui-review` | UI 디자인 차원 (gstack 영감) |
| `/pact:cross-review-plan` | Codex에게 plan 의견 (P2.5+) |
| `/pact:cross-review-code` | Codex에게 cycle diff 의견 |
| `/pact:parallel` | 워커 N개 spawn → 머지 → 통합 (run-cycle 흐름) |
| `/pact:verify` | 4축 검증 (Code·Contract·Docs·Integration) |
| `/pact:status` | 진행 상황 표시 |
| `/pact:abort` | 진행 중 cycle 강제 중단 |
| `/pact:resume` | 회로 차단된 task 재시도 |
| `/pact:reflect` | 사이클 회고 (propose-only) |
| `/pact:resolve-conflict` | 머지 충돌 사용자 해결 워크플로우 |
| `/pact:worktree-status` | worktree 목록·디스크 사용량 |
| `/pact:worktree-cleanup` | 고아 worktree 일괄 삭제 |

## CLI (`pact` 바이너리, 9개)

결정적 작업 전용 — LLM이 부르지만 LLM이 추론하지 않는다.

| 명령 | 역할 |
|---|---|
| `pact run-cycle prepare` | `/pact:parallel` 사전검사 + batch + worktree × N + payload 렌더 (atomic 롤백) |
| `pact run-cycle collect` | 워커 종료 후 검증 + 머지 + cleanup + summary 집계 |
| `pact batch [-n]` | `tasks/*.md` → `.pact/batch.json` (배치 계획). `-n`은 `batches[0]`만 |
| `pact merge [-q]` | status.json 검증 + 실제 diff 대조 + 머지 게이트. `-q`는 stderr 1줄 요약 |
| `pact status [-s]` | state.json + worktree 표시. `-s`는 한 줄 (`cycle:N active:N worktree:N merge:clean`) |
| `pact slice` | task corpus 섹션 단위 read (`--headers`, `--ids`, `--tbd`, `--status`, `--priority`) |
| `pact slice-prd` | PRD 섹션 추출 (`--section`, `--sections`, `--headers`, `--refs-from`) |
| `pact split-docs` | legacy `TASKS.md`/`API_CONTRACT.md`/`DB_CONTRACT.md`/`MODULE_OWNERSHIP.md` → shard |
| `pact context-map sync` | `docs/context-map.md`의 Domains 표를 현재 shard 상태로 갱신 (idempotent) |
| `pact context-guard [-q]` | parallel 전 긴 문서/선택 컨텍스트 위험 검사 |

### `/pact:parallel` 흐름 (v0.4.1 run-cycle)

```
메인 LLM
  └─ pact run-cycle prepare      # 결정적 작업 ×N개를 한 CLI로 응집
       └─ stdout JSON: task_prompts[], coordinator_review_needed, context_warnings
  ├─ Task tool spawn × N         # 워커 동시 spawn (메인이 하는 유일한 LLM 작업)
  └─ pact run-cycle collect      # 워커 종료 후 검증·머지·cleanup·요약
       └─ stdout JSON: verification_summary, decisions_to_record, failures
```

이전에는 메인 LLM이 Bash 30+개를 직접 호출하면서 cache_read prefix가 매 turn 누적됐다. v0.4.1에서 두 CLI에 응집해 메인 도구 호출 turn 수가 95→5로 압축. **batch15 측정 11.3M cache_read → ~700k 추정 (-94%)**.

---

## Hooks (8개)

| Hook | 트리거 | 책임 |
|---|---|---|
| `pre-tool-guard` | PreToolUse (Read/Write/Edit/MultiEdit) | MODULE_OWNERSHIP 위반 + 워커 worktree 경계 + 7개 긴 SOT 통째 read 차단 → `rg`/`sed`/`pact slice` 안내 |
| `tdd-guard` | PreToolUse (Write) | `tdd: true` task에서 테스트 없는 코드 파일 작성 차단 |
| `post-edit-doc-sync` | PostToolUse (async) | 문서 갱신 알림 (텔레메트리, 차단 X) |
| `stop-verify` | Stop | uncommitted 코드 변경 알림 |
| `subagent-stop-review` | SubagentStop | 워커 status.json 의심사항 감지 |
| `teammate-idle` | TeammateIdle (async) | stuck 워커 감지 (Agent Teams 영감) |
| `progress-check` | SessionEnd (async) | PROGRESS.md 갱신 권장 |
| `session-start` | SessionStart | yolo 모드 자동 감지 + `.pact/state.json` 캡처 (ADR-011) |

---

## 외부 영감

| 출처 | 흡수한 것 |
|---|---|
| [gstack](https://github.com/gauntlet-ai/gstack) | Cognitive 7 패턴, UX 3법칙, Confidence calibration, Coverage audit, Goodwill reservoir, plan-arch/plan-ui review 모드 |
| [TDD Guard](https://github.com/nizos/tdd-guard) | PreToolUse 차단 패턴 |
| Specmatic / OSSA | JSON Schema strict (`worker-status`, `task`) |
| Claude Code Agent Teams | TeammateIdle hook |
| Hook async pattern | 텔레메트리 분리 (post-edit-doc-sync, teammate-idle, progress-check) |

자세한 ADR(19개)은 [DECISIONS.md](./DECISIONS.md), 빌드 시 따른 Claude Code 사양 사실은 [docs/CLAUDE_CODE_SPEC.md](./docs/CLAUDE_CODE_SPEC.md).

---

## 릴리스 흐름 (v0.1 → v0.5.1)

| 버전 | 날짜 | 한 줄 |
|---|---|---|
| v0.1.0 | 2026-05-02 | 첫 공개. 5 매니저·17 명령·8 hooks·3 CLI·zero-dep |
| v0.2.0 | 2026-05-02 | yolo 자동감지·자기보고 검증·zero-dep 전환·reviewer 4 분할 (ADR-011~014) |
| v0.2.1 | 2026-05-03 | `pact slice` / `slice-prd` — 큰 PRD/TASKS 컨텍스트 폭발 fix |
| v0.3.0 | 2026-05-03 | Context-light SOT 시스템 (`tasks/*.md`, `contracts/{api,db,modules}/*.md`, `pact split-docs`, `pact context-map sync`, ADR-015~018) |
| v0.4.0 | 2026-05-04 | 워커 truncation fix (`maxTurns: 60`) + CLI 토큰 디시플린 (`-q`/`-n`/`-s`) |
| v0.4.1 | 2026-05-08 | **`pact run-cycle prepare/collect`** + 토큰 디시플린 6개 fix. 메인 turn 95→5. cache_read -94% |
| v0.5.0 | 2026-05-09 | **agent 모델 차등** (planner/architect=opus, coordinator=sonnet 등, ADR-019) + **병렬 도구 호출 지시** 8 agent에 추가 + `stop-verify` async (응답 즉시 반응) |
| v0.5.1 | 2026-05-10 | **hotfix**: 머지된 task가 다음 batch에 재선택되던 무한루프 차단. parse-tasks spread 순서 + `pact merge`가 task source에 `status: done` 자동 박기 |

전체 변경 사항은 [CHANGELOG.md](./CHANGELOG.md).

---

## 요구사항

- **Node.js 18+** (테스트는 v20 검증) — **외부 의존성 0** (zero-dep, ADR-013)
- **git 2.5+** (worktree 지원)
- **Claude Code** (Anthropic CLI)
- **Codex CLI** (선택, cross-review용)

## 디렉토리 구조

```
pact/
├── .claude-plugin/plugin.json    # 플러그인 매니페스트 + hook 등록
├── agents/                       # 8 서브에이전트 (planner, architect, coordinator,
│                                 # reviewer-code/task/arch/ui, worker)
├── commands/                     # 17 슬래시 명령
├── hooks/                        # 8 hook 스크립트
├── scripts/                      # CLI helper (worktree, merge, parse, validate, ...)
├── schemas/                      # JSON schemas (worker-status, task)
├── prompts/                      # 워커 시스템 프롬프트 템플릿
├── templates/                    # /pact:init이 사용자 프로젝트로 복사하는 4 문서
├── skills/init/                  # /pact:init 스킬 정의
├── bin/                          # pact CLI 진입점 + bin/cmds/*.js
├── docs/                         # CLAUDE_CODE_SPEC, WORKTREE_POLICY, context-map
├── test/                         # node:test 단위 테스트 (18 파일, 170 통과)
├── ARCHITECTURE.md               # 18 ADR 매트릭스 + 매니저 명세
├── DECISIONS.md                  # ADR 누적 로그
├── TASKS.md                      # 빌드 task (v1.0 완료)
├── CHANGELOG.md
└── batch-builder.js              # 충돌 감지·배치 알고리즘 (reference)
```

## 알려진 한계 (v1.0)

- **Brownfield 프로젝트**: 기존 코드 분석 X (`/pact:adopt` v1.1+)
- **다국어**: 한국어 사용자 향. v1.1+
- **Codex 외 어댑터**: 인터페이스만 열려 있고 v1.1+에서 Gemini/Cursor 추가
- **PRD 자동 변환**: `.docx`/`.pdf` 미지원 — `.md`로 변환 후 사용
- **monorepo 디스크 부담**: worktree 1개당 GB 가능. 동시 워커 수 default 3, max 5
- **OpenAPI 자동 검증**: v1.1+

## v1.0 out-of-scope (영구)

다음은 영원히 안 만든다 — 안전·철학 원칙:

- 머지 충돌 자동 해결 (안전 원칙)
- Cross-review 차단 게이트화 (의견만, 차단 X)
- Cross-review 결과 자동 적용 (사용자 명시 수용 후 fix task)
- LLM이 머지·배치 계획 실행 (결정적 작업은 CLI)
- 워커 6명 이상 동시 (디스크·인지부하)
- 풀스택 워커 타입 분리 (워커는 모듈 단위만)

미래 버전(v1.5/v2.0)으로 미룬 것은 [ARCHITECTURE.md](./ARCHITECTURE.md)와 [DECISIONS.md](./DECISIONS.md) 참조.

## 라이선스

MIT
