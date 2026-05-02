---
description: 워커 N개 동시 spawn (worktree 격리) → 머지 → PROGRESS 갱신
---

사용자가 `/pact:parallel`을 실행했습니다.

## 단계 1: 사전 검사

다음 모두 통과해야 진행:

1. `CLAUDE.md` 존재 — 없으면 "/pact:init을 먼저 실행해주세요" 후 중단
2. `TASKS.md` 존재 — 없으면 "/pact:plan을 먼저 실행해주세요" 후 중단
3. **TBD 마커 0개** — TBD 있으면 "/pact:contracts를 먼저 실행해주세요 (architect가 계약 정의)" 후 중단
4. **머지 진행 중 X**:
   ```bash
   git rev-parse -q --verify MERGE_HEAD
   ```
   exit 0이면 이전 cycle 머지 충돌 미해결. 다음 메시지 후 중단:
   ```
   ⚠️ 이전 cycle의 머지 충돌이 미해결 상태입니다.
   /pact:resolve-conflict 또는 git merge --abort 후 다시 실행해주세요.
   ```
5. **git 환경 검증**:
   ```bash
   node -e "
   const { checkEnvironment } = require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
   const r = checkEnvironment();
   if (!r.ok) { console.error(JSON.stringify(r.errors)); process.exit(1); }
   "
   ```
   실패 시 에러 메시지를 한국어로 사용자에게 표시 후 중단.

## 단계 2: Review 확인 게이트 (한국어)

```
이 plan에 대해 review를 진행하셨나요?

  [1] /pact:plan-task-review 실행 완료 (분해 품질)
  [2] /pact:plan-arch-review 실행 완료 (아키텍처 + 계약)
  [3] /pact:plan-ui-review 실행 완료 (UI 디자인, 해당 시)
  [4] 위 셋 다 실행 완료
  [5] 검토 없이 진행 (위험 인수)
```

답변 5 → PROGRESS.md에 `risk_acknowledged: true` + timestamp 박음.

## 단계 3: 배치 계획 (pact batch CLI)

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact batch
```

성공 시 `.pact/batch.json` 생성. `batches[0]` (첫 번째 배치)이 이번 cycle 대상.

exit code:
- 0: 성공
- 2: TASKS.md 없음 → "/pact:plan 먼저"
- 3: 파싱 에러
- 4: TBD 잔존 → "/pact:contracts 먼저"
- 5: 배치 생성 실패 (cycle 등)

`coordinator` 호출하여 batch.json 검토 (LLM 판단 영역):

Task tool:
- `subagent_type`: `coordinator`
- prompt: "검토 모드. .pact/batch.json을 읽고 의도·논리 점검 후 OK 또는 수정 사유 반환"

OK면 진행. 수정 필요하면 사용자에게 위임.

**동시 한도** (ARCHITECTURE.md §6):
- batch.json `batches[0]`이 default 5 이내 (`buildBatches({maxBatchSize: 5})`)
- 사용자가 `--max=N` 인자 줘서 더 줄일 수 있음 (이번 cycle만 N개)
- 5 초과 절대 X

`batches[0]` 비어있으면:
```
실행 가능한 task 없음. /pact:status 또는 /pact:plan.
```
후 종료.

## 단계 4: 각 task당 worktree 생성

선택한 task ID 목록에 대해 순차적으로:

```bash
node -e "
const { createWorktree } = require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
const r = createWorktree('<task_id>', 'main');
console.log(JSON.stringify(r));
"
```

각 결과의 `working_dir`/`branch_name`/`abs_path` 보관. 하나라도 실패하면:
- 이미 생성한 worktree들 모두 removeWorktree로 롤백
- 사용자에게 에러 보고 후 중단

## 단계 5: 각 워커 payload 구성 + prompt 준비

각 task에 대해:

```json
{
  "task_id": "<id>",
  "title": "<title>",
  "allowed_paths": [...],
  "forbidden_paths": [...],
  "done_criteria": [...],
  "verify_commands": [...],
  "contracts": {...},
  "tdd": <bool>,
  "educational_mode": <frontmatter.educational_mode>,
  "working_dir": "<from createWorktree>",
  "branch_name": "<from createWorktree>",
  "base_branch": "main",
  "context_budget_tokens": 20000
}
```

저장 + prompt 렌더:

```bash
mkdir -p .pact/runs/<task_id>
echo '<JSON>' > .pact/runs/<task_id>/payload-input.json
node ${CLAUDE_PLUGIN_ROOT}/scripts/spawn-worker.js .pact/runs/<task_id>/payload-input.json
```

stdout JSON에서 각 task의 `prompt`, `status_path` 보관.

## 단계 6: 다중 워커 동시 spawn (Task tool 병렬 호출)

**중요**: 메인 Claude가 **한 메시지에서 Task tool을 N번 동시 호출**한다. 이게 진짜 병렬 spawn (서브에이전트는 다른 서브에이전트 spawn 불가, ARCHITECTURE.md §14.2).

각 워커 호출:
- `subagent_type`: `worker`
- `description`: `<task_id>: <title>`
- `prompt`: 단계 5에서 받은 prompt 그대로
- 워커는 자기 worktree 안에서만 작업해야 함 (시스템 프롬프트로 강제)

여러 Task call이 한 메시지에 들어가야 병렬. 순차 호출은 직렬.

## 단계 7: 모든 워커 종료 대기 + status.json 수집

워커들이 모두 종료한 후 각각의 status.json read:

```bash
for id in <task_ids>; do
  cat ".pact/runs/$id/status.json" 2>/dev/null || echo '{"status":"blocked","blockers":["status.json missing"]}'
done
```

수집한 결과를 메모리에 보관 (단계 8·10에서 사용).

## 단계 8: 머지 게이트 (pact merge CLI)

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact merge
```

CLI가 결정적으로:
1. 모든 `.pact/runs/*/status.json` schema 검증
2. status=done + clean_for_merge=true + verify pass + ownership 위반 X 인 워커만 머지 대상
3. mergeAll 호출
4. 결과를 `.pact/merge-result.json`에 기록

exit code:
- 0: 모두 성공 (또는 일부 거부 + 충돌 0)
- 6: 충돌 발생 (worktree 보존, /pact:resolve-conflict 안내)

stdout 결과 read 후 다음 분기:

### 8-A: exit 0, conflicted=null
- `.pact/merge-result.json`의 `merged: [...]` 모두 성공
- 단계 9로

### 8-B: exit 6, conflicted 있음
- `merge-result.json.conflicted = { task_id, files, error }`
- **CLI는 abort 안 함** (사용자가 직접 해결하도록 보존)
- 한국어 안내:
  ```
  ⚠️ 머지 충돌

  성공: <merged>
  충돌: <task_id> (파일: <files>)
  미시도: <skipped>

  /pact:resolve-conflict 또는 git merge --abort
  ```
- coordinator 통합 모드 호출 (단계 10). cleanup은 성공한 것만.

## 단계 9: 성공한 worktree 정리

`merged`에 들어간 task들의 worktree를 제거:

```bash
node -e "
const { removeWorktree } = require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
['<task_id1>', '<task_id2>'].forEach(id => {
  const r = removeWorktree(id);
  if (!r.ok) console.error(id, r.error);
});
"
```

머지 성공한 것만 정리. 실패·블록·충돌은 **보존** (디버깅·재개용).

## 단계 10: coordinator 통합 모드 호출

Task tool로 `coordinator` 호출:
- `description`: "워커 결과 통합 — cycle <N>"
- `prompt`:
  ```
  통합 모드.
  
  방금 종료한 워커: <task_id 목록>
  머지 결과: 성공 <merged>, 충돌 <conflicted ? 'yes' : 'no'>
  
  .pact/runs/<id>/status.json 들을 읽고 PROGRESS.md를 갱신해주세요.
  - Recently Done: 머지 성공한 task들
  - Blocked / Waiting: 실패·blocked·충돌 task들 (사유 + status.json 경로)
  - Verification Snapshot: verify_results 종합
  - DECISIONS.md: status.json의 decisions 누적
  ```

## 단계 11: 결과 보고 (한국어)

### 11-A: 모두 성공
```
✅ Cycle <N> 완료

머지: <merged 개수>개
  ✓ <task_id1>  <title>
  ✓ <task_id2>  <title>

검증: lint:✅ typecheck:✅ test:✅ build:✅
PROGRESS.md, DECISIONS.md 갱신됨.

다음:
  /pact:status           # 진행 확인
  /pact:parallel         # 다음 task 실행
```

### 11-B: 일부 실패·충돌
```
⚠️ Cycle <N> 부분 완료

성공 (<N>):
  ✓ ...

실패·blocked (<M>):
  ✗ <id>  <사유 한 줄>

충돌:
  ✗ <id>  파일: <files>
  → /pact:resolve-conflict

worktree 보존됨 (디버깅·재개용):
  .pact/worktrees/<id>
```

## v1.0에서 안 하는 것

- ❌ `pact batch` CLI로 배치 계획 (P2.6, PACT-041) — 지금은 단순 ready 선택
- ❌ 머지 전 reviewer 자동 호출 (P1, PACT-024)
- ❌ Cross-review 자동 호출 (P2.5, PACT-035)
- ❌ 회로 차단기 자동 재시도 (P1, PACT-021)

## 의문 시

- 동시 `/pact:parallel` 두 번 시도: G12에 따라 거부, /pact:status·/pact:abort 안내
- ready task 6개 이상: 5개만 선택, 사용자에게 알림 ("X개는 다음 cycle로")
- 워커 timeout: 일단 대기, 사용자에게 진행 상황 보고
- 부분 worktree 생성 후 실패: 모두 롤백 후 에러 보고
