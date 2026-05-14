# Changelog

## v0.6.1 — 2026-05-14

`pact run-cycle prepare/collect` 멱등화. 멀티세션에서 "orchestrator 한 세션" 제약 제거 — 누구든 안전하게 호출 가능.

### 배경

v0.6.0 멀티세션 SDK 후 dogfooding 중 발견: prepare/collect는 여전히 한 세션에서만 안전하게 호출 가능. 두 세션이 동시 prepare 부르면 batch.json 동시 write·worktree 충돌. 사용자가 "메인 세션" 개념을 두는 게 부담스럽다는 피드백.

### 추가

- **`.pact/cycle.lock`** 기반 사이클 lock (prepare/collect 동시 호출 차단)
  - `scripts/lock.js`에 `acquireCycleLock` / `releaseCycleLock` / `readCycleLock` / `cycleLockPath` 추가
  - stale takeover (죽은 PID 잡은 lock은 자동 인계)
  - `cleanStaleLocks`가 cycle lock도 청소
- **`pact run-cycle prepare` 멱등**
  - `.pact/current_batch.json` + 모든 task의 worktree·prompt.md 존재하면 → `already_prepared: true` 반환
  - `--force`로 무시 가능
  - lock 획득 전 preflight 먼저 (lock 파일 생성이 clean tree 검사 깨지 않게)
- **`pact run-cycle collect` 멱등**
  - `current_batch.json` 없으면 → `already_collected: true` 반환 (이전 동작: 실패)
  - lock으로 동시 collect 차단

### 사용

```
세션 A: pact run-cycle prepare    # 첫 호출 — 정상 진행
세션 B: pact run-cycle prepare    # 두 번째 — already_prepared skip
세션 A or B: pact run-cycle collect # 어느 세션이든 한 번만 실행됨
```

"orchestrator 세션" 개념 사라짐. 모든 세션이 동등하게 prepare/collect 호출 가능.

### Breaking Changes

- `pact run-cycle collect` (current_batch 없음 케이스): 이전엔 exit 1 + `stage: no-current-batch`. v0.6.1부터 exit 0 + `already_collected: true`.
  - 영향: 이 케이스를 실패로 분기하던 호출자 코드 (없을 가능성 높음). pact 내부에선 없음.

### 테스트

- 198 → 204 (+6)
  - cycle lock: acquire 3 + release 1 + cleanStale 1
  - run-cycle 멱등: prepare 두 번 호출 시 already_prepared, collect 시 already_collected

---

## v0.6.0 — 2026-05-13

멀티세션 sibling 패턴 SDK. cmux/tmux 등으로 여러 Claude Code 세션을 진짜 OS 프로세스 병렬로 굴리는 모드 추가. sub-agent 패턴과 공존.

### 동기

기존 sub-agent 패턴(Task tool로 자식 conversation spawn)은 부모 메인 컨텍스트에 워커 prefix가 일부 누적. v0.4.1 run-cycle CLI로 95→5 turn 압축했지만 누적 0은 못 함. 사용자 요청: "진짜로 N개 세션을 동시 실행"으로 메인 누수 0 달성.

### 추가

- **`scripts/lock.js`** — `.pact/runs/<id>/lock.pid` 파일 기반 멀티세션 점유 락
  - `acquireLock` — fresh / takeover(stale PID) / 거부(살아있는 holder) 3가지 동작
  - `releaseLock` — 자기 PID 일치 시만 삭제 (다른 세션 lock 보호), `--force` 옵션
  - `releaseAllByPid` — 자기 PID 잡은 락 일괄 해제
  - `cleanStaleLocks` — 죽은 PID 잡은 락 일괄 정리
  - `listLocks` — alive/stale 표시
- **`pact claim <task_id> [--session <label>] [--json]`** — 명시적 점유 + 다음 단계 안내(worktree·prompt·context 경로)
- **`pact next [--all] [--json]`** — 현재 batch에서 미점유 task 한 개 (또는 전체) 출력
- **`pact status --watch [SECS]`** — 주기 폴링(default 2s)으로 다른 세션 진행·lock 상태 실시간 보기
- **`commands/multi-session.md`** — `/pact:multi-session` 슬래시 명령 가이드
- **session-start / progress-check hook** — stale lock 자동 청소 (이전 세션 비정상 종료 잔재)

### 멀티세션 흐름

```
[메인 세션]
  pact run-cycle prepare              # 기존 — batch + worktree + payload 준비
  pact next                           # 미점유 task ID 한 개

[워커 세션 (각자 cmux/tmux 패널)]
  pact claim PACT-001 --session 'pane:0.1'
  cd .pact/worktrees/PACT-001/
  claude                              # 새 세션, prompt.md 첫 입력
  # ... 작업 ... status.json + report.md 남기고 종료

[메인 세션]
  pact status --watch                 # 진행 모니터
  pact run-cycle collect              # 모든 워커 종료 후 머지 + cleanup
```

### sub-agent 패턴과 비교

| | sub-agent (Task tool) | 멀티세션 (이번 patch) |
|---|---|---|
| spawn | 부모 conversation 내부 | OS 프로세스 N개 |
| 메인 컨텍스트 누수 | 일부 누적 | **0** |
| 모니터링 | 메인 turn마다 | 파일 polling (`pact status --watch`) |
| 사용자 인터랙션 | 메인이 게이트 | 각 세션 자율 (yolo 권장) |
| Hooks | 부모 컨텍스트 hooks | 각 세션 독립 |

### 안전망

- 같은 task 중복 시작: `acquireLock`이 살아있는 PID 검사로 거부
- 비정상 종료 stale lock: SessionStart/SessionEnd hook이 자동 정리
- 머지 race: 머지는 메인 단일 지점(`pact run-cycle collect`)에서만

### 테스트

- 184 → 198 통과 (+14: isAlive 3 + acquireLock 4 + releaseLock 3 + releaseAllByPid 1 + cleanStaleLocks 1 + listLocks 1 + 회귀 1)

### ADR

- **ADR-020** — 멀티세션 sibling 패턴 (sub-agent 패턴과 공존)

### Breaking Changes

- 없음. sub-agent 패턴 그대로 작동. 멀티세션은 opt-in (사용자가 `pact claim` + 새 세션 시작 시에만).

---

## v0.5.2 — 2026-05-12

사이클 종료 후 사용자의 직접 수정과 contracts/PROGRESS의 표류(drift)를 두 시점에서 잡는다.

### 증상

`/pact:parallel` 끝나서 contracts/api/auth.md가 박혔는데, 사용자가 응답 형식을 직접 손대고 contracts 안 갱신. 다음 사이클 워커가 옛 contracts 믿고 잘못 짬.

### 추가

- **`hooks/stop-verify.js`**: turn 끝마다 git status 분류 — 코드 변경 있고 contracts/PROGRESS/MODULE_OWNERSHIP/tasks 변경 0개면 "문서 표류 가능" 별도 알림 추가. async라 응답 흐름 방해 X.
- **`commands/reflect.md`**: 단계 1.5 신설 — `.pact/merge-result.json`의 timestamp 이후 `git log --since`로 변경 파일 수집, planner reflect 모드 prompt에 CODE_CHANGED / DOCS_CHANGED 전달. 회고 출력에 "Docs Drift" 섹션 추가.

### 동작 시점

| 시점 | 어디서 잡나 |
|---|---|
| 매 turn 끝 | `stop-verify`가 단발 알림 (가벼움) |
| 사이클 회고 | `/pact:reflect`가 마지막 머지 이후 누적 분석 (정밀) |

### 테스트

- 177 → 184 통과 (+7: `stop-verify`의 `classifyChanges`/`extractPath` 7개 시나리오)
- pure 함수로 추출해서 hook 본체와 분리

### Breaking Changes

- 없음. 알림만 추가, 차단 X.

---

## v0.5.1 — 2026-05-10

`/pact:parallel` 무한루프 hotfix. 머지 완료된 task가 다음 batch에 다시 잡히던 문제를 두 단계로 차단.

### 증상

BOOT-001 머지 성공 → 다음 사이클이 다시 BOOT-001을 batch에 넣음. cycle 진행 불가.

### 원인 (두 단계)

1. **`scripts/parse-tasks.js:113-119`** — `{...parsed, status: 'todo', retry_count: 0}` spread 순서. yaml frontmatter의 `status: done`이 hardcoded `'todo'`로 덮어씌워짐.
2. **task source에 `done`을 박는 코드가 부재** — 워커는 `.pact/runs/<id>/status.json`에 done 기록, `pact merge`는 git 머지만 함. `tasks/<domain>.md`의 yaml은 영원히 `todo`. 다음 cycle batch-builder가 `t.status === 'done'`으로만 제외하므로 머지된 task 재선택.

### Fix

- `scripts/parse-tasks.js`: spread 순서 정정. `status`/`retry_count` default를 spread 앞에 두고, `id`/`title`은 spread 뒤에 두어 헤더 값 보호.
- `scripts/task-sources.js`: `setTaskStatus(taskId, status, opts)` helper 추가. yaml 블록에 `status:` 라인 있으면 replace, 없으면 append. tasks/*.md shard와 legacy TASKS.md 모두 지원.
- `bin/cmds/merge.js`: `mergeAll` 성공 후 `result.merged.forEach(id => setTaskStatus(id, 'done'))`. 충돌·skipped는 건드리지 않음 (재시도 가능 상태 보존). `merge-result.json`에 `status_updates` 필드 누적.

### 즉시 unblock (v0.5.0 사용자)

`tasks/<domain>.md`의 머지된 task yaml 블록에 `status: done` 한 줄 수동 추가. v0.5.1 적용 후엔 자동.

### 테스트

- 172 → 177 통과 (+5: parse-tasks 회귀 2개, setTaskStatus 5개 중 3개는 task-sources 테스트로 흡수)

### Breaking Changes

- 없음. yaml에 `status:` 라인이 없던 task는 default 'todo'로 동일 동작. v0.5.0에서 머지 후 멈춘 사이클은 즉시 unblock 절차로 풀림.

---

## v0.5.0 — 2026-05-09

서브에이전트별 모델 차등 매핑. 이전엔 8개 agent 전부 `model: inherit` (메인과 동일 모델) → 큰 batch에서 비용 비효율. 이번 릴리즈는 superpowers의 3계층 가이드(cheap/standard/most capable)를 pact 8개 역할에 매핑.

### 매핑

**Opus (판단 영역)**:
- `planner` — 요구사항 → task 분해 (잘못되면 나머지 다 망감)
- `architect` — 시스템 설계 결정
- `coordinator` — 배치 검토 + 결과 통합 + 충돌 판단 (silent failure 위험)
- `reviewer-arch` — 아키텍처 plan 검토 ("lock in" 단계)

**Sonnet (실행/검토 영역)**:
- `worker` — 단일 task 구현 (대부분 mechanical)
- `reviewer-task` — task 분해 검토
- `reviewer-code` — 머지 후 4축 검증
- `reviewer-ui` — UI/UX 검토

### 원칙

워커는 가볍게(sonnet), 워커를 통제하는 매니저·검토자는 강하게(opus). sonnet 워커가 흔들려도 opus reviewer가 잡아냄 (체크 효과).

### 효과 추정

- 큰 batch (5 worker 동시) 기준 **약 40-50% 비용 절감**
- worker spawn 시 첫 토큰 빠름 (Sonnet < Opus)
- coordinator·planner는 그대로 opus라 *판단 품질은 유지*

## v0.4.1 — 2026-05-08

메인 turn 압축 통합 CLI 도입 + 토큰 디시플린 6개 fix.

batch15 실측 (11.3M cache_read / cycle) 분석 결과 누수 96%가 메인 prefix 누적이었음. 이번 릴리즈는 그 패턴을 구조적으로 차단.

### 새 CLI: `pact run-cycle prepare/collect`
- `/pact:parallel`의 결정적 작업(사전검사·worktree·payload·status수집·머지·cleanup)을 두 CLI에 응집. 메인 LLM 도구 호출 turn 수 95→5 압축.
- `prepare`: preflight + buildBatches + worktree 생성 × N + payload·prompt 렌더 (atomic 롤백). stdout JSON으로 `task_prompts`·`coordinator_review_needed`·`context_warnings` 반환.
- `collect`: planMerge → mergeAll → cleanup + `verification_summary`·`decisions_to_record` 요약.
- `commands/parallel.md` 재작성 (291→101줄, -65%) — run-cycle 호출 + Task tool ×N spawn 흐름.

### 토큰 디시플린 (메인 prefix 누적 차단)
- **`commands/parallel.md` 1차 압축** (291→124, 1차) → 2차 재작성 (124→101). 이전 7.1k 토큰 본문이 매 turn cached read로 누적되던 단일 최대 누수원 차단.
- **`agents/worker.md` ↔ `prompts/worker-system.md` 통합**: TDD 단계·status.json schema·anti-pattern을 양쪽에서 50%+ 중복 정의하던 것을 분리. 198→86줄(-57%) + 199→49줄(-75%) = 워커 spawn당 ~3.3k 절감.
- **`pre-tool-guard` 차단 목록 확장**: `ARCHITECTURE.md`/`DECISIONS.md` 추가. 워커가 통째 read 시도 시 차단 + rg/sed 안내 (전체 7개 큰 SOT 차단).
- **작은 batch coordinator review 스킵 게이트**: `batches[0].length ≤ 2 && skipped.length === 0`이면 LLM 검토 생략 (CLI가 이미 결정적 검증).
- **`pact status --summary` / `-s`**: 단일 라인 요약 (`cycle:N active:N worktree:N merge:clean`). PROGRESS.md 통째 cat 대체.
- **worktree 생성 시 `node_modules` symlink 자동**: 워커가 tsx/tsc 경로 디버깅하던 ~12 turn × 누적 prefix = ~150k 누수 원천 제거. `opts.linkNodeModules: false`로 opt-out.

### Refactor
- `bin/cmds/merge.js`: `planMerge(opts)` pure 함수 추출 (run-cycle이 직접 호출). 기존 CLI handler는 그대로 동작.
- `bin/cmds/context-guard.js`: `collectLongDocs(maxLines, opts)` export + cwd 옵션 지원.

### 효과 추정 (batch15 11.3M baseline 기준)
- run-cycle (turn 수 95→5): cache_read **~94% 감소** (700k 추정). 단일 최대 lever.
- parallel.md 압축 (1차+2차): cycle당 ~300k cache_read 감소.
- node_modules symlink: 디버깅 cycle 자체 제거 = ~150k 감소.
- 합계: 11.3M → ~700k-1M (~91~94% 감소).

### 테스트
- 161 → 170 통과 (+9: 6 run-cycle 시나리오 + 3 worktree symlink + 2 status --summary).

### Breaking Changes
- 없음. `commands/parallel.md` 흐름이 바뀌었지만 기존 모든 CLI/agent/hook 동작 무영향.

### 호환성
- `pact merge`/`pact batch` CLI는 기존과 동일 (run-cycle 내부에서 pure 함수로 호출).
- `agents/worker.md`/`prompts/worker-system.md` placeholder 호환 (renderPrompt 인터페이스 동일).

---

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
