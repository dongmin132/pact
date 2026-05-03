# <project-name> Context Map

> 긴 SOT 문서는 보관하되 기본 컨텍스트에는 올리지 않는다.
> 먼저 이 인덱스를 보고 필요한 shard/섹션만 읽는다.

## Global Rules

- 긴 문서 전체 read 금지. `rg`로 섹션을 찾고 `pact slice`로 task만 읽는다.
- 새 task SOT는 `tasks/*.md`다. `TASKS.md`는 legacy 또는 index 용도다.
- 새 API contract SOT는 `contracts/api/*.md`다.
- 새 DB contract SOT는 `contracts/db/*.md`다.
- task에는 가능하면 `context_refs`를 넣어 워커가 읽을 문서를 직접 가리킨다.

## Domains

| Domain | Tasks | API Contract | DB Contract | Notes |
|---|---|---|---|---|
| example | `tasks/example.md` | `contracts/api/example.md` | `contracts/db/example.md` | 초기 placeholder |

## Command Read Profiles

### /pact:plan

Read:
- `CLAUDE.md`
- this file
- PRD section headers, then relevant sections only

Write:
- `tasks/<domain>.md`

### /pact:contracts

Read:
- `pact slice --tbd`
- `contracts/manifest.md`

Write:
- `contracts/api/<domain>.md`
- `contracts/db/<domain>.md`
- `MODULE_OWNERSHIP.md`
- selected task sections only

### /pact:plan-task-review

Read:
- `pact slice --headers`
- selected task sections via `pact slice --ids`

### /pact:plan-arch-review

Read:
- `pact slice --headers`
- `contracts/manifest.md`
- selected task `context_refs`

### /pact:plan-ui-review

Read:
- `pact slice --headers`
- UI task sections via `pact slice --ids`
