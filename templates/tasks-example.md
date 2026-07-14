# Tasks — 형식 예시 (이 파일은 파이프라인에 잡히지 않는 문서입니다)

> 새 프로젝트는 `TASKS.md` 단일 파일 대신 `tasks/<domain>.md` shard를 사용한다.
> `/pact:plan` 이 이 형식으로 실제 task 를 생성한다 — 직접 쓸 때는 아래 형식을 복사해 쓰면 된다.
>
> **실제 task heading 형식**: `## <PREFIX>-<번호>  <한 줄 제목>` (예: `## AUTH-001  로그인 API`).
> 이 예시 파일의 heading 은 일부러 그 패턴을 벗어나 있어서(`예시:` 접두) `pact batch`/prepare 가
> task 로 취급하지 않는다 — placeholder 가 TBD 게이트로 첫 사이클을 막는 사고 방지.

## 예시: EXAMPLE-001  첫 작업 placeholder

```yaml
priority: P0
dependencies: []
allowed_paths:
  - src/example/**
forbidden_paths: []
files:
  - src/example/index.ts
work:
  - 첫 구현 task로 교체
done_criteria:
  - 검증 가능한 조건으로 교체
verify_commands:
  - <예: npm test>
contracts:
  api_endpoints: TBD   # architect(/pact:contracts)가 해소
  db_tables: TBD
context_refs:
  - contracts/api/example.md
  - contracts/db/example.md
tdd: true
worker_model: sonnet   # 선택 — 단순·기계적 task 는 haiku 로 배치 토큰 절감
context_budget_tokens: 12000
sourcing: docs/context-map.md
```
