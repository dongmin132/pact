# TASKS — <project-name>

> planner가 매 사이클 갱신. task당 yaml 블록 형식.
> 파서는 yaml 코드블록만 추출하므로 prose는 자유롭게 작성 가능.

---

## frontmatter

```yaml
educational_mode: false   # /pact:plan 시 사용자 답변 반영됨
prd_source: null          # PRD 입력 시 docs/PRD-*.md 경로
```

---

## Task 작성 가이드

각 task는 다음 yaml 블록을 포함:

```yaml
priority: P0 | P1 | P2
dependencies:
  - task_id: <id>
    kind: complete | contract_only
allowed_paths:
  - <glob 또는 구체 경로>
forbidden_paths:
  - <glob>
files:
  - <이 task가 만들·수정할 파일 목록>
work:
  - <한 줄 작업 설명>
done_criteria:
  - <검증 가능한 완료 조건 — 측정 가능해야 함>
verify_commands:
  - <이 task에 적용되는 검증 명령>
contracts:
  api_endpoints: []
  db_tables: []
tdd: true | false
context_budget_tokens: 20000
prd_reference: <docs/PRD.md §X.X>   # PRD 기반일 때만
sourcing: <ARCHITECTURE.md §X 또는 PRD §Y>
```

**규칙**:
- task당 파일 수 ≤ 5
- done_criteria 최소 1개 (측정 가능)
- TBD 마커 허용 (architect가 해소)
- 의존성은 같은 TASKS.md 안의 task_id만 참조 가능

---

> planner가 `/pact:plan` 실행 시 이 아래에 task들을 추가합니다.
> task heading 형식: `## <PREFIX>-<번호>  <한 줄 제목>` (대문자 prefix + 숫자, 예: `## AUTH-001  로그인 API`).
