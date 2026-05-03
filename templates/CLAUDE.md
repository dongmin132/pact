# <project-name> — 프로젝트 메모리

> 이 파일은 Claude Code가 매 세션 시작 시 자동 로드함.
> 프로젝트의 정체성·정책·제약을 박아두면 모든 매니저·워커가 공유함.
> `/pact:init`이 사용자 답변으로 placeholder를 채움.

## 1. 프로젝트 정체성

- **이름**: <project-name>
- **한 줄 정의**: <한 줄로 이 프로젝트가 무엇을 하는지>
- **기술 스택**: <예: TypeScript / Next.js / Postgres>
- **저장소**: <git URL>

## 2. 핵심 철학

이 프로젝트가 절대 양보하지 않는 원칙:

1. <원칙 1 — 예: "사용자 데이터 암호화 없이 저장 X">
2. <원칙 2>
3. <원칙 3>

## 3. pact 설정

```yaml
# yolo 모드 — Claude Code가 --dangerously-skip-permissions로 실행되는가
# 자동 감지 불가 (DECISIONS ADR-002), 사용자가 직접 명시
yolo_mode: false

# Cross-review 어댑터 (다른 모델의 의견 받기)
cross_review:
  adapter: null         # codex | null. /pact:init이 자동 감지
  mode: off             # auto | manual | off

# 교육 모드 — 워커가 코드 짜며 docs/learning/ 노트도 생성
educational_mode: false  # 매 /pact:plan 시점에 다시 묻지만, 기본값 박을 수 있음

# 워커 동시 한도
worker_concurrency:
  default: 3
  max: 5

# /pact:verify가 실행할 명령 (4축 검증 중 Code 축)
verify_commands:
  lint: <예: npm run lint>
  typecheck: <예: npm run typecheck>
  test: <예: npm test>
  build: <예: npm run build>
```

## 4. 컨텍스트 로딩 규칙

- 긴 문서 전체를 기본 컨텍스트에 올리지 않는다.
- 먼저 `docs/context-map.md`를 보고 어떤 shard/섹션을 읽을지 정한다.
- `TASKS.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`, PRD는 통째 read 금지.
- task는 `pact slice --headers`, `pact slice --tbd`, `pact slice --ids <ids>`로 읽는다.
- 새 task SOT는 `tasks/*.md`, 새 API/DB contract SOT는 `contracts/api/*.md`, `contracts/db/*.md`다.
- 각 task에는 `context_refs`를 넣어 워커와 reviewer가 읽을 문서를 명시한다.

## 5. 작업 보고 형식

새 파일 생성/수정 시 한국어로:

1. **무엇을**: 어떤 파일을 만들거나 수정했는지
2. **왜**: 왜 필요한지
3. **핵심 코드 설명**: 중요 블록의 동작
4. **연결 관계**: 다른 파일과의 관계
5. **새로운 개념**: 처음 등장하는 개념 설명

## 6. 코드 규칙

- **언어**: <ko | en>
- **들여쓰기**: <2 spaces | 4 spaces | tab>
- **네이밍**: <camelCase | snake_case>
- **테스트 위치**: <__tests__/ | tests/ | colocated>

## 7. 의문 시 행동 룰

- 결정 안 된 사항: 사용자에게 질문, 추측 금지
- ARCHITECTURE.md / TASKS.md와 모순 발생: ARCHITECTURE.md 우선
- v1.0 scope 초과 의심: 즉시 멈추고 사용자 확인

## 8. 외부 비용 인지

- Claude API: cycle당 ~85k(매니저 베이스라인) + 워커 비용
- Cross-review (Codex 등): 별도 OpenAI 비용. 자동 모드 시 누적 추적 필요
