---
name: init
description: pact 프로젝트 초기 셋업 — 빈 디렉토리에 4개 문서 생성, 인터랙티브 한국어 진행
---

# init — pact 프로젝트 초기화 스킬

> `/pact:init` 명령에서 호출됨.
> 빈 프로젝트에 pact 시스템을 셋업하고 4개 핵심 문서를 생성한다.
> **신규 프로젝트 전용**. 기존 코드 분석(brownfield)은 v1.1+ 영역.

## 입력

없음 (인터랙티브로 사용자에게 질문).

## 출력

현재 디렉토리에 다음 4개 파일 생성:
- `CLAUDE.md`
- `PROGRESS.md`
- `TASKS.md`
- `DECISIONS.md`

---

## 단계 1: 사전 검사

다음 파일 중 하나라도 현재 디렉토리에 존재하면 **즉시 중단**하고 사용자에게 알립니다:

```
CLAUDE.md, PROGRESS.md, TASKS.md, DECISIONS.md
```

중단 시 메시지 (한국어):

```
⚠️  이미 pact가 초기화된 프로젝트로 보입니다.

발견된 파일: <발견된 파일 목록>

새로 시작하려면 기존 파일을 백업·삭제 후 다시 실행해주세요.
기존 프로젝트에 pact를 도입하는 brownfield 모드는 v1.1+에서 지원됩니다.
```

검사 명령:
```bash
ls CLAUDE.md PROGRESS.md TASKS.md DECISIONS.md 2>/dev/null
```

---

## 단계 2: 인터랙티브 질문

사용자에게 차례로 질문하며 답을 수집합니다. **한국어**로 묻고, 답변이 빈 문자열이면 placeholder를 그대로 둡니다.

### 질문 1 — 프로젝트 이름 (필수)

```
프로젝트 이름이 뭔가요? (한 단어, 예: myapp, auth-service)
```

→ `<project-name>` 치환에 사용.

### 질문 2 — 한 줄 정의 (필수)

```
이 프로젝트는 무엇을 하나요? 한 줄로 설명해주세요.
(예: 사용자 인증 서비스 / 리포트 자동 생성 도구)
```

→ `<한 줄로 이 프로젝트가 무엇을 하는지>` 치환.

### 질문 3 — 기술 스택 (선택)

```
주 기술 스택은? (Enter로 건너뛰기 가능)
예: TypeScript / Next.js / Postgres
```

→ `<예: TypeScript / Next.js / Postgres>` 치환.
→ 빈 답이면 placeholder 그대로 둠.

### 질문 4 — yolo 모드 자동 감지 (ADR-011, 공식 hook payload 활용)

먼저 자동 감지 시도:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/detect-yolo.js
```

stdout JSON의 `is_yolo`·`mode`·`source` 확인. 결과 분기:

- `mode: 'bypassPermissions'` (= yolo) → CLAUDE.md `yolo_mode: true`, 사용자에게 알림:
  ```
  ⚠️ yolo 모드(bypassPermissions) 감지됨 — 권한 자동 승인 환경.
  cross-review·destructive 동작 자동 진행됨.
  ```
- `mode: 'default'` 등 일반 → `yolo_mode: false`
- `mode: 'unknown'` (감지 실패) → 사용자에게 묻기:
  ```
  yolo 모드 자동 감지 실패. 직접 알려주세요:
  [y] --dangerously-skip-permissions로 실행 중
  [N] 일반 (default)
  ```

답변을 CLAUDE.md `yolo_mode`에 박음.

### 질문 5 — Codex 감지 + cross-review 설정

```bash
codex --version
```

exit 0이면 Codex 설치됨:

```
Codex CLI 감지됨. cross-review 사용하시겠어요?
[a] auto — contracts·머지 직후 자동 호출
[m] manual — /pact:cross-review-plan / /pact:cross-review-code 명시 호출만
[o] off — 사용 안 함
```

답변을 CLAUDE.md `cross_review`에 박음:
```yaml
cross_review:
  adapter: codex
  mode: auto | manual | off
```

exit 0 아니면 (codex 미설치):
```
Codex CLI 미감지. cross-review 자동 비활성화됩니다.
설치 후 사용하려면 CLAUDE.md `cross_review.adapter`를 codex로, `mode`를 auto/manual로 수정하세요.
```

cross_review.adapter는 null로 박음.

⚠️ Codex 호출 시 OpenAI API 비용 별도 발생. /pact:init에서 안내:
```
주의: Codex 사용 시 OpenAI API 비용이 별도 발생합니다.
누적 비용은 PROGRESS.md `external_review_cost.total_usd`에 추적됩니다.
```

### 질문 6 — 검증 명령 (자동 감지 + 사용자 확인)

먼저 빌드 파일로 자동 감지:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/detect-stack.js
```

stdout JSON에서:
- `stack`: 감지된 스택 (node-typescript / java-maven / rust / go / python / ...)
- `verify_commands`: 자동 추천 4개 (lint·typecheck·test·build)

사용자에게 결과 보여주고 수정 의사 확인:

```
감지된 스택: <stack>
추천 검증 명령:
  lint:      <auto>
  typecheck: <auto>
  test:      <auto>
  build:     <auto>

이대로 사용? (y/n/edit)
  y: 그대로 채택
  n: 모두 skip 처리 (나중에 직접 채움)
  edit: 한 줄씩 수정
```

`y` → verify_commands placeholder를 자동 추천 값으로 치환
`n` → 모두 `skip` 으로 치환
`edit` → 각 항목 사용자에게 묻고 답 또는 Enter(추천 그대로)

`stack`이 `unknown`이면 자동으로 모두 `skip` + 안내:
```
빌드 파일 미감지 (package.json·pom.xml·Cargo.toml 등 없음).
검증 명령은 일단 skip — 나중에 CLAUDE.md에서 직접 채워주세요.
```

### 질문 번호 변경 결과 ###
질문 1·2·3은 그대로. 4·5는 yolo·cross-review (위), 6이 검증 명령. 치환 매핑은 단계 3에서.

---

## 단계 3: 파일 복사·치환

`${CLAUDE_PLUGIN_ROOT}/templates/` 4개 파일을 현재 디렉토리로 복사하면서 placeholder를 사용자 답변으로 치환합니다.

### 복사 매핑

| 원본 | 대상 |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md` | `./CLAUDE.md` |
| `${CLAUDE_PLUGIN_ROOT}/templates/PROGRESS.md` | `./PROGRESS.md` |
| `${CLAUDE_PLUGIN_ROOT}/templates/TASKS.md` | `./TASKS.md` |
| `${CLAUDE_PLUGIN_ROOT}/templates/DECISIONS.md` | `./DECISIONS.md` |

### Placeholder 치환 (모든 파일에 일괄)

| Placeholder | 치환값 |
|---|---|
| `<project-name>` | 질문 1 답변 |
| `<한 줄로 이 프로젝트가 무엇을 하는지>` | 질문 2 답변 |
| `<예: TypeScript / Next.js / Postgres>` | 질문 3 답변 (있으면) |
| `<예: npm run lint>` | 질문 4 lint 답변 |
| `<예: npm run typecheck>` | 질문 4 typecheck 답변 |
| `<예: npm test>` | 질문 4 test 답변 |
| `<예: npm run build>` | 질문 4 build 답변 |

### 안 건드리는 placeholder (사용자가 나중에 채움)

- `<원칙 1 — ...>`, `<원칙 2>`, `<원칙 3>`: 핵심 철학은 사용자 본인의 가치관, init 시점에 강제로 묻지 않음
- `<git URL>`: 저장소 URL
- 코드 규칙 placeholder들 (`<ko | en>` 등)

---

## 단계 3.5: `.pact/` SOT 폴더 생성 (PACT-040, P2.6)

```bash
mkdir -p .pact/runs .pact/worktrees .pact/archive
echo $'*\n!.gitignore' > .pact/.gitignore
echo '{"version": 1, "current_cycle": 0, "active_workers": []}' > .pact/state.json
```

이러면 `.pact/` 통째로 git ignore됨 (자체 .gitignore로 처리, 사용자 .gitignore 침입 X).

## 단계 4: 결과 보고 (한국어)

성공 시 다음 메시지 출력:

```
✅ pact 초기화 완료

생성된 파일:
- CLAUDE.md
- PROGRESS.md
- TASKS.md
- DECISIONS.md

기본 설정 (CLAUDE.md에서 확인·수정 가능):
- yolo_mode: false
- cross_review.adapter: null
- worker_concurrency: default 3 / max 5

다음 단계:
  /pact:plan "첫 작업 한 줄 설명"
또는
  /pact:plan --from docs/PRD.md
```

---

## P2.5+ 추가 동작 (현재 활성)

P0에서 안 했던 것들 추가됨:

- ✅ Codex CLI 감지 (PACT-036)
- ✅ yolo 모드 명시 묻기 (PACT-036)
- ✅ `.pact/` SOT 폴더 생성 (PACT-040, P2.6)
- ✅ git 환경 검증 (PACT-026, worktree 사용 위해 필수)

git 환경 검증은 다음 호출:
```bash
node -e "
const { checkEnvironment } = require('\${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
const r = checkEnvironment();
if (!r.ok) { console.error(JSON.stringify(r.errors)); process.exit(1); }
"
```

`.pact/` 폴더는 단계 3.5에서 생성 (자체 .gitignore 박음, ARCHITECTURE.md §21.3).

## 안 하는 것 (영구)

- ❌ 자동 git init — 사용자에게 안내, 직접 실행 권장
- ❌ brownfield 모드 (v1.1+)

---

## 의문 시 행동 룰

- 답변 형식이 불분명: 사용자에게 다시 물음 (추측 X)
- placeholder가 templates에 없는 경우: 그냥 통과 (해당 답은 무시)
- 파일 쓰기 실패: 즉시 중단, 사용자에게 에러 표시. 부분 파일 정리 시도 X (사용자가 직접 판단)
