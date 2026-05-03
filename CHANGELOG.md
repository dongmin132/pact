# Changelog

## v0.4.0 — 2026-05-04

워커 truncation 한계 해소 + CLI 토큰 디시플린.

### 워커-side 수정
- **`agents/worker.md`**: `maxTurns: 30 → 60`. cycle 1 측정 결과 워커들이 RED+GREEN+verify+commit+status 한 번에 못 마치고 30~50 tool_use 부근에서 잘려 메인이 마무리하는 패턴 반복. 60으로 올려 정상 종료 가능하게.
- **`hooks/pre-tool-guard.js`**: 프로젝트 루트 밖 경로(예: `/tmp/foo`, `~/.claude/plugins/...`) Edit/Write 시도 시 MODULE_OWNERSHIP에 없다고 차단하던 false positive 해소. 이제 cwd 기준 상대경로가 `..`로 시작하거나 절대경로면 ownership 검사 건너뜀.

### CLI 토큰 디시플린 (메인 conversation context 절감)
- **`pact merge --quiet` / `-q`**: rejected 리스트(보통 28~31건)를 stderr 1줄 요약으로 압축. stdout에는 머지 성공만. `merge-result.json`에는 그대로 풀버전 기록.
- **`pact batch --next` / `-n`**: 전체 batch 19개 dump 대신 `batches[0]` 한 줄만. 잘못된 batch 선택 방지 + 출력 압축.
- **`pact context-guard --quiet` / `-q`**: 8줄 경고 → 1줄 요약 (`context-guard ok` 또는 `context-guard warn: N long doc(s)`).

### 측정 (사용자 환경)
- batch 15 (룰 X) → batch 16 (CLAUDE.md §8 운영 룰 O): 1회 /pact:parallel 토큰 442k → 256k (-42%). 본 v0.4 CLI 패치로 추가 절감 기대.

## v0.3.0 — 2026-05-03

Context-light SOT 시스템 안정화 + 자기 review 라운드 수정.

### 추가 (4 ADR)
- **ADR-015~017** (앞 커밋에서): tasks/contracts shard, worker context bundle, split-docs 마이그레이션
- **ADR-018**: `MODULE_OWNERSHIP.md` → `contracts/modules/<domain>.md` shard (API/DB와 일관)
- **`pact context-map sync`** CLI — Domains 표만 현재 shard 상태로 재생성 (idempotent, prose 보존)

### 변경
- `task-sources.js` frontmatter — silent overwrite → 첫 번째만 채택, 충돌은 error로 보고
- `pact split-docs`가 task 메타데이터(`contracts.api_endpoints`, `contracts.db_tables`, allowed_paths)에서 `context_refs` 자동 주입
- `pact split-docs`가 `MODULE_OWNERSHIP.md`도 분할 (`contracts/modules/<domain>.md`)
- `contracts/manifest.md`에 Modules 표 추가
- `pre-tool-guard` hook이 legacy `MODULE_OWNERSHIP.md` + `contracts/modules/*.md` 합집합으로 검증
- architect prompt에 Step 5 (`pact context-map sync` 호출) 명시
- `/pact:contracts`가 새 `contracts/modules/` 디렉토리도 mkdir
- ADR-017에 PRD 자동 분할은 v1.1+ scope임을 명시

### 호환성
- legacy 단일 파일 (`MODULE_OWNERSHIP.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`, `TASKS.md`) 그대로 인식
- 기존 frontmatter 구조 동일 (충돌 시 첫 shard만 채택은 새 동작)

### 테스트
- 145/145 통과 (137 → +8: split-docs context_refs, modules 분리, context-map sync idempotent, task-sources frontmatter conflict, ownership shard 합집합)

---

## v0.2.1 — 2026-05-03

긴급 patch — 큰 PRD/TASKS 컨텍스트 폭발 fix.

### 추가
- **`pact slice` CLI** — TASKS.md 슬라이스 (`--status`, `--priority`, `--ids`, `--tbd`, `--headers`)
- **`pact slice-prd` CLI** — PRD 섹션 추출 (`--section`, `--sections`, `--headers`, `--refs-from`)

### 변경
- 모든 매니저 agent prompt에 **"큰 파일 통째 read 금지"** 강제
- planner·architect·reviewer-* 모두 slice/grep/sed 패턴 사용
- parse-tasks.js: `### TASK-XXX` (3 hashes) 헤더도 인식 (양쪽 호환)

### 효과
- 큰 PRD (1500+줄) + 큰 TASKS (1000+줄) 환경에서 매니저 호출 가능해짐
- review·plan 호출 시 컨텍스트 80%+ 절감

### 호환성
- 기존 사용자 영향 없음 (agent 행동만 변경, API 동일)


## v0.2.0 — 2026-05-02

v0.1.0 출시 후 즉시 보강. zero-dependency + 핵심 보안 fix + agent 분할.

### 추가 (5개 ADR)
- **ADR-011**: yolo 모드 자동 감지 (`permission_mode` 필드 활용, ADR-002 폐기)
- **ADR-012**: 워커 자기 보고 신뢰 X — 실제 git diff vs payload.allowed_paths 대조
- **ADR-013**: zero-dependency 전환 (js-yaml·ajv 제거, hand-written 대체)
- **ADR-014**: reviewer 4 분할 (reviewer-code/task/arch/ui) + 8 agent gstack 패턴 polish

### 보안·견고성
- `pact merge`가 status.json 신뢰 X, 실제 diff와 allowed_paths 대조
- `pre-tool-guard` hook이 워커 worktree 경계 + per-task allowed_paths 사전 차단
- yolo 모드 자동 감지 + SessionStart 즉시 위험 알림
- worker status.json schema strict 강제

### 배포 친화
- npm install 불필요 (zero deps)
- 마켓플레이스 캐시에서 즉시 작동

### Breaking Changes
- `subagent_type`: `reviewer` → `reviewer-code | reviewer-task | reviewer-arch | reviewer-ui` (4개 분할)
- 기존 `agents/reviewer.md` 삭제됨

### 테스트
- 133/133 통과 (yaml-mini 11개 + detect-yolo 6개 + ADR-012 시나리오 1개 신규)

---

## v0.1.0 — 2026-05-02

첫 공개 릴리스.

### Highlights
- **계약 기반 병렬 워커** — git worktree 격리, 같은 파일도 안전한 동시 수정
- **결정적 작업 = CLI** (`pact batch`·`pact merge`·`pact status`), **판단 = LLM** (매니저 4명)
- **Zero-dependency** — npm install 없이 `git clone` 후 즉시 작동
- **한국어 UX** + 사용자 결정 게이트 (propose-only)

### 핵심 자산
- **5 매니저 서브에이전트**: planner, architect, coordinator, reviewer (4 mode), worker
- **17 슬래시 명령**: init, plan, contracts, plan-task/arch/ui-review, parallel, verify, status, abort, resume, reflect, resolve-conflict, cross-review-plan/code, worktree-status/cleanup
- **8 hooks**: pre-tool-guard, tdd-guard, post-edit-doc-sync, stop-verify, subagent-stop-review, teammate-idle, progress-check, session-start
- **pact CLI**: `pact batch`·`pact merge`·`pact status`
- **JSON Schema** strict (worker-status, task)
- **Marketplace 등록** (`.claude-plugin/marketplace.json`)

### 흡수한 외부 영감
- gstack: cognitive 7 패턴, UX 3법칙, confidence calibration, coverage audit
- TDD Guard (nizos): PreToolUse 차단 패턴
- Specmatic / OSSA: JSON Schema strict
- Claude Code Agent Teams: TeammateIdle hook
- Hook async pattern: 텔레메트리 분리

### ADR 13개 (DECISIONS.md)
1. Task tool working_dir 강제 불가 → post-hoc + pre-block 하이브리드
2. ~~Yolo 자동 감지 불가~~ (ADR-011로 supersede)
3. plugin.json 위치 `.claude-plugin/`
4. 매니저·워커 모델 `inherit`
5. Worktree 정책 W1~W3
6. worker prompt 단일 파일 통합
7. Worktree 정책 W4·W5
8. Plan-review 3개 재편성 (gstack 영감 자체 구현)
9. Contract-First / TDD Guard / Async hooks 도입
10. 슬래시 명령 16 → 17 확장
11. Yolo 모드 감지 가능 (`permission_mode` 발견, ADR-002 supersede)
12. 워커 자기 보고 신뢰 X, 실제 git diff 대조 강제
13. Zero-dependency 전환

### 테스트
- 133/133 통과
- 통합 테스트 3 시나리오 (정상 cycle / 충돌 / schema 위반·거짓 보고)

### 알려진 한계 (v1.0)
- Brownfield 미지원 (v1.1+)
- Codex 외 cross-review 어댑터 X (인터페이스만)
- PRD .md만 (.docx/.pdf 미지원)
- monorepo 디스크 부담
- yaml-mini 파서 우리 subset만 (anchors·multi-doc 등 미지원)

### 출처
- 외부 영감: README.md
- 빌드 사실: docs/CLAUDE_CODE_SPEC.md
- 결정 누적: DECISIONS.md
