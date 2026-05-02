# Claude Code Plugin Spec — pact 빌드용 reference

> PACT-000 산출물. ARCHITECTURE.md §7, §14의 ⚠️ 표기 항목들을 공식 문서로 확인한 결과.
> 출처: docs.claude.com 공식 문서 (조사 시점: 2026-05-02)
> **추측 X — 확인된 사실만**. 불명확한 항목은 명시적으로 표기.

---

## 1. plugin.json 스키마

### 1.1 디렉토리 구조

```
pact/
├── .claude-plugin/
│   └── plugin.json          # 필수
├── commands/                # 슬래시 명령 (.md 자동 발견)
├── agents/                  # 서브에이전트 (.md + frontmatter)
├── skills/                  # Skills (디렉토리 + SKILL.md)
├── hooks/
│   └── hooks.json           # 또는 plugin.json에 인라인
├── scripts/                 # bash/node 스크립트
└── README.md
```

**중요**:
- `commands/`·`agents/`는 **자동 발견** — plugin.json에 별도 등록 X
- `hooks.json` 또는 plugin.json `hooks` 필드 둘 다 지원

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

### 1.3 설치 방법 (사용자 측)

- `/plugin install github:user/repo`
- `/plugin install /path/to/local`
- 마켓플레이스 (v1.1+ 우리 출시 대상)

### 1.4 v1.0 결정 사항

- 디렉토리 구조 위 표준 그대로 채택
- plugin.json은 필수 4개 필드만 우선 (PACT-001)

---

## 2. Hooks

### 2.1 사용 가능한 hook 이벤트

총 30개 hook 이벤트 존재. **pact가 사용하는 5개**:

| ARCHITECTURE.md §7 우리 hook | Claude Code 공식 이벤트 | 차단 가능? |
|---|---|---|
| `pre-tool-guard` | `PreToolUse` | ✅ |
| `post-edit-doc-sync` | `PostToolUse` | ❌ (반응만) |
| `stop-verify` | `Stop` | ✅ |
| `subagent-stop-review` | `SubagentStop` | ✅ |
| `progress-check` | `SessionEnd` | ❌ |

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

### 2.4 Hook 등록 형식

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-guard.sh",
            "timeout": 30,
            "async": false
          }
        ]
      }
    ]
  }
}
```

### 2.5 v1.0 영향

- ✅ MODULE_OWNERSHIP 위반 차단 가능 — `pre-tool-guard`를 PreToolUse에 박음
- ❌ PostToolUse는 경고만 — `post-edit-doc-sync`는 차단 X, 알림만
- ⚠️ `progress-check`는 SessionEnd로 매핑하지만 차단 불가 (애초에 차단할 게 없음)

---

## 3. Subagent / Task tool

### 3.1 호출 인터페이스

```json
{
  "type": "Task",
  "description": "한 줄 설명",
  "prompt": "상세 지시 — 서브에이전트 컨텍스트의 유일한 채널",
  "run_in_background": false,
  "model": "haiku|sonnet|opus"
}
```

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

### 3.5 서브에이전트 정의 형식

`agents/<name>.md` 파일:

```markdown
---
name: planner
description: "요구사항을 task로 분해하는 매니저"
model: sonnet
maxTurns: 10
disallowedTools:
  - Bash(rm *)
  - Write
---

# planner 시스템 프롬프트

너는 ... (시스템 프롬프트 본문)
```

- frontmatter의 `disallowedTools`로 도구 제한
- 본문 마크다운이 시스템 프롬프트
- 각 서브에이전트는 독립 컨텍스트 윈도우

---

## 4. Yolo 모드 (`--dangerously-skip-permissions`)

### 4.1 ❌ 중대한 발견: 자동 감지 불가능

**Hook이나 플러그인 코드에서 yolo 모드 활성화 여부를 감지하는 공식 메커니즘 없음**.

알려진 정보:
- CLI 플래그: `--dangerously-skip-permissions` 또는 `--permission-mode bypassPermissions`
- 설정: `.claude/settings.json`의 `defaultMode: "bypassPermissions"`
- 환경 변수로 노출 X
- Hook payload에서도 감지 X

### 4.2 v1.0 대응

→ ARCHITECTURE.md §19.6의 "yolo 모드 감지 후 한 번만 묻기" 정책은 **자동 감지 불가**라는 사실을 받아들이고 변경:

**대안 A** (권장): 사용자가 `/pact:init` 시점에 본인 환경이 yolo인지 명시
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

## 6. 빌드 중 추가 확인 필요 항목

다음은 실제 환경에서 PoC하며 확정:

1. **Task tool에 `cwd` 파라미터 전달 가능 여부** — 공식 문서엔 없지만 SDK에 있음. 시도해보고 결과 기록.
2. **Hook command의 `${CLAUDE_PLUGIN_ROOT}` 환경 변수** — 사용 가능 가정, 빌드 중 검증.
3. **마켓플레이스 vs GitHub 설치 시 디렉토리 동작 차이** — v1.0은 GitHub만 가정.
4. **subagent 마크다운에서 `model` 필드 미지정 시 동작** — 부모 모델 상속 가정, 검증.

이 4가지는 PACT-001 이후 빌드 진행하며 발견·기록.

---

## 7. 출처

- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [GitHub: anthropics/claude-code Issue #4182](https://github.com/anthropics/claude-code/issues/4182)
