# Modules — example

> 워커 권한 경계 shard. `pre-tool-guard` hook이 `contracts/modules/*.md` + 레거시 `MODULE_OWNERSHIP.md`를 합쳐 검증한다.
> 각 task의 `allowed_paths`가 여기 owner_paths 안에 들어가야 함.

## (예시) example 모듈

```yaml
module: example
owner_paths:
  - src/example/**
  - src/types/example.ts
shared_with: []
related_tasks:
  - EXAMPLE-001
```

> 첫 모듈 추가 시 위 예시는 삭제하고 실제 owner_paths로 교체.
