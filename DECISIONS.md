# DECISIONS — pact 빌드 중 발견·결정 누적

> ARCHITECTURE.md는 빌드 시작 시점의 설계 기록.
> 빌드 진행하며 발견되는 spec 제약·환경 사실·정책 변경은 여기에 ADR 형식으로 누적.
> 형식: ADR (Architecture Decision Record).

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
