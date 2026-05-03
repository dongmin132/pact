# pact

> Claude Code 위에 얹는 **계약 기반 AI 개발 운영 시스템**.
> 문서·계약·검증·worktree 격리 병렬 에이전트로 통제하는 플러그인.

[![tests](https://img.shields.io/badge/tests-103%2F103-brightgreen)](./test) [![version](https://img.shields.io/badge/version-0.1.0-blue)](./.claude-plugin/plugin.json)

---

## 한 줄 요약

`/pact:init`으로 프로젝트 시작 → 매니저 4명이 task 분해·계약 정의·병렬 워커 spawn·머지 게이트·회고를 자동화.

## v1.0 헤드라인

1. **Contract-first parallelization** — 계약 없이 병렬 X
2. **Git worktree 격리** — 같은 파일도 안전한 동시 수정
3. **Cross-tool second opinion** — Codex 의견 추가 (차단 X)
4. **결정적 작업 = CLI, 판단 = LLM** — `pact batch`/`pact merge`로 분리

## 5가지 철학 (절대 양보 X)

1. 문서 없이 코딩 X
2. 계약 없이 병렬화 X
3. 검증 없이 머지 X
4. 기록 없이 반복 X
5. 자동 반영 X — 자동 제안까지만 (propose-only)

---

## 설치

### 정석 (권장)

```bash
# pact 저장소 clone — npm install 불필요 (zero deps, ADR-013)
git clone https://github.com/dongmin132/pact.git ~/pact

# 본인 프로젝트 디렉토리에서:
claude --plugin-dir ~/pact
```

### Marketplace 설치 (다른 사용자)

```bash
/plugin marketplace add github:dongmin132/pact
/plugin install pact@pact-marketplace
```

명령 namespace: `/pact:init`, `/pact:plan` 등.

### 빠른 dogfooding (개발용)

```bash
# 본인 프로젝트의 .claude/에 심볼릭 링크
cd /path/to/your/project
mkdir -p .claude
ln -s ~/pact/commands .claude/commands
ln -s ~/pact/agents .claude/agents
ln -s ~/pact/hooks .claude/hooks
ln -s ~/pact/scripts .claude/scripts
ln -s ~/pact/schemas .claude/schemas
ln -s ~/pact/templates .claude/templates
ln -s ~/pact/prompts .claude/prompts
ln -s ~/pact/bin .claude/bin
ln -s ~/pact/node_modules .claude/node_modules
```

`.claude/settings.local.json`에 환경변수 박기:
```json
{
  "env": { "CLAUDE_PLUGIN_ROOT": "/Users/<you>/pact" }
}
```

---

## 빠른 시작

```bash
mkdir myproject && cd myproject
git init -b main
echo "# myproject" > README.md && git add . && git commit -m init

claude --plugin-dir ~/pact

# Claude Code 안에서:
/pact:init                            # 4개 문서 + .pact/ 생성, 스택 자동 감지
/pact:plan "사용자 인증 추가"          # planner가 task 분해 → TASKS.md
/pact:contracts                       # architect가 API/모듈 계약 정의
/pact:plan-task-review                # 분해 품질 검토 (옵션)
/pact:parallel                        # 워커 N개 병렬 spawn → 머지 → 통합
/pact:verify                          # 4축 검증
/pact:reflect                         # 사이클 회고
```

---

## 핵심 개념

### 2계층 구조

```
[매니저 4명 — 항상 살아있음]
  planner → architect → coordinator → reviewer
                            ↓ (build phase)
[워커 — 일회용, 병렬, N개]
  각자 자기 worktree에서 작업, status.json으로 보고
```

- **planner**: 요구사항 → 검증 가능한 task로 분해
- **architect**: API/DB/모듈 경계 계약 정의
- **coordinator**: 배치 검토·결과 통합·회로 차단기
- **reviewer**: 4가지 모드 (code-review·plan-task·plan-arch·plan-ui)

### Worktree 격리

```
myproject/
├── src/                          # 메인 작업 트리 (main branch)
├── .pact/
│   ├── worktrees/PACT-001/       # 워커1 격리 작업장
│   ├── worktrees/PACT-002/       # 워커2 격리 작업장
│   ├── runs/PACT-001/status.json # 워커 보고
│   ├── batch.json                # pact batch CLI 출력
│   └── merge-result.json         # pact merge 결과
└── ...
```

같은 파일도 다른 worktree에서 동시 수정 OK. 충돌은 `pact merge` 시점에 git이 감지 → 사용자 위임.

### Contract-First 검증

워커 보고는 JSON Schema로 강제:
```json
{
  "task_id": "PACT-042",
  "status": "done | failed | blocked",
  "files_attempted_outside_scope": [...],
  "verify_results": { "lint": "pass", ... },
  "tdd_evidence": { "red_observed": true, "green_observed": true }
}
```

형식 위반 → `pact merge` CLI가 자동 거부.

### TDD 강제 (선택)

`tdd: true` task에서 코드 파일 신규 작성 시 대응 테스트 파일 없으면 `pre-tool-guard` hook이 차단.

---

## 슬래시 명령 (17개)

| 명령 | 책임 |
|---|---|
| `/pact:init` | 프로젝트 초기화 (4 문서 + .pact/ 생성, 스택 자동 감지) |
| `/pact:plan` | 요구사항 → tasks (PRD 입력 가능: `--from docs/PRD.md`) |
| `/pact:contracts` | architect 호출, API·모듈 계약 정의 |
| `/pact:plan-task-review` | task 분해 품질 검토 |
| `/pact:plan-arch-review` | 아키텍처 + 계약 정합성 (gstack 영감) |
| `/pact:plan-ui-review` | UI 디자인 차원 (gstack 영감) |
| `/pact:cross-review-plan` | Codex에게 plan 의견 (P2.5+) |
| `/pact:cross-review-code` | Codex에게 cycle diff 의견 |
| `/pact:parallel` | 워커 N개 spawn → 머지 → 통합 |
| `/pact:verify` | 4축 검증 (Code·Contract·Docs·Integration) |
| `/pact:status` | 진행 상황 표시 |
| `/pact:abort` | 진행 중 cycle 강제 중단 |
| `/pact:resume` | 회로 차단된 task 재시도 |
| `/pact:reflect` | 사이클 회고 (propose-only) |
| `/pact:resolve-conflict` | 머지 충돌 사용자 해결 워크플로우 |
| `/pact:worktree-status` | worktree 목록·디스크 사용량 |
| `/pact:worktree-cleanup` | 고아 worktree 일괄 삭제 |

## CLI

`pact` 바이너리 — 결정적 작업용:

```bash
pact batch    # TASKS.md 또는 tasks/*.md → .pact/batch.json
pact merge    # status.json 검증 + 머지 게이트
pact status   # state.json + worktree 표시
pact slice    # task corpus를 섹션 단위로 읽기 (--headers, --ids, --tbd)
pact split-docs  # legacy 긴 TASKS/API/DB 문서를 shard로 분리
```

## Context-light SOT

긴 문서는 SOT로 보관하되 기본 컨텍스트에는 올리지 않는다.

```text
docs/context-map.md          # 명령별 read profile
tasks/<domain>.md            # task shard
contracts/manifest.md        # contract shard index
contracts/api/<domain>.md    # API contract shard
contracts/db/<domain>.md     # DB contract shard
```

`/pact:contracts`와 review 계열 명령은 `docs/context-map.md` → `pact slice --headers` → 선택 task의 `context_refs` 순서로 읽는다.

워커 spawn 시에는 `.pact/runs/<task_id>/context.md`가 생성된다. 워커는 이 작은 bundle을 먼저 읽고, 긴 SOT 문서는 추가 확인이 필요할 때만 섹션 단위로 연다.

기존 프로젝트에 이미 긴 `TASKS.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`가 있다면:

```bash
pact split-docs --dry-run
pact split-docs
```

원본 legacy 파일은 삭제하지 않고 shard 파일만 생성한다.

## Hooks (7개)

- `pre-tool-guard` — MODULE_OWNERSHIP 위반 차단 (PreToolUse)
- `tdd-guard` — TDD 위반 차단 (PreToolUse, TDD Guard 영감)
- `post-edit-doc-sync` — 문서 갱신 알림 (async)
- `stop-verify` — uncommitted 코드 변경 알림
- `subagent-stop-review` — 워커 status.json 의심사항 감지
- `teammate-idle` — stuck 워커 감지 (Agent Teams 영감, async)
- `progress-check` — 세션 종료 시 PROGRESS 갱신 권장 (async)

---

## 외부 영감

| 출처 | 흡수한 것 |
|---|---|
| [gstack](https://github.com/gauntlet-ai/gstack) | Cognitive 7 패턴, UX 3법칙, Confidence calibration, Coverage audit, Goodwill reservoir |
| [TDD Guard](https://github.com/nizos/tdd-guard) | PreToolUse 차단 패턴 |
| Specmatic / OSSA | JSON Schema strict (worker-status, task) |
| Claude Code Agent Teams | TeammateIdle hook |
| Hook async pattern | 텔레메트리 분리 |

자세한 결정 사유는 [DECISIONS.md](./DECISIONS.md).

---

## 요구사항

- Node.js 18+ (테스트는 v20 검증) — **외부 의존성 0** (zero-dep)
- git 2.5+ (worktree 지원)
- Claude Code (Anthropic)
- Codex CLI (선택, cross-review용)

## 디렉토리 구조

```
pact/
├── .claude-plugin/plugin.json    # 플러그인 매니페스트
├── agents/                        # 5 서브에이전트 (planner, architect, ...)
├── commands/                      # 15+ 슬래시 명령
├── hooks/                         # 7 hook 스크립트
├── scripts/                       # CLI helper (worktree, merge, parse, ...)
├── schemas/                       # JSON schemas (worker-status, task)
├── prompts/                       # 워커 시스템 프롬프트 템플릿
├── templates/                     # /pact:init이 사용자 프로젝트로 복사
├── bin/                           # pact CLI 진입점
├── docs/                          # CLAUDE_CODE_SPEC, WORKTREE_POLICY, context-map
├── test/                          # node:test 단위 테스트
├── ARCHITECTURE.md                # 18개 결정 매트릭스
├── DECISIONS.md                   # ADR 누적
├── TASKS.md                       # 빌드 task (v1.0 완료)
└── batch-builder.js               # 충돌 감지·배치 알고리즘
```

## 알려진 한계 (v1.0)

- **Brownfield 프로젝트**: 기존 코드 분석 X (`/pact:adopt` v1.1+)
- **다국어**: 한국어 사용자 향. 다국어 v1.1+
- **Codex 외 어댑터**: 인터페이스만 열려있고 v1.1+에서 Gemini/Cursor 추가
- **PRD 자동 변환**: .docx/.pdf 미지원 — .md로 변환 후 사용
- **monorepo 디스크 부담**: worktree 1개당 GB 가능. 동시 워커 수 default 3, max 5
- **OpenAPI 자동 검증**: v1.1+

## v1.0 out-of-scope (영구)

- 자동 컨텍스트 압축 (v1.5)
- 자동 진화·자기 수정 skill (v2.0)
- 머지 충돌 자동 해결 (안전 원칙)
- Cross-review 차단 게이트화 (영구 X)
- LLM이 머지·배치 계획 실행 (영구 X)
- 워커 6명 이상 동시 (영구 X)

## 라이선스

MIT
