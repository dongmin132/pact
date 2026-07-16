---
description: 4축 검증 (Code/Contract/Docs/Integration) — reviewer 통합 호출
---

사용자가 `/pact:verify`를 실행했습니다.

P1+: 4축 모두. (P0 단순 버전: Code 축만 — 이미 폐지됨)

## 단계 1: 사전 검사

`CLAUDE.md` 존재 — 없으면 "/pact:init 먼저" 후 중단.

## 단계 2: Code 축 (검증 명령 실행)

**docs-only 스킵 (C-4)**: 실행 전에 `node ${CLAUDE_PLUGIN_ROOT}/bin/pact verify-scope --json` 으로 이번 사이클의 코드 파일 변경 여부를 결정적으로 판정한다. `code_changed: false` 면(=이번 사이클이 전부 마크다운/docs) Code 축 4개 명령을 실행하지 않고 전부 `skip` 으로 표기한 뒤 단계 3으로 — docs-only 사이클에서 lint/typecheck/test/build 낭비(~수 분·수 M 토큰) 방지. `code_changed: true` 면 아래 정상 실행.

> ⚠️ 단순 `git diff HEAD~1` 을 쓰지 말 것: 표준 사이클은 코드 머지 뒤에 항상 md-only bookkeeping/status 커밋(`pact: cycle bookkeeping`, `pact: cycle status updates`)이 붙어, HEAD~1 만 보면 코드 대량 머지 사이클도 docs-only 로 오판돼 Code 축이 통째 skip 된다(검증 없이 병합 방지의 사후 축 무력화). `verify-scope` 는 트레일링 bookkeeping 을 건너뛴 사이클 범위로 판정한다.

CLAUDE.md `verify_commands` 추출 + 실행:

```bash
mkdir -p .pact
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG=.pact/verify-$TIMESTAMP.log

# CLAUDE.md에서 lint/typecheck/test/build 명령 추출 후 실행
# 결과를 변수에 저장 (lint_result, typecheck_result, ...)
```

각 명령:
- exit 0 → `pass`
- exit ≠ 0 → `fail`
- placeholder/누락 → `skip`

## 단계 3: reviewer 서브에이전트 호출 (code-review 모드, 4축)

Task tool:
- `subagent_type`: `reviewer-code`
- `description`: "4축 검증 — 머지 후 또는 명시 호출"
- `prompt`:
  ```
  
  4축 모두 검증:
  
  Code: 사용자가 단계 2에서 실행한 결과:
    lint=<pass|fail|skip>, typecheck=..., test=..., build=...
  
  Contract: contracts/api/<domain>.md (shard 우선, 없으면 legacy API_CONTRACT.md) ↔ 실제 라우트 비교
  Docs: PROGRESS.md / ARCHITECTURE.md 동기화
  Integration: MODULE_OWNERSHIP 위반 / 동시 수정 흔적
  
  PROGRESS.md `Verification Snapshot` 갱신.
  각 axis 결과 + finding (severity·confidence) 표시.
  ```

## 단계 4: 결과 (reviewer prose 그대로 + 다음 액션)

```
🔍 Code Review (4축) — <timestamp>

Code:        <PASS|WARN|FAIL>
Contract:    <PASS|WARN|FAIL>
Docs:        <PASS|WARN|FAIL>
Integration: <PASS|WARN|FAIL>

상세: (reviewer 출력)

상세 로그: .pact/verify-<timestamp>.log

다음:
  /pact:plan      # fix task 추가 (FAIL 있을 때)
  /pact:reflect   # cycle 회고
```

## 의문 시

- CLAUDE.md verify_commands 형식 깨짐: 사용자에게 명확화 요청
- reviewer 호출 실패: Code 축만이라도 표시 후 사용자 안내
- 명령 timeout (5분 default): 명령별 timeout 환경변수 또는 사용자 입력 받기
