---
description: escalation된 task를 사람이 보존된 worktree에서 인터랙티브로 이어받기 — /pact:takeover [task_id]
---

사용자가 `/pact:takeover $ARGUMENTS`를 실행했습니다.

## 이 커맨드가 하는 일 (vs /pact:resume)

- **`/pact:resume`** — 회로차단 task에 **fresh 워커를 재spawn** (자동). 같은 실패를 반복할 수 있음.
- **`/pact:takeover`** — 사람(=지금 이 세션)이 **보존된 worktree에서 직접 이어받아** 부분작업을 마무리. `pact drive`가 escalate(예산 소진·정체·회로차단)하며 worktree를 `salvageable`로 보존했지만, 사람이 그걸 열어 끝낼 on-ramp이 없던 공백을 메운다. 워커 재시도로 안 풀리는 판단·커플링 task에 쓴다.

**철학 준수**: 자동 반영 X. 사람이 명시적으로 task를 골라 인계 → 완성 → status=done → collect/merge가 머지한다.

## 단계 1: 인자 분기

- `$ARGUMENTS`가 비었으면 → **단계 2 (인계 후보 목록)**.
- `$ARGUMENTS`가 task_id 형식(`[A-Z][A-Z0-9]*-\d+`)이면 → **단계 3 (그 task 인계)**.
- 형식이 이상하면 usage 표시 후 중단:
  ```
  Usage: /pact:takeover [task-id]
    인자 없이:  인계 가능한 escalation task 목록
    task-id 지정:  그 task를 이어받기
  예: /pact:takeover CLEANUP-029
  ```

## 단계 2: 인계 후보 discovery (인자 없을 때)

보존된 worktree를 스캔해 아직 안 끝난 task를 찾는다 (driver-state가 per-task 사유를 영속하지 않으므로 디스크에서 복원):

```bash
node -e '
const fs = require("fs"), path = require("path");
const wt = ".pact/worktrees";
if (!fs.existsSync(wt)) { console.log("보존된 worktree 없음 (.pact/worktrees/)."); process.exit(0); }
const rows = [];
for (const id of fs.readdirSync(wt)) {
  const wdir = path.join(wt, id);
  if (!fs.statSync(wdir).isDirectory()) continue;
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(".pact/runs", id, "status.json"), "utf8")); } catch {}
  const status = st ? st.status : "(status.json 없음 — 워커 미완)";
  if (status === "done" && st && st.clean_for_merge) continue; // 이미 완료·머지대상 → 후보 아님
  const blockers = st && Array.isArray(st.blockers) ? st.blockers : [];
  rows.push({ id, status, blockers });
}
if (!rows.length) { console.log("인계 대상 없음 — 모든 worktree가 완료 상태."); process.exit(0); }
console.log("인계 가능한 task (" + rows.length + "):\n");
for (const r of rows) {
  console.log("  " + r.id + "  [" + r.status + "]");
  for (const b of r.blockers) console.log("     ↳ " + b);
}
'
```

목록을 한국어로 보여준 뒤:
```
이어받을 task를 고르세요:  /pact:takeover <task-id>
```
후 중단. (자동 선택 X)

## 단계 3: 사전 검사 (task_id 지정)

1. `.pact/worktrees/$ARGUMENTS/` 존재 — 없으면 "보존된 worktree 없음. `pact drive`가 이 task를 salvageable로 남기지 않았거나 이미 정리됨. `/pact:resume $ARGUMENTS`(fresh 워커) 또는 `/pact:plan` 재분해 권장." 후 중단.
2. `.pact/runs/$ARGUMENTS/status.json` 있으면 read — 없으면 "워커가 status 미작성(턴 소진 추정). worktree의 부분 커밋만 있음." 안내.

## 단계 4: 실패 사유 + 부분 진행 표시

status.json이 있으면 `blockers`·`verify_results`·`files_attempted_outside_scope`를, worktree 브랜치의 부분 커밋을 사용자에게 보여준다:

```bash
echo "=== $ARGUMENTS 이전 상태 ===" && \
node -e 'try{const s=JSON.parse(require("fs").readFileSync(".pact/runs/'"$ARGUMENTS"'/status.json","utf8"));console.log("status:",s.status);console.log("blockers:",(s.blockers||[]).join(" | ")||"(없음)");console.log("verify:",JSON.stringify(s.verify_results||{}));console.log("scope밖 시도:",(s.files_attempted_outside_scope||[]).join(", ")||"(없음)");}catch(e){console.log("status.json 없음");}' && \
echo "=== worktree 부분 커밋 ===" && \
git -C .pact/worktrees/$ARGUMENTS log --oneline -10 2>/dev/null && \
echo "=== 미커밋 변경 ===" && \
git -C .pact/worktrees/$ARGUMENTS status --short 2>/dev/null
```

이 task의 계약(`prompt.md`/`context.md`/`allowed_paths`/`done_criteria`)을 `.pact/runs/$ARGUMENTS/` 에서 확인한다. `files_attempted_outside_scope`가 있으면 **계약모순 신호** — `pact scopecheck`로 done_criteria가 allowed_paths 밖 생성을 의무화하는지 점검하고, 그렇다면 task 계약부터 고친 뒤 인계한다(안 그러면 완성해도 merge 게이트가 또 거부).

## 단계 5: 인계 — 사람이 worktree에서 이어서 마무리

**이 세션이 워커가 된다.** 새 워커를 spawn하지 않는다.

1. `.pact/worktrees/$ARGUMENTS/` 안에서 작업한다 (부분 진행분 위에 이어서).
2. **allowed_paths 준수** — 계약 밖 파일 수정 X (merge 게이트가 거부). 계약 밖이 꼭 필요하면 멈추고 사용자에게 계약 수정 위임.
3. `done_criteria`를 하나씩 충족. TDD task면 RED→GREEN 유지.
4. 논리 단위마다 worktree 브랜치에 커밋 (끊겨도 보존).
5. `verify_commands` 실행해 typecheck/test/build 통과 확인 (fail이면 `done` 금지).

## 단계 6: 완료 처리

1. worktree에서 최종 커밋.
2. `.pact/runs/$ARGUMENTS/status.json`을 실측값으로 갱신: `status="done"`, `clean_for_merge=true`, `verify_results`(실제 실행 결과), `files_changed`, `completed_at`(ISO 8601). verify가 하나라도 fail이면 `status="blocked"`로 남긴다.
3. `pact validate-status .pact/runs/$ARGUMENTS/status.json`으로 스키마 검증.
4. 머지는 `/pact:verify` 또는 `pact merge`(collect)가 게이트를 거쳐 수행 — **여기서 직접 main 머지 X** (검증 없이 병합하지 않는다).

## 단계 7: 결과 보고 (한국어)

성공:
```
✅ $ARGUMENTS 인계 완료 — worktree에서 마무리, status=done.
다음: /pact:verify (또는 pact merge) 로 게이트 통과 후 머지.
```

미완(또 막힘):
```
⚠️ $ARGUMENTS 인계 중 막힘 — status=blocked 유지.
blockers: <목록>
worktree 부분 진행분은 보존됨 (.pact/worktrees/$ARGUMENTS/).
```

## 의문 시

- worktree가 옛 payload/계약 버전: 사용자에게 안내, `/pact:plan` 재호출 권장.
- allowed_paths 밖 수정이 done_criteria상 불가피(계약모순): 강제 진행 X. `pact scopecheck` 결과와 함께 사용자에게 계약 수정 위임.
- 같은 task 누적 3회 이상 실패 이력: DECISIONS.md에 "왜 실패하는가" ADR 기록 후 재분해 권장 (인계 반복 금지).
