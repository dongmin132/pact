# pact v1.0 — Build Tasks

> Claude Code 빌드용 task 분해. 우선순위·의존성 명시.
> P0 = Walking Skeleton (end-to-end 동작, **worktree 미포함**), P1 = 풀 v1.0 (**worktree 포함**), P2 = nice-to-have

## v1.0 일정 추정 (5-6주)

- **Week 1**: Spec 확인 (PACT-000) + Walking Skeleton (PACT-001~011, worktree 없음, 단일 워커)
- **Week 2**: Worktree 통합 (PACT-026~031) + 메인 Claude 워커 다중 spawn
- **Week 3**: Manager 풀 구현 (PACT-012~025) + .pact/ SOT 구조
- **Week 4**: Cross-review 통합 (PACT-032~037, Codex만)
- **Week 5**: PRD 통합 + pact CLI subcommands (PACT-038~042)
- **버퍼**: 1주 (총 6주)

각 주말마다 동작하는 시스템이 있도록 단계적 빌드.

---

## 진행 룰

1. **순서**: P0 → P1.5(worktree) → P1(매니저) → P2(cross-review) → P2.5(PRD/CLI)
2. 각 task는 ARCHITECTURE.md 해당 섹션을 sourcing
3. **빌드 시작 전 spec 확인 필수**:
   - `plugin.json` 스키마 → `docs.claude.com`
   - Hook 이벤트·payload → `docs.claude.com`
   - **서브에이전트 nesting 제약** (확인 완료: 불가능, §14)
   - **Task tool 다중 spawn 한도** (확인 완료: 최대 10, 우리 정책 5)
   - Claude Code의 yolo 모드 감지 → `docs.claude.com`
   - Codex CLI headless 모드 → Codex 공식 문서
   - `git worktree` 명령 동작 → 실제 환경에서 PoC
4. **Worktree 정책 5개(W1~W5)는 빌드 중 결정** — ARCHITECTURE.md §18.2의 default 우선 적용
5. **Cross-review v1.0은 Codex 어댑터만**
6. **결정적 작업은 코드(`pact batch`, `pact merge`), LLM은 판단만** — §15 #14·#15
7. **워커 결과는 .pact/runs/<id>/에 파일 저장** — 채팅 보고만 믿지 말 것 (§4.3)
8. 의문 시 사용자에게 질문, 추측 금지

---

## Phase 0 — Spec 확인 (필수 선행)

### PACT-000  Claude Code spec 확인 및 정리
```yaml
priority: P0
dependencies: []
files: [docs/CLAUDE_CODE_SPEC.md]
work:
  - docs.claude.com에서 plugin.json 스키마 fetch
  - hook 이벤트 종류와 payload 구조 fetch
  - subagent (Task tool) 사용법 fetch
  - 위 3개를 docs/CLAUDE_CODE_SPEC.md로 정리
done_criteria:
  - plugin.json 필수 필드 목록 명시
  - 사용 가능한 hook 이벤트 목록 명시
  - subagent 호출 인터페이스 명시
tdd: false
sourcing: ARCHITECTURE.md §7, §14
```

이게 안 되면 P0 시작도 위험. **반드시 첫 task**.

---

## Phase 1 — Walking Skeleton (P0)

목표: `/pact:init` → `/pact:plan` → `/pact:parallel` → `/pact:verify`가 stub 수준이라도 end-to-end로 동작.

### PACT-001  플러그인 매니페스트
```yaml
priority: P0
dependencies: [PACT-000]
files: [plugin.json]
work:
  - PACT-000에서 확인한 스키마대로 plugin.json 작성
  - 플러그인 이름: pact, 버전: 0.1.0
  - 슬래시 명령 등록 (init/plan/parallel/verify 4개만 우선)
done_criteria:
  - Claude Code에서 플러그인 인식
  - 4개 슬래시 명령 자동완성에 노출
tdd: false
```

### PACT-002  문서 템플릿 4종 (using project용)
```yaml
priority: P0
dependencies: []
files:
  - templates/CLAUDE.md
  - templates/PROGRESS.md
  - templates/TASKS.md
  - templates/DECISIONS.md
work:
  - pact를 사용하는 프로젝트가 받게 될 4개 문서 템플릿
  - PROGRESS.md는 ARCHITECTURE.md §5.3 형식 (현재 상태만)
  - TASKS.md는 task당 yaml 블록 형식
  - DECISIONS.md는 ADR 표준 포맷
done_criteria:
  - 빈 프로젝트에 4개 파일 복사 시 사람이 읽을 수 있는 시작점이 됨
  - yaml 블록 파싱 가능한 형식
tdd: false
sourcing: ARCHITECTURE.md §5
```

### PACT-003  /pact:init 명령 (기본)
```yaml
priority: P0
dependencies: [PACT-001, PACT-002]
files:
  - commands/init.md
  - skills/init/SKILL.md
work:
  - 인터랙티브 프롬프트로 프로젝트 정보 수집 (이름·목적·기술스택)
  - templates/* 복사하고 사용자 입력으로 채우기
  - 신규 프로젝트 가정 (기존 코드 분석 X — brownfield는 v1.1)
done_criteria:
  - 빈 디렉토리에서 /pact:init 실행 → 4개 문서 생성
  - 사용자에게 한국어로 진행 메시지 표시
tdd: false
sourcing: ARCHITECTURE.md §6, G7
```

### PACT-004  planner 서브에이전트
```yaml
priority: P0
dependencies: [PACT-002]
files: [agents/planner.md]
work:
  - 매니저 카드 ARCHITECTURE.md §3.1 그대로 구현
  - 입력: 사용자 요구사항
  - 출력: TASKS.md (task당 yaml 블록)
  - 규칙: task당 파일 ≤ 5, done criteria ≥ 1, TBD 마커 허용
done_criteria:
  - 사용자가 자연어로 요구사항 → planner 호출 → TASKS.md 생성
  - 모든 task가 ARCHITECTURE.md §4.2 spawn payload와 호환되는 필드
tdd: false  # agent 정의 자체는 TDD 면제
```

### PACT-005  /pact:plan 명령 (교육 모드 질문 포함)
```yaml
priority: P0
dependencies: [PACT-004]
files: [commands/plan.md]
work:
  - 사용자에게 교육 모드 ON/OFF 묻기 (옵션 A)
  - planner 서브에이전트 호출
  - 답변을 TASKS.md frontmatter에 기록
done_criteria:
  - /pact:plan "리포트 기능" 실행 → 교육 모드 질문 → TASKS.md 생성
  - frontmatter에 educational_mode 박힘
tdd: false
sourcing: ARCHITECTURE.md §10, NEW-1
```

### PACT-006  TASKS.md 파서
```yaml
priority: P0
dependencies: [PACT-002]
files: [scripts/parse-tasks.js]
work:
  - 마크다운에서 task별 yaml 블록 추출
  - batch-builder.js의 Task 인터페이스로 변환
  - TBD 마커 검출 (parallel 진입 게이트용)
done_criteria:
  - 실제 TASKS.md 파일 → Task[] 배열 변환
  - 잘못된 yaml은 명시적 에러
tdd: true  # 파서는 TDD 적합
```

### PACT-007  coordinator 서브에이전트 (단순 버전, 검토자 역할)
```yaml
priority: P0
dependencies: [PACT-006]
files: [agents/coordinator.md]
work:
  - .pact/batch.json 읽기 (pact batch CLI가 만든 결과)
  - 배치 계획의 의도 검토 (충돌 가능성·논리 오류 LLM 판단)
  - "OK" 또는 "수정 사유"를 메인 Claude에게 반환
  - 워커 종료 후 .pact/runs/*/status.json 통합 → PROGRESS.md 갱신
  - **단순 버전 - 명시 X 항목**:
    - worktree 처리 X (Phase 1.5에서)
    - 회로 차단기 X (P1에서)
    - 머지 결정 X (`pact merge` CLI에서)
  - **금지**:
    - 워커 직접 spawn (메인 Claude가 함, §14)
    - 머지 실행 (CLI가 함)
    - 배치 계획 생성 (`pact batch`가 함)
done_criteria:
  - .pact/batch.json 입력 → 검토 결과 반환
  - 워커 status.json 통합 → PROGRESS.md 갱신
  - 메인 Claude가 워커 spawn한 결과를 coordinator가 받아 통합
tdd: false
sourcing: ARCHITECTURE.md §3.3, §14
```

### PACT-008  워커 spawn 함수 (메인 Claude의 Task tool 호출)
```yaml
priority: P0
dependencies: [PACT-000]
files: 
  - scripts/spawn-worker.js  # 메인 Claude가 호출하는 헬퍼
  - prompts/worker-system.md # 워커 시스템 프롬프트 템플릿
work:
  - 메인 Claude가 한 메시지에서 Task tool 다중 호출하는 패턴 정립
  - Spawn payload (ARCHITECTURE.md §4.2의 worktree 필드 제외 버전) 구성
  - 워커 시스템 프롬프트에 allowed_paths/forbidden_paths 박기
  - 결과를 Worker Report (.pact/runs/<id>/status.json) 형식으로 정규화
  - **워커는 종료 시 반드시 status.json + report.md 파일 생성**
  - **단순 버전**: 한 번에 1개 워커. 다중 spawn은 Phase 1.5에서.
done_criteria:
  - 메인 Claude가 payload 입력 → Task tool 호출 → 정규화된 status.json 출력
  - 워커가 작업 끝에 .pact/runs/<id>/ 파일들 생성
  - allowed_paths 위반 시도가 status.json에 잡힘
tdd: true
sourcing: ARCHITECTURE.md §4, §14
```

### PACT-009  /pact:parallel 명령 (단순 버전)
```yaml
priority: P0
dependencies: [PACT-007, PACT-008]
files: [commands/parallel.md]
work:
  - 사전 게이트: TASKS.md 존재 + TBD 0개 검사
  - **review 확인 게이트** (parallel 진입 시 사용자에게 묻기)
  - coordinator 호출 (검토만, spawn은 메인 Claude)
done_criteria:
  - 게이트 통과 시 워커 spawn → Report 수집 → PROGRESS 갱신
  - 게이트 실패 시 명확한 한국어 에러
tdd: false
sourcing: ARCHITECTURE.md §3.3 (parallel 게이트)
```

### PACT-010  /pact:verify 명령 (단순 버전)
```yaml
priority: P0
dependencies: [PACT-002]
files: [commands/verify.md]
work:
  - using project의 verify 명령 (init 시 사용자가 등록한 것) 실행
  - 결과를 PROGRESS.md의 Verification Snapshot에 기록
  - **단순 버전**: 사용자 verify_command만 실행, 4축 검증은 P1
done_criteria:
  - /pact:verify → npm test (또는 등록된 명령) 실행 → PROGRESS 갱신
tdd: false
```

### PACT-011  Walking Skeleton 통합 테스트
```yaml
priority: P0
dependencies: [PACT-001~PACT-010]
files: [test/skeleton-e2e.test.js]
work:
  - 빈 디렉토리에서 시작
  - /pact:init → /pact:plan → /pact:parallel → /pact:verify 시퀀스
  - 사이클 1회 end-to-end 확인
done_criteria:
  - 자동 테스트 통과
  - PROGRESS.md가 사이클 결과 반영
  - 사용자 향 한국어 메시지 모두 자연스러움
tdd: true
```

**🛑 P0 게이트**: PACT-011 통과 후 사용자에게 **"P1.5(worktree 통합)로 진행할지, 여기서 검증·튜닝 더 할지"** 확인.

---

## Phase 1.5 — Worktree 통합 (P1, Week 2)

목표: walking skeleton에 git worktree 격리 추가. 동일 파일도 안전한 동시 수정 가능.

이 phase가 v1.0의 두 번째 헤드라인. ARCHITECTURE.md §18 sourcing.

### PACT-026  Worktree wrapper 모듈 + W1~W3 결정
```yaml
priority: P1.5
dependencies: [PACT-007]
files:
  - scripts/worktree-manager.js
  - docs/WORKTREE_POLICY.md
work:
  - git worktree add/remove/list 명령 wrapper
  - **W1 결정**: worktree 위치 (default: <repo>/.pact/worktrees/<task_id>)
  - **W2 결정**: branch 전략 (default: pact/<TASK-ID>)
  - **W3 결정**: base branch (default: 직전 cycle 결과)
  - .gitignore에 .pact/ 추가
  - 사용자 환경 검증 (git 2.5+, main 존재, uncommitted 검사)
  - 결정 사유는 DECISIONS.md에 기록
done_criteria:
  - createWorktree(taskId, baseBranch) → working_dir, branch_name 반환
  - removeWorktree(taskId) → 정리 (성공 시) 또는 보존 (실패 시)
  - listWorktrees() → 활성·고아 worktree 목록
  - 사용자 환경 부적합 시 명확한 한국어 에러
tdd: true
sourcing: ARCHITECTURE.md §18.2 W1~W3, §18.6
```

### PACT-027  Spawn payload·Report worktree 필드 + spawn-worker 확장
```yaml
priority: P1.5
dependencies: [PACT-026, PACT-008]
files:
  - scripts/spawn-worker.js (수정)
  - prompts/worker-worktree.md
work:
  - Spawn payload에 working_dir, branch_name, base_branch 필드 추가
  - 워커 시스템 프롬프트에 "이 worktree 안에서만 작업" 강제
  - Worker Report에 branch_name, commits_made, clean_for_merge 필드 추가
  - 워커가 자기 worktree 외부 접근 시도 시 보고서에 표시
done_criteria:
  - 워커가 working_dir 안에서 동작, 외부 접근 불가
  - 워커 작업 후 git diff가 commits_made와 일치
  - clean_for_merge=false면 머지 시도 안 함
tdd: true
sourcing: ARCHITECTURE.md §4.2, §4.3
```

### PACT-028  Merge coordinator + W4·W5 결정
```yaml
priority: P1.5
dependencies: [PACT-027]
files:
  - scripts/merge-coordinator.js
  - commands/resolve-conflict.md
work:
  - **W4 결정**: 머지 전략 (default: cycle 단위 atomic)
  - **W5 결정**: 충돌 처리 (default: 즉시 사용자 위임)
  - 모든 워커 종료 후 일괄 머지 시도
  - 충돌 감지 시 즉시 멈춤, 충돌 worktree 보존, 사용자 안내
  - /pact:resolve-conflict 명령 (사용자 충돌 해결 워크플로우)
  - 머지 성공 후 worktree 자동 삭제, 실패 worktree 보존
done_criteria:
  - 5개 워커 동시 작업 → 모두 main으로 머지 → 5개 worktree 정리
  - 의도적 충돌 케이스 → 사용자에게 명확히 안내, 자동 해결 X
  - /pact:resolve-conflict로 사용자가 해결 후 머지 재시도 가능
tdd: true
sourcing: ARCHITECTURE.md §18.2 W4~W5, §18.3, §18.4
```

### PACT-029  Worktree 관리 슬래시 명령 3개
```yaml
priority: P1.5
dependencies: [PACT-026]
files:
  - commands/worktree-status.md
  - commands/worktree-cleanup.md
  - commands/resolve-conflict.md  # PACT-028에서 만들었으면 보강만
work:
  - /pact:worktree-status: 활성·실패·고아 worktree 목록 + 디스크 사용량
  - /pact:worktree-cleanup: 고아 worktree 일괄 삭제 (사용자 확인 필수)
  - 1주 이상 미사용 worktree 자동 식별
done_criteria:
  - 각 명령이 한국어로 정확한 정보 출력
  - cleanup은 절대 사용자 확인 없이 삭제 X
tdd: false
sourcing: ARCHITECTURE.md §6, §18.4
```

### PACT-030  coordinator + 메인 Claude worktree 통합
```yaml
priority: P1.5
dependencies: [PACT-026, PACT-027, PACT-028]
files: [agents/coordinator.md (수정)]
work:
  - PACT-007의 단순 버전을 worktree 인지 버전으로 확장
  - 배치별 워커 spawn 시 worktree 자동 생성
  - 모든 워커 종료 후 merge-coordinator 호출
  - 실패 worktree 보존 + PROGRESS.md Blocked에 기록
done_criteria:
  - /pact:parallel 호출 → worktree 생성 → 워커 작업 → 머지 → 정리
  - cycle 1회 동안 5개 워커 동시 작업 + atomic 머지 성공
tdd: false
sourcing: ARCHITECTURE.md §3.3, §18.3
```

### PACT-031  Phase 1.5 통합 테스트
```yaml
priority: P1.5
dependencies: [PACT-026~030]
files: [test/worktree-e2e.test.js]
work:
  - 5개 워커 동시 worktree → 모두 머지 성공 시나리오
  - 의도적 충돌 → 사용자 위임 시나리오
  - 워커 실패 → worktree 보존 → /pact:resume 시나리오
  - 고아 worktree → /pact:worktree-cleanup 시나리오
done_criteria:
  - 4개 시나리오 모두 자동 테스트 통과
  - PROGRESS.md / DECISIONS.md 일관성 유지
tdd: true
```

**🛑 Phase 1.5 게이트**: PACT-031 통과 후 사용자에게 **"P1로 진행할지, worktree 정책 튜닝 더 할지"** 확인. W1~W5 결정의 적합성도 점검.

---

## Phase 2 — 풀 v1.0 (P1, Week 3)

### PACT-012  architect 서브에이전트
```yaml
priority: P1
dependencies: [PACT-004]
files: [agents/architect.md]
work:
  - ARCHITECTURE.md §3.2 명세 그대로
  - TBD 마커 모두 해소 책임
  - cycle 감지 (batch-builder.js 결과 활용)
done_criteria:
  - planner 출력의 TBD task 받아 → 계약 문서 생성 → TBD 0개로
tdd: false
```

### PACT-013  계약 문서 템플릿 추가
```yaml
priority: P1
dependencies: [PACT-002]
files:
  - templates/API_CONTRACT.md
  - templates/MODULE_OWNERSHIP.md
  - templates/ARCHITECTURE.md
  - templates/TESTING.md
work:
  - using project가 받게 될 계약 문서 템플릿
  - prose + yaml 블록 형식 (G1)
  - DB_CONTRACT.md는 read-only 명시 (마이그레이션이 SOT)
done_criteria:
  - architect가 채울 수 있는 빈 골격
tdd: false
sourcing: ARCHITECTURE.md §5
```

### PACT-014  /pact:contracts 명령
```yaml
priority: P1
dependencies: [PACT-012, PACT-013]
files: [commands/contracts.md]
work:
  - TASKS.md 존재 전제 검사
  - architect 서브에이전트 호출
  - API_CONTRACT.md, MODULE_OWNERSHIP.md 생성
done_criteria:
  - planner의 TBD task가 contracts 후 모두 해소
tdd: false
```

### PACT-015  reviewer 서브에이전트
```yaml
priority: P1
dependencies: [PACT-007]
files: [agents/reviewer.md]
work:
  - ARCHITECTURE.md §3.4 명세 그대로
  - 4축 검증 (Code/Contract/Docs/Integration)
  - plan-review 두 모드도 같은 에이전트 안에 (mode 파라미터)
done_criteria:
  - coordinator 종료 시 자동 호출, 4축 결과 채팅 보고
  - plan-review 모드 호출 시 plan 검토 결과 반환
tdd: false
```

### PACT-016  /pact:plan-eng-review, /pact:plan-design-review
```yaml
priority: P1
dependencies: [PACT-015]
files:
  - commands/plan-eng-review.md
  - commands/plan-design-review.md
work:
  - reviewer를 plan-review 모드로 호출
  - 결과를 채팅창 prose로 보고 (별도 파일 X)
  - 이슈 발견 시 planner 재호출 제안
done_criteria:
  - 두 명령 호출 시 각각의 검토 결과 채팅 출력
  - 이슈 분류 (P0/P1/warn) 명시
tdd: false
sourcing: ARCHITECTURE.md NEW-3
```

### PACT-017  Hook 5종 구현
```yaml
priority: P1
dependencies: [PACT-000]
files:
  - hooks/pre-tool-guard.js
  - hooks/post-edit-doc-sync.js
  - hooks/stop-verify.js
  - hooks/subagent-stop-review.js
  - hooks/progress-check.js
work:
  - PACT-000에서 확인한 hook spec대로 구현
  - pre-tool-guard: MODULE_OWNERSHIP.md 위반 차단 (가능 여부 spec 의존)
  - 차단 불가능하면 경고만 + PROGRESS에 위반 기록
done_criteria:
  - 각 hook이 trigger 시점에 호출되어 의도된 동작
  - allowed_paths 위반 시도 차단 또는 명시적 경고
tdd: true  # 각 hook 별도 테스트
sourcing: ARCHITECTURE.md §7
```

### PACT-018  TDD 강제 (워커)
```yaml
priority: P1
dependencies: [PACT-008]
files:
  - scripts/spawn-worker.js (수정)
  - prompts/worker-tdd.md
work:
  - tdd:true task의 워커 시스템 프롬프트에 RED→GREEN→REFACTOR 강제
  - tdd_evidence 보고 필수 (조작 방지)
  - red_observed=false면 워커 작업 무효 처리
done_criteria:
  - tdd:true task가 실패 테스트 없이 코드 짜면 거부
  - tdd_evidence가 워커 보고에 항상 박힘
tdd: true
sourcing: ARCHITECTURE.md §11
```

### PACT-019  교육 모드 (워커 출력)
```yaml
priority: P1
dependencies: [PACT-008, PACT-005]
files:
  - scripts/spawn-worker.js (수정)
  - prompts/worker-edu.md
work:
  - educational_mode:true task의 워커가 docs/learning/PACT-XXX.md 동시 생성
  - 5개 섹션 형식 강제 (무엇을/왜/핵심코드/연결관계/새개념)
  - 코드 짜고 나서 따로 X — 동시에
done_criteria:
  - educational_mode ON 사이클의 모든 task가 학습 노트 생성
  - 5개 섹션 모두 비어있지 않음
tdd: false
sourcing: ARCHITECTURE.md §10
```

### PACT-020  의존성 kind 타입 추가 (batch-builder)
```yaml
priority: P1
dependencies: [batch-builder.js]
files:
  - batch-builder.js (수정)
  - test/batch-builder.test.js
work:
  - dependencies를 string[] → {task_id, kind}[] 로 변경
  - kind: complete | contract_only
  - contract_only는 architect 단계 후 ready 처리
done_criteria:
  - contract_only 의존성으로 frontend가 backend 완료 안 기다리고 ready
  - 기존 string[] 형식과 호환 (마이그레이션)
tdd: true
sourcing: ARCHITECTURE.md §4.4, G6
```

### PACT-021  회로 차단기 + /pact:resume
```yaml
priority: P1
dependencies: [PACT-007]
files:
  - agents/coordinator.md (수정)
  - commands/resume.md
work:
  - 워커 2회 실패 시 PROGRESS.md Blocked 섹션에 기록
  - 권한 위반은 즉시 차단 (재시도 X)
  - /pact:resume <task_id>로 사용자 재개
  - 자동 처리 매트릭스 (ARCHITECTURE.md §9) 구현
done_criteria:
  - 2회 실패 → Blocked 기록, 사용자 위임
  - /pact:resume PACT-042 → 해당 task 재시도
tdd: true
sourcing: ARCHITECTURE.md §9, G10
```

### PACT-022  /pact:status, /pact:abort
```yaml
priority: P1
dependencies: [PACT-007]
files:
  - commands/status.md
  - commands/abort.md
work:
  - status: 현재 active cycle 정보 출력
  - abort: 진행 중 사이클 강제 종료, PROGRESS에 abort 기록
  - 동시 /pact:parallel은 거부 (G12)
done_criteria:
  - 동시 실행 시도 → 거부 + status/abort 안내
tdd: false
sourcing: G12
```

### PACT-023  /pact:reflect
```yaml
priority: P1
dependencies: [PACT-007]
files: [commands/reflect.md, agents/planner.md (수정)]
work:
  - 사이클 종료 후 회고 — 무엇이 잘 되고 무엇이 안 됐나
  - **propose-only** — 자동 반영 X, 사용자 승인 필요
  - 결과를 DECISIONS.md에 후보로 추가
done_criteria:
  - 사이클 회고 텍스트 + DECISIONS.md proposal
  - 사용자 승인 없이는 skill·rule 변경 X
tdd: false
sourcing: ARCHITECTURE.md 철학 5번
```

### PACT-024  4축 검증 강화 (verify)
```yaml
priority: P1
dependencies: [PACT-010, PACT-015]
files: [commands/verify.md (수정)]
work:
  - 단순 사용자 명령 실행에서 4축 검증으로 확장
  - reviewer 호출하여 Code/Contract/Docs/Integration 모두
  - PROGRESS.md Verification Snapshot에 4축 결과
done_criteria:
  - 4축 모두 PASS/FAIL/WARN 명시
  - 각 축의 구체 사유 (실패 시)
tdd: true
sourcing: ARCHITECTURE.md §3.4
```

### PACT-025  v1.0 통합 테스트
```yaml
priority: P1
dependencies: [PACT-012~PACT-024]
files: [test/v1-e2e.test.js]
work:
  - 풀 사이클 — init → plan(edu mode) → contracts → plan-review → parallel(다수 워커) → verify(4축) → reflect
  - 회로 차단기 발동 케이스
  - TDD 강제 케이스
done_criteria:
  - 자동 테스트 통과
  - 사용자 향 메시지 모두 한국어 자연스러움
tdd: true
```

---

## Phase 2.5 — Cross-Tool Second Opinion (P2.5, Week 4)

목표: 외부 모델(Codex)의 의견을 받는 cross-review 통합. 의견만, 차단 X.

ARCHITECTURE.md §19 sourcing.

### PACT-032  Cross-review 어댑터 인터페이스
```yaml
priority: P2.5
dependencies: []
files:
  - scripts/cross-review/adapter.js  # 인터페이스 정의
  - scripts/cross-review/registry.js  # 어댑터 등록·조회
work:
  - 공통 인터페이스: check_available(), call_review(input) → Finding[]
  - ReviewInput 타입 정의 (target, artifacts, context)
  - Finding 타입 정의 (file, line, severity, message)
  - 어댑터 등록 메커니즘 (v1.1+ Gemini/Cursor 추가 대비)
done_criteria:
  - 인터페이스 단위 테스트 (mock adapter)
  - registry에 등록·조회·삭제 가능
tdd: true
sourcing: ARCHITECTURE.md §19.3
```

### PACT-033  Codex 어댑터
```yaml
priority: P2.5
dependencies: [PACT-032]
files:
  - scripts/cross-review/codex-adapter.js
  - schemas/cross-review-output.json
work:
  - codex CLI headless 호출: codex exec --output-schema ...
  - JSON 스키마 정의 (Finding[] 호환)
  - 결과 파싱 → Finding[] 변환
  - check_available()은 codex --version 시도로 확인
  - 호출 timeout 정책 (default 5분)
  - ⚠️ codex exec 정확한 옵션은 Codex 공식 문서 확인 (PACT-000과 별도)
done_criteria:
  - 실제 코드베이스에 codex 호출 → Finding[] 반환
  - codex 미설치 시 check_available()이 false 반환
  - timeout 시 명확한 에러
tdd: true
sourcing: ARCHITECTURE.md §19.3
```

### PACT-034  /pact:cross-review-plan 명령
```yaml
priority: P2.5
dependencies: [PACT-033]
files: [commands/cross-review-plan.md]
work:
  - 입력: TASKS.md, API_CONTRACT.md, MODULE_OWNERSHIP.md
  - Codex에 "이 설계 검토" 프롬프트로 호출
  - 결과를 채팅창 한국어 prose로 보고
  - 사용자 액션 메뉴 (수용/부분 수용/무시)
  - 수용 시 architect 또는 planner 재호출 안내
  - 자동 모드: /pact:contracts 완료 직후 호출 (auto일 때)
done_criteria:
  - 의도적 결함 있는 설계 → Codex가 발견하는 케이스 통과
  - 결과 무시 시 그냥 진행
tdd: false
sourcing: ARCHITECTURE.md §19.2.1
```

### PACT-035  /pact:cross-review-code 명령
```yaml
priority: P2.5
dependencies: [PACT-033]
files: [commands/cross-review-code.md]
work:
  - 입력: cycle 머지 결과 commit 범위
  - Codex에 "이 변경 검토" 프롬프트로 호출
  - 결과 보고 + 액션 메뉴
  - 수용 시 다음 cycle의 fix task로 (planner 재호출)
  - 자동 모드: cycle 머지 직후 호출 (auto일 때)
  - PROGRESS.md에 last_cross_review 요약 기록
done_criteria:
  - 의도적 보안 취약점 코드 → Codex가 발견하는 케이스 통과
  - 자동 모드에서 cycle 머지 자체는 차단 X
tdd: false
sourcing: ARCHITECTURE.md §19.2.2
```

### PACT-036  /pact:init Codex 감지 + yolo 처리
```yaml
priority: P2.5
dependencies: [PACT-033, PACT-003]
files:
  - skills/init/check-codex.js
  - scripts/cross-review/yolo-prompt.js
work:
  - /pact:init 시점에 codex CLI 감지
  - 감지됨: 사용자에게 cross-review 사용 의사 묻기 (auto/manual/off)
  - 미감지: cross-review 자동 비활성화 (조용히), 안내 메시지만
  - CLAUDE.md의 cross_review 섹션에 결과 박기
  - **yolo 모드 처리**: 세션 첫 /pact:parallel 또는 /pact:contracts 시 한 번 묻기
  - yolo 답변은 세션 변수로 기록, 같은 세션 내 다시 안 묻음
  - ⚠️ Claude Code의 yolo 모드 감지 방법은 docs.claude.com 확인
done_criteria:
  - codex 미설치 환경에서 init 정상 동작, cross-review 비활성
  - codex 설치 환경에서 모드 선택 가능
  - yolo 모드에서 첫 게이트 시 한 번만 물음
tdd: true
sourcing: ARCHITECTURE.md §19.4, §19.6
```

### PACT-037  Phase 2.5 통합 테스트
```yaml
priority: P2.5
dependencies: [PACT-032~036]
files: [test/cross-review-e2e.test.js]
work:
  - codex 설치 환경에서 plan-review·code-review 시나리오
  - codex 미설치 환경에서 자동 비활성화 시나리오
  - yolo 모드에서 한 번 묻기 시나리오
  - false positive (Codex가 잘못 짚음) → 사용자 무시 시나리오
  - 자동 모드 cycle 통합 (머지 차단 안 됨 확인)
done_criteria:
  - 5개 시나리오 모두 자동 테스트 통과
tdd: true
```

**🛑 Phase 2.5 게이트**: PACT-037 통과 후 Phase 2.6로 진행할지 사용자에게 확인.

---

## Phase 2.6 — PRD 통합 + pact CLI subcommands (P2.6, Week 5)

목표: PRD-driven workflow 지원 + 결정적 작업을 pact CLI로 분리.

ARCHITECTURE.md §20, §21 sourcing.

### PACT-038  /pact:plan --from 옵션 (PRD 입력)
```yaml
priority: P2.6
dependencies: [PACT-005]
files: [commands/plan.md (수정)]
work:
  - --from <path> 옵션 추가
  - 단일 .md 파일, 폴더, 다중 파일 모두 지원
  - .md 외 형식이면 명확한 한국어 에러 ("docx는 .md로 변환 후 사용")
  - planner 서브에이전트에 PRD 전달
  - 짧은 자연어 모드(--from 없음)도 그대로 유지
done_criteria:
  - /pact:plan --from docs/PRD.md → planner가 PRD 기반 task 생성
  - /pact:plan "한 줄"도 정상 동작
  - .docx 입력 시 변환 안내 에러
tdd: true
sourcing: ARCHITECTURE.md §20.3
```

### PACT-039  워커 페이로드 prd_reference 필드
```yaml
priority: P2.6
dependencies: [PACT-038, PACT-008]
files:
  - scripts/spawn-worker.js (수정)
  - agents/planner.md (수정)
work:
  - planner가 task 분해 시 prd_reference 자동 박기 (예: "docs/PRD.md §3.2")
  - 메인 Claude가 워커 spawn 시 페이로드에 prd_reference 포함
  - 워커가 필요할 때 PRD 슬라이스 lazy-load (전체 X)
done_criteria:
  - PRD 기반 cycle의 모든 task에 prd_reference 박힘
  - 워커가 자기 슬라이스만 read (verify-output에 mention 빈도로 확인)
tdd: true
sourcing: ARCHITECTURE.md §20.4, §20.5
```

### PACT-040  .pact/ SOT 폴더 구조 셋업
```yaml
priority: P2.6
dependencies: [PACT-003]
files:
  - skills/init/setup-pact-folder.js
  - templates/.pact/.gitignore
work:
  - /pact:init 시 .pact/ 폴더 생성
  - .pact/.gitignore 자동 생성 ("*\n!.gitignore")
  - 하위 폴더 골격: runs/, worktrees/, archive/
  - state.json 초기 빈 상태 생성
  - 사용자 .gitignore 수정 X (침입 방지)
done_criteria:
  - /pact:init 후 .pact/ 폴더 자동 생성됨
  - git status에 .pact/ 안 잡힘 (자체 .gitignore로 자동 처리)
  - 사용자 프로젝트 .gitignore는 수정 안 됨
tdd: true
sourcing: ARCHITECTURE.md §21.2, §21.3
```

### PACT-041  pact CLI subcommands (batch, merge, status)
```yaml
priority: P2.6
dependencies: [PACT-040]
files:
  - bin/pact (CLI entry point)
  - bin/cmds/batch.js
  - bin/cmds/merge.js
  - bin/cmds/status.js
work:
  - pact CLI 도구를 Claude Code 플러그인 안에 패키지 (npm bin)
  - pact batch:
    - TASKS.md, MODULE_OWNERSHIP.md 읽기
    - batch-builder.js 알고리즘 적용
    - .pact/batch.json 출력
  - pact merge:
    - .pact/runs/*/status.json 모두 읽기
    - 게이트 검증 (verify pass + ownership + clean_for_merge)
    - 통과한 워커만 git merge 시도
    - 충돌 시 즉시 멈춤, .pact/merge-result.json에 기록
  - pact status:
    - .pact/state.json 읽어 표시
done_criteria:
  - 메인 Claude가 bash로 pact batch/merge/status 호출 가능
  - 결정적 동작 (LLM 없이 코드만)
  - 충돌 시 자동 해결 시도 X (즉시 사용자 위임)
tdd: true
sourcing: ARCHITECTURE.md §8, §21.5
```

### PACT-042  Phase 2.6 통합 테스트
```yaml
priority: P2.6
dependencies: [PACT-038~041]
files: [test/prd-and-cli-e2e.test.js]
work:
  - PRD 입력 시나리오 (.md 단일/폴더/다중)
  - 짧은 자연어 시나리오
  - pact batch CLI 출력 검증
  - pact merge gate 통과/거부 시나리오
  - .pact/ 폴더 구조 일관성
  - git status에 .pact/ 안 잡히는지 확인
done_criteria:
  - 5개 시나리오 모두 자동 테스트 통과
  - 결정적 동작 (재실행 시 같은 결과)
tdd: true
```

**🛑 Phase 2.6 게이트**: PACT-042 통과 후 v1.0 출시 가능.

---

## Phase 3 — Nice-to-Have (P2)

P0+P1+P2.5 완료 후 시간 남으면. v1.1로 미뤄도 OK.

### PACT-101  메트릭 집계 대시보드
```yaml
priority: P2
work:
  - 워커별 tokens_used 집계 → PROGRESS.md에 표시
  - 사이클별 비용 트렌드
  - external_review_cost (Codex 비용) 별도 집계
sourcing: G19
```

### PACT-102  설치·배포 가이드
```yaml
priority: P2
work:
  - GitHub clone 방식 설치 안내
  - README 작성 (한국어)
  - Codex 설치 안내 포함
  - 마켓플레이스는 v1.1+
sourcing: G16
```

---

## 빠진 task (의도적으로 v1.0 out of scope)

다음은 만들지 말 것 — 사용자에게 "이거 만들까요?" 묻지도 말 것:

- 자동 컨텍스트 압축
- 자동 진화·자기 수정 skill
- `/pact:adopt` (brownfield 지원)
- OpenAPI 자동 검증 도구
- 다국어 지원
- 마켓플레이스 자동 배포
- 워커 도메인 타입 분리 (backend/frontend/ai 별도 워커)
- **머지 충돌 자동 해결 — 영구 X (안전 원칙, ARCHITECTURE.md §15 #7)**
- **Cross-review 차단 게이트화 — 영구 X (ARCHITECTURE.md §15 #9)**
- **Cross-review 결과 자동 fix task 변환 — 영구 X (§15 #10)**
- **Codex 외 어댑터 (Gemini/Cursor 등) — 인터페이스만, 구현은 v1.1+**
- **Cross-review 비동기 호출 — v1.1**
- **시점별 mode 분리 (설계 auto + 완성 manual 같은) — v1.1**

---

## 의문 시 행동 룰

- task가 ARCHITECTURE.md와 모순되어 보임 → 사용자에게 질문
- task scope가 v1.0 범위 초과 의심 → 즉시 멈추고 확인
- spec 불확실 (Claude Code, Codex CLI, git worktree) → 공식 docs 직접 확인 후 진행
- worktree 정책 W1~W5는 default 우선 적용 → 환경에 안 맞으면 변경 후 DECISIONS.md
- Cross-review false positive로 보이는 결과 → 사용자에게 그대로 보고, 자체 판단 X
- 토큰 비용이 예상 대비 큼 → 사용자에게 보고
- 외부 도구 비용(OpenAI 등) 누적 시 → PROGRESS.md에 추적, 사용자 가시성
