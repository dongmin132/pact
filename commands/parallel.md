---
description: 워커 N개 동시 spawn (worktree 격리) → 머지 → PROGRESS 갱신
---

`/pact:parallel` 실행됨. 아래 단계 순서대로. 실패 안내는 모두 한국어.

## 단계 1: 사전 검사 (모두 통과해야 진행)

1. `CLAUDE.md` 없음 → "/pact:init 먼저" 후 중단
2. `TASKS.md` 또는 `tasks/*.md` 없음 → "/pact:plan 먼저"
3. **TBD 잔존** → "/pact:contracts 먼저"
4. 컨텍스트 가드: `node ${CLAUDE_PLUGIN_ROOT}/bin/pact context-guard --parallel` (실패는 경고만, 중단 X). 긴 PRD/spec을 VS Code에서 선택 중이면 한국어로 해제 안내.
5. 머지 진행 중: `git rev-parse -q --verify MERGE_HEAD` exit 0이면 "/pact:resolve-conflict 또는 git merge --abort 후 재실행" 중단
6. git 환경: `node -e "const{checkEnvironment}=require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');const r=checkEnvironment();if(!r.ok){console.error(JSON.stringify(r.errors));process.exit(1)}"` 실패 시 한국어 안내 + 중단

## 단계 2: Review 확인 게이트

한국어로 묻기: plan-task-review / plan-arch-review / plan-ui-review 중 어디까지 했는지. 답 [검토 없이] 시 PROGRESS.md에 `risk_acknowledged: true` + ts 박음.

## 단계 3: 배치 계획

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact batch
```

`.pact/batch.json` 생성. exit: 0 ok / 2 task source 없음(→/pact:plan) / 3 파싱 / 4 TBD(→/pact:contracts) / 5 cycle.

**3-A 스킵 게이트**: exit 0 + `batches[0].task_ids.length ≤ 2` + `skipped.length === 0` → coordinator review 스킵 (CLI가 이미 결정적 검증). 단계 4로.

**3-B coordinator review** (위 조건 위반): Task tool, `subagent_type: coordinator`, prompt: "검토 모드. .pact/batch.json 의도·논리 점검 후 OK 또는 수정 사유". 수정 필요 시 사용자 위임.

동시 한도 5 (ARCHITECTURE.md §6). `--max=N`으로 더 줄임.

`batches[0]` 비어있으면 "실행 가능한 task 없음. /pact:status 또는 /pact:plan." 후 종료.

## 단계 4: worktree 생성

각 task_id에 대해:

```bash
node -e "const{createWorktree}=require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');console.log(JSON.stringify(createWorktree('<task_id>','main')))"
```

stdout JSON에서 `working_dir`/`branch_name`/`abs_path` 보관 (createWorktree가 main의 `node_modules` symlink도 자동 박음). 하나라도 실패 시 만들어진 worktree 모두 `removeWorktree`로 롤백 후 중단.

## 단계 5: payload + prompt 렌더

각 task별로 payload JSON 작성:

필드: `task_id`, `title`, `allowed_paths`, `forbidden_paths`, `done_criteria`, `verify_commands`, `contracts`, `context_refs`, `tdd`, `educational_mode`, `working_dir`, `branch_name`, `base_branch`, `context_budget_tokens: 20000`.

```bash
mkdir -p .pact/runs/<task_id> && echo '<JSON>' > .pact/runs/<task_id>/payload-input.json
node ${CLAUDE_PLUGIN_ROOT}/scripts/spawn-worker.js .pact/runs/<task_id>/payload-input.json
```

stdout JSON에서 `task_prompt`, `prompt_path`, `context_path`, `status_path` 보관. **`prompt_path`(전체 워커 지시) 메인은 read 금지** — `task_prompt`만 Task tool에 넘김.

## 단계 6: 병렬 spawn (Task tool ×N, **한 메시지에서**)

서브에이전트 nesting 불가 (ARCHITECTURE.md §14.2) — 메인이 직접 동시 호출:

- `subagent_type`: `worker`
- `description`: `<task_id>: <title>`
- `prompt`: 단계 5의 `task_prompt`

순차 호출은 직렬화. **반드시 한 메시지에 N개 Task call**.

## 단계 7: 종료 대기 + status 수집

```bash
for id in <task_ids>; do
  cat ".pact/runs/$id/status.json" 2>/dev/null || echo '{"status":"blocked","blockers":["status.json missing"]}'
done
```

## 단계 8: 머지 게이트

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact merge
```

`.pact/merge-result.json` 생성. exit 0 ok / 6 충돌.

**8-A (exit 0)**: `merged: [...]` 모두 성공 → 단계 9.

**8-B (exit 6)**: `conflicted = { task_id, files, error }` 있음. CLI는 abort 안 함 (보존). 한국어 안내:
> ⚠️ 머지 충돌 — 성공: \<merged\>, 충돌: \<task_id\>(파일 \<files\>), 미시도: \<skipped\>. /pact:resolve-conflict 또는 git merge --abort.

cleanup은 성공한 것만, 단계 10으로.

## 단계 9: 성공 worktree 정리

```bash
node -e "const{removeWorktree}=require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');['<id1>','<id2>'].forEach(id=>{const r=removeWorktree(id);if(!r.ok)console.error(id,r.error)})"
```

머지 성공만 정리. 실패·blocked·충돌은 **보존** (디버깅·재개).

## 단계 10: coordinator 통합 모드

Task tool, `subagent_type: coordinator`, prompt:

```
통합 모드.
방금 종료 워커: <task_id 목록>
머지 결과: 성공 <merged>, 충돌 <yes|no>

먼저 docs/context-map.md를 읽고 .pact/runs/<id>/status.json들에서 PROGRESS.md 갱신:
- Recently Done · Blocked / Waiting · Verification Snapshot · DECISIONS.md 누적
```

## 단계 11: 결과 보고 (한국어)

**모두 성공**: ✅ Cycle \<N\> 완료. 머지 \<N\>개. 검증 lint/tc/test/build 결과. PROGRESS·DECISIONS 갱신. 다음: /pact:status, /pact:parallel.

**부분 실패/충돌**: ⚠️ Cycle \<N\> 부분 완료. 성공 (\<N\>): ✓ ids. 실패·blocked (\<M\>): ✗ id 사유. 충돌: ✗ id 파일 → /pact:resolve-conflict. worktree 보존: `.pact/worktrees/<id>`.

## 의문 시

- 동시 `/pact:parallel` 두 번: G12에 따라 거부, /pact:status·/pact:abort 안내
- ready task 6+: 5개만, 사용자에게 알림
- 워커 timeout: 대기 + 진행 보고
- 부분 worktree 생성 후 실패: 모두 롤백 후 에러 보고
