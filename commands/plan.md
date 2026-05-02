---
description: 사용자 요구사항을 검증 가능한 task로 분해 (한국어 인터랙티브)
---

사용자가 다음 인자로 `/pact:plan`을 실행했습니다:

```
$ARGUMENTS
```

## 인자 모드 분기 (PACT-038, P2.6)

3가지 모드:

### 모드 1: 빈 인자
사용자에게 "어떤 작업을 계획할지 한 줄로 알려주세요" 묻고 답 받음.

### 모드 2: 짧은 자연어
예: `/pact:plan "리포트 자동 생성"`
요구사항을 그대로 planner에게 넘김. PRD 없음.

### 모드 3: PRD 기반 (`--from <path>`)
예: `/pact:plan --from docs/PRD-auth.md` (단일 .md)
예: `/pact:plan --from docs/` (폴더 내 .md 모두)

처리:
1. `--from` 인자 검출
2. 경로가 파일이면 .md 확장자 검증, 폴더면 안의 .md 모두 수집
3. **.md 외 형식(.docx/.pdf 등)은 즉시 거부**:
   ```
   ⚠️ PRD는 .md만 지원됩니다 (v1.0).
   .docx/.pdf/Notion 등은 직접 .md로 변환 후 사용해주세요.
   ```
4. PRD 파일 목록을 planner prompt에 포함, 각 task에 `prd_reference` 박도록 요청

## 단계 1: 사전 검사

### 1-1. CLAUDE.md 존재

`CLAUDE.md`가 현재 디렉토리에 없으면 즉시 중단:

```
⚠️  pact 초기화가 안 된 프로젝트입니다.
먼저 /pact:init을 실행해주세요.
```

### 1-2. 머지 진행 중 X (P1.5+)

```bash
git rev-parse -q --verify MERGE_HEAD
```

exit 0이면:
```
⚠️ 이전 cycle의 머지 충돌이 미해결 상태입니다.
/pact:resolve-conflict 또는 git merge --abort로 정리 후 다시 실행해주세요.
```
후 중단.

## 단계 2: 교육 모드 질문 (한국어)

사용자에게 묻기:

```
이 cycle에서 교육 모드를 켤까요?

[ON]  워커가 코드 짜며 docs/learning/<task-id>.md 학습 노트 동시 생성
[OFF] 코드만 작성

(CLAUDE.md의 educational_mode 값이 default입니다)
```

답변을 `educational_mode` 변수에 저장 (true | false).

## 단계 3: planner 서브에이전트 호출

Task tool로 `planner` 서브에이전트를 호출. prompt에 다음을 명시:

- 사용자 요구사항 (인자 또는 추가 질문 답변)
- educational_mode 값
- 출력 위치: 현재 디렉토리의 `TASKS.md`
- TASKS.md frontmatter에 `educational_mode` 박을 것

planner가 알아서:
- CLAUDE.md, ARCHITECTURE.md(있으면) read
- 요구사항을 task 단위로 분해
- TASKS.md 생성 또는 갱신
- TBD 마커는 architect 해소 영역으로 둠

## 단계 4: 결과 보고 (한국어)

planner 종료 후 TASKS.md 읽어 요약 출력:

```
✅ 계획 완료

생성된 task: <N>개
교육 모드: <ON | OFF>
TBD 마커: <개수>개 (architect가 /pact:contracts에서 해소)

다음 단계:
  /pact:contracts          # API/DB/모듈 계약 정의
또는
  /pact:plan-task-review   # task 분해 품질
  /pact:plan-arch-review   # 아키텍처 + 계약
  /pact:plan-ui-review     # UI 디자인 (UI task 있을 때)
```

## v1.0 P0 walking skeleton에서 안 하는 것

- ❌ 자동 plan-review 호출 — 사용자가 직접 `/pact:plan-*-review` 호출 (PACT-016)
- ❌ 자동 cross-review (Codex) — PACT-034 (P2.5)
- ❌ 인자가 .md/.docx/.pdf 같은 파일 경로면 거부:
  ```
  PRD 파일 입력은 v1.0 후반(PACT-038)에서 지원됩니다.
  지금은 한 줄 자연어 설명으로만 사용해주세요.
  ```

## 의문 시

- 인자가 모호: 사용자에게 명확화 질문
- 기존 TASKS.md 존재: 사용자에게 "덮어쓸까요 / 추가할까요" 묻기
- planner가 토큰 예산 초과 위험: 사용자에게 알림 후 진행 의사 확인
