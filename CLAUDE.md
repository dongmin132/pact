# pact — Claude Code 플러그인

> Claude Code 위에 얹는 **계약 기반 AI 개발 운영 시스템**.
> `/pact:init`으로 프로젝트 시작 → 문서·계약·검증·**worktree 격리 병렬** 에이전트 통제.

**v1.0 헤드라인 네 개**:
1. Contract-first parallelization — 계약 없이 병렬 X
2. Git worktree 기반 워커 격리 — 동일 파일도 안전한 동시 수정
3. Cross-tool second opinion — Codex 의견 추가 (차단 X)
4. **결정적 작업 = CLI, 판단 = LLM** — `pact batch`/`pact merge` 분리, .pact/ SOT

## 5가지 철학 (절대 양보 X)

1. 문서 없이 코딩하지 않는다
2. 계약 없이 병렬화하지 않는다
3. 검증 없이 병합하지 않는다
4. 기록 없이 반복하지 않는다
5. 자동 반영은 하지 않고, **자동 제안까지만** 한다

## 토큰 효율 4원칙 (모든 설계 결정의 가드레일)

1. 워커는 일회용 — 작업 후 컨텍스트 폐기
2. 문서 lazy-loading — 매니저는 필요한 문서만 그 시점에 read
3. 상태 압축 — PROGRESS.md가 single source of truth
4. 매니저↔워커 통신은 구조화 페이로드 (긴 자연어 X)

## 컨텍스트 로딩 규칙 (긴 문서 SOT)

- 긴 문서 전체를 기본 컨텍스트에 올리지 않는다.
- 먼저 `docs/context-map.md`를 보고 어떤 shard/섹션을 읽을지 정한다.
- `TASKS.md`, `ARCHITECTURE.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`, PRD는 통째 read 금지. `rg`, `sed`, `pact slice`, `pact slice-prd`로 필요한 섹션만 읽는다.
- 새 task SOT는 `tasks/*.md`, 새 API/DB contract SOT는 `contracts/api/*.md`, `contracts/db/*.md`다.
- 각 task에는 `context_refs`를 넣어 워커와 reviewer가 읽을 문서를 명시한다.

## 빌드 시작 전 필수 확인 (추측 금지)

다음 항목은 `docs.claude.com` 또는 해당 공식 문서 직접 확인 후 진행:

- `plugin.json` 정확한 스키마
- Hook 이벤트와 payload (특히 도구 호출 **차단** 가능 여부)
- Claude Code의 yolo 모드(`--dangerously-skip-permissions`) 감지 방법
- Codex CLI headless 모드 명령·옵션·출력 스키마

이 네 가지는 빠르게 변하는 영역이라 추측 시 어긋날 가능성 큼.

## 빌드 순서

1. **`ARCHITECTURE.md`를 먼저 read** — 18개 결정의 sourcing
2. **`TASKS.md`를 read** — 우선순위·의존성 기반
3. **P0 (Walking Skeleton) 우선** — `/pact:init` → `/pact:plan` → `/pact:parallel` → `/pact:verify` end-to-end 동작 확인 후 P1+로
4. 주요 phase 전환 시 **사용자에게 확인** (자동 진행 X)
5. `batch-builder.js`는 작성 완료된 reference — 재추론 X, 그대로 활용

## 작업 보고 형식 (이 프로젝트 자체에 적용)

새 파일 생성/수정 시 한국어로 다음 형식 보고:

1. **무엇을**: 어떤 파일을 만들었거나 수정했는지
2. **왜**: 이 파일이 왜 필요한지
3. **핵심 코드 설명**: 중요 블록마다 한국어로 "이 코드가 하는 일"
4. **연결 관계**: 다른 파일과 어떻게 연결되는지
5. **새로운 개념**: 처음 등장하는 개념 쉽게 설명

## 개발 방식

- **TDD**: 비즈니스 로직 task 기본 ON (RED → GREEN → REFACTOR)
- **TDD opt-out**: 마크다운/설정/마이그레이션은 명시적 `tdd: false`
- **회로 차단기**: 2회 실패 시 사용자 위임 (자동 루프 금지)

## 언어 정책

- **사용자 향**: 한국어 (출력 메시지, 학습 노트, 채팅 보고)
- **코드 / 식별자 / frontmatter key**: 영어 (`task_id`, `worker_type` 등)
- 다국어는 v1.0 scope 아님

## 명시적 v1.0 Out-of-Scope

이거 만들지 말 것:

- 자동 컨텍스트 압축 (v1.5)
- 자동 진화·자기 수정 (v2.0)
- Brownfield 프로젝트 지원 (`/pact:adopt` v1.1)
- OpenAPI 자동 검증 도구 (v1.1+)
- 다국어 (v1.1+)
- 마켓플레이스 배포 (v1.1+)
- 풀스택 워커 타입 분리 — **워커는 모듈 단위로만 분기**
- **머지 충돌 자동 해결 — 영구 X (안전 원칙)**
- **Cross-review 차단 게이트화 — 영구 X (의견만, 차단 X)**
- **Cross-review 결과 자동 적용 — 영구 X (사용자 명시 수용 후 fix task)**
- **Cross-review 어댑터 v1.0은 Codex만 — Gemini/Cursor 등은 v1.1+**
- **PRD 자동 변환 (.docx/.pdf/Notion 등) — 사용자가 .md로 변환 후 사용**
- **PRD 자동 인덱싱·요약 — v1.1+**

## 의문 시 행동 룰

- 결정 안 된 사항: 사용자에게 질문, 추측 금지
- ARCHITECTURE.md / TASKS.md와 모순 발생: ARCHITECTURE.md 우선
- v1.0 scope 초과 욕심: 즉시 멈추고 사용자에게 "v1.0인지 v1.1인지" 확인
