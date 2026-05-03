# API 계약 — <project-name>

> Legacy manifest. 새 endpoint 상세 SOT는 `contracts/api/<domain>.md`.
> architect가 `/pact:contracts`에서 domain shard를 생성·갱신.
> task의 `contracts.api_endpoints`와 `context_refs`에서 참조됨.

---

## 사용 가이드

각 endpoint는 `contracts/api/<domain>.md`에 다음 yaml 블록 형식으로:

```yaml
method: GET | POST | PUT | DELETE | PATCH
path: /api/<resource>
auth: public | user | admin
request:
  params:        # path/query params
    <name>: <type>
  body:          # POST/PUT일 때
    <name>: <type>
response:
  <status_code>:
    <name>: <type>
related_tasks:   # 이 endpoint를 다루는 task ID
  - <TASK-ID>
```

**규칙**:
- 시그니처만 박음. 구현은 워커 영역.
- task의 contracts에서 이 endpoint를 참조 시 `POST /api/auth/login` 같은 식별자 사용.
- 변경은 architect가 (사용자 명시 결정 후).

---

## (예시) POST /api/auth/login

```yaml
method: POST
path: /api/auth/login
auth: public
request:
  body:
    email: string
    password: string
response:
  200:
    token: string
    user_id: string
    expires_at: string  # ISO 8601
  401:
    error: 'invalid_credentials'
  429:
    error: 'rate_limited'
    retry_after: number
related_tasks:
  - PROJ-001
```

(prose: 이 endpoint의 비즈니스 룰·rate limit·관련 SLO 등 자유 작성)

---

> 위 예시 섹션은 첫 endpoint 추가 시 삭제하거나 갱신.
