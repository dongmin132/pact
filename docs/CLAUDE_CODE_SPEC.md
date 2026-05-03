# Claude Code Plugin Spec — pact 빌드용 reference

> PACT-000 산출물 + v1.0 빌드 후 갱신.
> 출처: docs.claude.com 공식 문서 (조사 시점: 2026-05-02) + 빌드 중 확인된 사실.
> **추측 X — 확인된 사실만**. 불명확한 항목은 명시적으로 표기.
> v1.0 빌드 후 `[CONFIRMED]`·`[REVISED]` 마커로 검증 결과 박힘.

---

## 1. plugin.json 스키마

### 1.1 디렉토리 구조

```
pact/
├── .claude-plugin/
│   ├── plugin.json          # 필수
│   └── marketplace.json     # 선택 — github 저장소를 marketplace로 노출
├── commands/                # 슬래시 명령 (.md 자동 발견) [CONFIRMED]
├── agents/                  # 서브에이전트 (.md + frontmatter) [CONFIRMED]
├── skills/                  # Skills (디렉토리 + SKILL.md) [CONFIRMED]
├── hooks/
│   └── *.js | *.sh          # plugin.json에서 직접 참조 [CONFIRMED]
├── scripts/                 # bash/node 헬퍼
├── bin/                     # CLI 진입점 (package.json `bin` 통해 노출)
└── README.md
```

**중요** [CONFIRMED]:
- `commands/`·`agents/`·`skills/`는 **자동 발견** — plugin.json에 별도 등록 X
- Hook은 plugin.json `hooks` 필드에 인라인 (별도 hooks.json도 가능)

### 1.2 plugin.json 필수/선택 필드

```json
{
  "name": "pact",                    // 필수
  "version": "0.1.0",                // 필수, 캐시 키
  "description": "...",              // 필수
  "author": {                        // 필수
    "name": "...",
    "email": "..."
  },
  "homepage": "...",                 // 선택
  "repository": {...},               // 선택
  "license": "...",                  // 선택
  "keywords": [...],                 // 선택
  "hooks": {...},                    // 선택 (또는 hooks/hooks.json)
  "mcpServers": {...}                // 선택
}
```

### 1.3 설치 방법 (사용자 측) [REVISED]

빌드 중 확인된 정확한 문법:

| 시나리오 | 명령 | 비고 |
|---|---|---|
| **로컬 개발 (권장)** | `claude --plugin-dir /path/to/plugin` | Claude Code 시작 시 플래그. 재시작 필요 |
| **Marketplace 등록** | `/plugin marketplace add github:user/repo` | `.claude-plugin/marketplace.json` 있어야 |
| **Marketplace에서 설치** | `/plugin install <name>@<marketplace>` | 등록 후 |
| **프로젝트 `.claude/` 직접** | `mkdir -p .claude && ln -s ...` | namespacing 없음 (`/init` 등) |

**❌ 작동 안 함 (PACT-000에서 추측한 것)**:
- `/plugin install /path/to/local` — "Marketplace not found" 에러
- `/plugin install github:user/repo` 단독 — 마켓플레이스 등록 선행 필요

**`/plugin` 자체가 비활성**: "isn't available in this environment" 에러 시 Claude Code 버전·환경 영향. `--plugin-dir` 플래그가 fallback.

### 1.4 marketplace.json 형식 [CONFIRMED — v1.0에서 추가]

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "<marketplace-name>",
  "owner": { "name": "...", "email": "..." },
  "plugins": [
    {
      "name": "<plugin-name>",
      "source": { "source": "url", "url": "https://github.com/.../repo.git" },
      "version": "0.1.0",
      "strict": true
    }
  ]
}
```

같은 repo가 marketplace + plugin 둘 다 가능 (source URL이 본인 repo 가리켜도 OK).

### 1.5 v1.0 결정 사항

- 디렉토리 구조 위 표준 그대로 채택
- plugin.json: 필수 4 필드 + hooks 인라인 등록
- marketplace.json 추가 (github 저장소 통한 배포)

---

## 2. Hooks

### 2.1 사용 가능한 hook 이벤트

총 30개 hook 이벤트 존재. **pact가 사용하는 7개** [v1.0 빌드 중 확장]:

| pact hook | Claude Code 이벤트 | 차단 가능? | async |
|---|---|---|---|
| `pre-tool-guard` | `PreToolUse` | ✅ | false |
| `tdd-guard` | `PreToolUse` (Write 매처) | ✅ | false |
| `post-edit-doc-sync` | `PostToolUse` | ❌ | true |
| `stop-verify` | `Stop` | ✅ | false |
| `subagent-stop-review` | `SubagentStop` | ✅ | false |
| `teammate-idle` | `TeammateIdle` | ❌ | true |
| `progress-check` | `SessionEnd` | ❌ | true |

### 2.2 PreToolUse — 도구 호출 차단

**가장 중요한 발견**: PreToolUse는 도구 실행 직전 차단 가능.

#### Payload (입력)
```json
{
  "tool_name": "Bash|Write|Edit|Read|...",
  "tool_input": { /* 도구별 파라미터 */ },
  "session_id": "sess_...",
  "transcript_path": "/tmp/...",
  "cwd": "/path/to/wd"
}
```

#### 응답 (차단/수정/통과)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "사유",
    "updatedInput": { /* 도구 입력 수정 가능 */ },
    "additionalContext": "Claude에 추가 정보 전달"
  }
}
```

또는 exit code 2 + stderr로 차단.

### 2.3 PostToolUse — 차단 불가능

도구는 이미 실행됨. 반응만 가능 (`decision: "block"`은 다음 단계만 막음).

### 2.4 Hook 등록 형식 [CONFIRMED]

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-guard.js",
            "timeout": 10,
            "async": false
          }
        ]
      }
    ]
  }
}
```

[CONFIRMED]:
- `${CLAUDE_PLUGIN_ROOT}` 환경 변수 작동 — 플러그인 install 경로로 expand
- `.js` 파일을 `node` 통해 invoke 가능 (별도 shebang 불필요)
- `async: true` 설정 시 메인 흐름 안 막음 (텔레메트리·알림용)
- 같은 이벤트 + 다른 matcher로 여러 hook 등록 가능 (예: PreToolUse에 pre-tool-guard + tdd-guard)

### 2.5 v1.0 영향

- ✅ MODULE_OWNERSHIP 위반 차단 가능 — `pre-tool-guard`를 PreToolUse에 박음
- ❌ PostToolUse는 경고만 — `post-edit-doc-sync`는 차단 X, 알림만
- ⚠️ `progress-check`는 SessionEnd로 매핑하지만 차단 불가 (애초에 차단할 게 없음)

---

## 3. Subagent / Task tool

### 3.1 호출 인터페이스 [REVISED]

```json
{
  "type": "Task",
  "subagent_type": "<agents/<name>.md의 name>",  // 빌드 중 확인 — 핵심 파라미터
  "description": "한 줄 설명",
  "prompt": "상세 지시 — 서브에이전트 컨텍스트의 유일한 채널",
  "run_in_background": false,
  "model": "haiku|sonnet|opus|inherit"  // inherit 작동 [CONFIRMED]
}
```

`subagent_type` 생략 시 default agent 사용. 우리 매니저·워커는 모두 명시적 타입 사용.

### 3.2 한 메시지에 다중 Task 호출 — 병렬 실행

- ✅ 가능
- ⚠️ **공식 한도 명시 없음**
- 추천 패턴: 3-5개 (실용적), 7개까지 권장하는 자료도 있음
- 우리 정책 (default 3, 최대 5)은 안전 범위

### 3.3 ⚠️ 중요 발견 1: 서브에이전트 nesting

**불가능 (재확인됨)**.

서브에이전트 컨텍스트에서 Task tool이 노출되지 않음.
출처: [GitHub Issue #4182](https://github.com/anthropics/claude-code/issues/4182)

→ ARCHITECTURE.md §14.2의 결정 그대로 유효: **워커 spawn은 메인 Claude가 함**.

### 3.4 ⚠️ 중요 발견 2: working_dir 강제 가능 여부

**공식 문서에 명시 X — 불명확**.

알려진 정보:
- Agent SDK에는 `working_dir` 파라미터 존재
- Claude Code의 Task tool에서는 명시적 파라미터 미확인
- 기본 동작은 부모 cwd 상속

→ **우리의 대응**: ARCHITECTURE.md §4.2의 워커 격리는 **하이브리드**로 간다:
1. Spawn payload에 `working_dir` 박기 + 워커 시스템 프롬프트에 "이 디렉토리 안에서만" 강제
2. 머지 시점에 `pact merge` CLI가 `files_changed`를 검증 (worktree 외부 변경 = 거부)

→ Task tool 자체로 강제 안 되면 **post-hoc 검증**이 진실의 마지막 게이트.

### 3.5 서브에이전트 정의 형식 [CONFIRMED]

`agents/<name>.md` 파일:

```markdown
---
name: planner
description: "요구사항을 task로 분해하는 매니저"
model: inherit          # inherit | haiku | sonnet | opus
maxTurns: 15
disallowedTools:        # blocklist 패턴
  - Bash
  - WebFetch
# 또는 (대안):
tools:                  # whitelist 패턴 — 명시한 것만 허용
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - TodoWrite
---

# planner 시스템 프롬프트

너는 ... (시스템 프롬프트 본문)
```

- **2가지 도구 제한 방식**:
  - `disallowedTools` (blocklist) — 명시 외 모두 허용
  - `tools` (whitelist) — 명시한 것만 허용 (더 안전)
- 본문 마크다운이 시스템 프롬프트
- 각 서브에이전트는 독립 컨텍스트 윈도우
- `model: inherit` — 부모(메인) 컨텍스트 모델 그대로 상속

---

## 4. Yolo 모드 (`--dangerously-skip-permissions`)

### 4.1 [REVISED — ADR-011] permission_mode로 감지 가능

**Hook payload에 `permission_mode` 필드 존재** (공식 hook 문서 확인). 값:

| 값 | 의미 |
|---|---|
| `default` | 일반 — 매번 권한 묻기 |
| `bypassPermissions` | yolo — `--dangerously-skip-permissions` |
| `acceptEdits` | 파일 수정 자동 승인 |
| `plan` | plan 모드 |

### 4.2 v1.0 구현 (ADR-011)

자동 감지 활성화:

1. **`hooks/session-start.js`** — SessionStart hook이 payload의 `permission_mode` 캡처해 `.pact/state.json`에 기록
2. **`scripts/detect-yolo.js`** — 우선순위 fallback chain
   - hook payload (가장 정확)
   - `.pact/state.json` (SessionStart에서 박힌 값)
   - `.claude/settings.json` `defaultMode` (정적)
3. **`/pact:init`** — 자동 감지 우선, 실패 시만 사용자에게 묻기
4. **`bypassPermissions` 감지 시** — SessionStart 즉시 systemMessage로 위험 알림

PACT-000 시점 결정(ADR-002 "감지 불가, 사용자 명시")은 폐기됨. 학습: spec 신규 필드는 정기 재확인.
```yaml
# CLAUDE.md
yolo_mode: true | false  # 사용자 본인이 명시
```

**대안 B**: 매 게이트마다 묻기 (yolo여도 일반이여도)

→ 자동 추측 절대 X. ARCHITECTURE.md 안티패턴 #11("yolo여도 사용자 의도 추측 X") 정신 그대로.

---

## 5. v1.0 빌드 영향 요약

| 항목 | spec 확인 결과 | ARCHITECTURE.md 영향 |
|---|---|---|
| plugin.json 스키마 | ✅ 확정 | PACT-001 그대로 진행 |
| 슬래시 명령 등록 | ✅ commands/ 자동 발견 | PACT-003·005 등 영향 없음 |
| Hook 5개 매핑 | ✅ 모두 매핑 가능 | §7 표 그대로, PostToolUse는 경고만 |
| PreToolUse 차단 | ✅ 가능 | `pre-tool-guard`로 ownership 강제 OK |
| 서브에이전트 nesting | ❌ 불가 (확정) | §14.2 그대로, 메인 Claude가 spawn |
| Task working_dir 강제 | ⚠️ 불명확 | 시스템 프롬프트 + 머지 검증 하이브리드 |
| Task 병렬 한도 | ⚠️ 공식 명시 X | default 3, 최대 5 안전 |
| Yolo 모드 감지 | ❌ 불가 | §19.6 변경: 사용자 명시 필요 |
| disallowedTools 형식 | ✅ frontmatter | agents/*.md frontmatter 그대로 |

---

## 6. 빌드 중 확인 결과 [v1.0 빌드 후 갱신]

PACT-000 시점에 미해결이었던 4가지:

1. **Task tool `cwd` 파라미터** — ❌ 공식 미지원 확인. ADR-001로 **post-hoc 검증** 패턴 채택 (worker prompt + `pact merge`의 git diff 검증)
2. **Hook command의 `${CLAUDE_PLUGIN_ROOT}`** — ✅ 작동 확인. plugin install 경로로 expand
3. **마켓플레이스 설치** — ✅ marketplace.json 추가로 v1.0에서 지원. `--plugin-dir` 플래그가 로컬 개발 fallback
4. **subagent `model: inherit`** — ✅ 작동 확인. ADR-004로 모든 매니저·워커 inherit 채택

## 7. v1.0 빌드 중 추가로 확인된 사실

| 항목 | 결과 |
|---|---|
| 한 메시지에서 Task tool 다중 호출 → 병렬 spawn | ✅ 동작 (단 LLM 행동 강제는 X, 시스템 프롬프트 의존) |
| 같은 PreToolUse 이벤트에 여러 hook 등록 (matcher별) | ✅ 동작 (pre-tool-guard + tdd-guard) |
| Hook async: true | ✅ 동작 (메인 흐름 안 막음) |
| `tools:` whitelist (alternative to disallowedTools) | ✅ 동작 |
| Yolo 모드(`--dangerously-skip-permissions`) 자동 감지 | ❌ 메커니즘 없음 — ADR-002로 사용자 명시 채택 |
| `/plugin install <local-path>` | ❌ "Marketplace not found" — `--plugin-dir` 플래그 사용 |
| Same repo가 marketplace + plugin 동시 노출 | ✅ 작동 (marketplace.json source URL이 본인 repo) |

---

## 8. 출처

- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [GitHub: anthropics/claude-code Issue #4182](https://github.com/anthropics/claude-code/issues/4182)
