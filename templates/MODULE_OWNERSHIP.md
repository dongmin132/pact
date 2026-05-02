# 모듈 권한 경계 — <project-name>

> architect가 `/pact:contracts`에서 생성·갱신.
> 각 task의 `allowed_paths`가 여기 정의된 모듈 안에 들어가야 함 (검증 강제).
> `pre-tool-guard` hook이 워커의 파일 수정 차단에 사용.

---

## 사용 가이드

각 모듈은 다음 yaml 블록:

```yaml
module: <이름>
owner_paths:
  - <glob 또는 구체 경로>
shared_with:    # 이 경로를 같이 다루는 다른 모듈 (cross-cutting)
  - <module-name>
related_tasks:
  - <TASK-ID>
```

**규칙**:
- 모듈 경계 겹침 X (cross-cutting은 `shared_with`로 명시)
- `**/*.test.ts` 같은 cross-cutting glob은 별도 "tests" 모듈로
- 한 task의 `allowed_paths`는 한 모듈 안 (또는 명시적 shared)

---

## (예시) auth 모듈

```yaml
module: auth
owner_paths:
  - src/api/auth/**
  - src/types/auth.ts
  - src/components/auth/**
shared_with: []
related_tasks:
  - PROJ-001
  - PROJ-002
```

## (예시) tests (cross-cutting)

```yaml
module: tests
owner_paths:
  - tests/**
  - "**/*.test.ts"
shared_with:
  - auth
  - users
  - reports
related_tasks: []
```

---

> 위 예시는 첫 모듈 추가 시 삭제하거나 갱신.
