# Tasks — example domain

> 새 프로젝트는 `TASKS.md` 단일 파일 대신 `tasks/<domain>.md` shard를 사용한다.

## EXAMPLE-001  첫 작업 placeholder

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
  api_endpoints: TBD
  db_tables: TBD
context_refs:
  - contracts/api/example.md
  - contracts/db/example.md
tdd: true
context_budget_tokens: 12000
sourcing: docs/context-map.md
```
