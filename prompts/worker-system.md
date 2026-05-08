# Task 변수 — {{task_id}}: {{title}}

이 파일은 **task별 변수**다. 정책·anti-pattern·종료 의무·TDD/교육 모드 동작은 system prompt(`agents/worker.md`)에 박혀있다.

## 핵심 변수

| 항목 | 값 |
|---|---|
| task_id | {{task_id}} |
| title | {{title}} |
| working_dir | {{working_dir}} |
| branch_name | {{branch_name}} |
| base_branch | {{base_branch}} |
| runs_dir | {{runs_dir}} |
| tdd_mode | {{tdd_mode}} |
| educational_mode | {{educational_mode}} |
| prd_reference | {{prd_reference}} |
| context_budget_tokens | {{context_budget_tokens}} |
| context_bundle_path | {{context_bundle_path}} |

## 작업 가능 경로 (allowed_paths)

{{allowed_paths}}

## 작업 금지 경로 (forbidden_paths)

{{forbidden_paths}}

## 완료 조건 (done_criteria — 모두 충족해야 `status="done"`)

{{done_criteria}}

## 검증 명령 (verify_commands → status.json `verify_results`)

{{verify_commands}}

명령 출력은 `{{runs_dir}}/verify.log`에 리다이렉트. exit 0 → `pass`, non-0 → `fail`, 미설정 → `skip`.

## 계약 (contracts) — 이 영역의 endpoint/table만 다룸

{{contracts}}

## Context refs

먼저 `{{context_bundle_path}}` 를 read. 추가 필요 섹션:

{{context_refs}}

긴 SOT 통째 read 금지 (system prompt의 "큰 SOT 통째 read 금지" 참고).
