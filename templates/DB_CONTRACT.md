# DB 계약 — <project-name> (read-only)

> ⚠️ **이 문서는 read-only 참조용입니다.**
> DB 스키마의 진실(SOT)은 마이그레이션 파일 (`prisma/`, `migrations/`, `db/migrate/` 등).
> architect가 `/pact:contracts`에서 마이그레이션을 보고 자동 생성.
> 직접 수정 X — 마이그레이션 변경 시 자동 갱신됨.

---

## 사용 가이드

각 테이블은 다음 yaml 블록:

```yaml
table: <이름>
columns:
  - name: <col_name>
    type: <type>
    nullable: <bool>
    default: <value>
indexes:
  - <컬럼 목록>
foreign_keys:
  - column: <col>
    references: <table.col>
related_tasks:
  - <TASK-ID>
```

---

## (예시) users 테이블

```yaml
table: users
columns:
  - name: id
    type: uuid
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: varchar(255)
    nullable: false
  - name: password_hash
    type: varchar(255)
    nullable: false
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
indexes:
  - email
foreign_keys: []
related_tasks:
  - PROJ-001
```

---

> 위 예시는 실제 마이그레이션 적용 후 자동 갱신됨.
