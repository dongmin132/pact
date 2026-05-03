# pact Context Map

> 긴 SOT 문서는 보관하되 기본 컨텍스트에는 올리지 않는다.
> 명령은 이 인덱스를 먼저 보고 필요한 shard/섹션만 `rg`, `sed`, `pact slice`로 읽는다.

## Global Rules

- `CLAUDE.md`는 정책 확인용으로만 읽고, 긴 문서 본문은 `rg`로 필요한 섹션부터 찾는다.
- `TASKS.md` 단일 파일은 legacy 호환용이다. 새 프로젝트는 `tasks/*.md`를 SOT로 쓴다.
- `API_CONTRACT.md`와 `DB_CONTRACT.md` 단일 파일은 legacy manifest다. 새 계약은 `contracts/api/*.md`, `contracts/db/*.md`에 둔다.
- `DECISIONS.md`는 ADR index로 유지하고, 길어지면 `docs/decisions/ADR-*.md`로 분리한다.
- `PROGRESS.md`는 현재 상태만 유지하고 오래된 cycle 상세는 `.pact/history/`로 archive한다.

## File Map

| 작업 종류 | 먼저 읽기 | 필요할 때만 읽기 |
|---|---|---|
| task 분해 | `CLAUDE.md`, `docs/context-map.md` | PRD의 관련 섹션 |
| task 검토 | `pact slice --headers`, `pact slice --status todo` | `pact slice --ids <ids>` |
| 계약 정의 | `pact slice --tbd`, `docs/context-map.md#contracts` | `contracts/api/<domain>.md`, `contracts/db/<domain>.md` |
| 아키텍처 검토 | `pact slice --headers`, `contracts/manifest.md` | 선택 task의 `context_refs` |
| UI 검토 | `pact slice --headers` | UI task만 `pact slice --ids <ids>` |
| 병렬 실행 | `.pact/batch.json` | 선택 task의 `context_refs` |
| 코드 검증 | `.pact/merge-result.json` | 변경 파일과 관련 contract shard |

## Tasks

Preferred layout:

```text
tasks/
  auth.md
  meetup.md
  chat.md
```

Each task should include:

```yaml
context_refs:
  - contracts/api/<domain>.md#<endpoint-or-section>
  - contracts/db/<domain>.md#<table-or-rpc>
  - docs/decisions/ADR-000-example.md
```

Commands:

```bash
pact slice --headers
pact slice --tbd
pact slice --ids MEETUP-001,MEETUP-002
pact split-docs --dry-run   # legacy 긴 문서 shard 이전 미리보기
pact split-docs             # TASKS/API/DB legacy 문서 shard 생성
```

## Contracts

Preferred layout:

```text
contracts/
  manifest.md
  api/
    meetup.md
  db/
    meetup.md
```

`contracts/manifest.md` lists domains and shard paths only. Contract details live in domain shards.

## Command Read Profiles

### /pact:plan

Read:
- `CLAUDE.md`
- `docs/context-map.md`
- PRD section headers, then relevant PRD sections

Write:
- `tasks/<domain>.md`
- optionally legacy `TASKS.md` as index only

### /pact:contracts

Read:
- `docs/context-map.md`
- `pact slice --tbd`
- `contracts/manifest.md` if present

Write:
- `contracts/api/<domain>.md`
- `contracts/db/<domain>.md`
- `MODULE_OWNERSHIP.md`
- selected `tasks/<domain>.md` sections to replace TBD with pointers

### /pact:plan-task-review

Read:
- `pact slice --headers`
- suspicious task sections only via `pact slice --ids`

Do not read:
- full task corpus
- contract shards unless task metadata requires it

### /pact:plan-arch-review

Read:
- `pact slice --headers`
- `contracts/manifest.md`
- selected `context_refs`

Do not read:
- all `contracts/api/**`
- all `contracts/db/**`

### /pact:plan-ui-review

Read:
- `pact slice --headers`
- only UI task sections via `pact slice --ids`

Do not read:
- backend contract shards unless UI task explicitly references them
