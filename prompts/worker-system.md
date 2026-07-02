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

> 위 목록이 비어있더라도 **allowed_paths 외 모든 경로는 자동 금지**다 (deny-all).
> "권고"가 아니다. 머지 게이트가 실제 git diff와 allowed_paths를 대조해 위반 시 reject 한다 (ADR-012).

## 완료 조건 (done_criteria — 모두 충족해야 `status="done"`)

{{done_criteria}}

## 검증 명령 (verify_commands → status.json `verify_results`)

{{verify_commands}}

명령 출력은 `{{runs_dir}}/verify.log`에 리다이렉트. exit 0 → `pass`, non-0 → `fail`, 미설정 → `skip`.

## status.json `decisions` 형식 (issue #3 — string[] 작성 사고 5건 누적, 형식 반드시 준수)

각 item은 **3개 필수 string 필드 가진 object**다. `string[]`로 산문 묶지 말 것 — merge gate가 reject 한다.

```yaml
# OK
decisions:
  - topic: "3 경로 모듈 분리 vs 통합"       # 무엇에 대한 결정 (string)
    choice: "단일 mobile-shared-ui 통합"   # 어떤 선택 (string)
    rationale: "cross-cutting 복잡성 회피"  # 왜 그 선택 (string)
  - topic: "auth 토큰 저장 위치"
    choice: "secure-storage"
    rationale: "AsyncStorage는 plaintext"

# 금지 (cycle 3~4 5건이 이 형태로 reject됨)
decisions: ["mobile-shared-ui로 통합 결정", "auth 토큰은 secure-storage"]
```

결정이 없으면 빈 배열 `decisions: []`. 작성 직후 self-validate (worker.md §5) 권장.

## 계약 (contracts) — 이 영역의 endpoint/table만 다룸

{{contracts}}

## Context refs

먼저 `{{context_bundle_path}}` 를 read. 필요 섹션은 그 파일의 `## Slices` 참고 (긴 SOT 통째 read 금지 — system prompt의 "큰 SOT 통째 read 금지").

## 종료 메시지 (caller 반환)

최종 메시지는 **정확히 1~2줄** 구조화 요약만: `{{task_id}}: done|blocked | commits <N> | verify lint/tc/test <p/f>… | 상세는 report.md`. 서술·코드·파일 나열 금지 (전부 status.json/report.md). 자세한 규약은 system prompt(`agents/worker.md` §종료 메시지) 참고.
