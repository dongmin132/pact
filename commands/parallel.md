---
description: 워커 K개를 슬롯 파이프라인으로 spawn — 완료마다 단건 게이트 머지 + 다음 task 즉시 투입 (run-cycle CLI 기반)
---

`/pact:parallel` 실행됨. 메인은 결정적 작업을 `pact run-cycle`로 묶어 호출하고 LLM 영역(워커 spawn·릴레이·사용자 보고)에 집중. 모든 안내는 한국어.

## 신뢰성 원칙 (전체 플로우의 전제)

**판단은 CLI, 릴레이는 LLM.** 메인은 "이 task 를 지금 투입해도 되나", "이 머지가 합격인가" 를 **스스로 판단하지 않는다** — `pact run-cycle` 이 출력한 **필드만** 따른다 (admit 의 `ok`/`reason`, collect-one 의 `merged`/`rejected`/`conflicted`). 매 워커 완료마다 **한국어 1줄**로 결과를 보고해 사용자가 전 과정을 관찰하게 한다. **충돌·escalation·예산 초과는 정지 후 사람** — 자동 우회·자동 해결 없음 (철학 3·5번).

이 문서는 **이벤트 루프 슬롯 파이프라인**이다: 워커 K개를 백그라운드로 띄우고, 워커가 하나 완료될 때마다 (a)그 task 만 게이트 머지(collect-one) → (b)슬롯이 비었으니 다음 ready task 를 즉시 투입(admit). 느린 task 하나가 배치 전체를 잡지 않는다.

## 단계 0: `pact drive` 넛지 (propose-only)

이번 실행이 **task 3개 이상 + 크기(duration)가 이질적**이면, 시작 전에 한국어로 **한 번** 안내(강제 X, 사용자 선택):

> 이 사이클은 task 다수·크기 편차가 커서 완전 무인 헤드리스 **`pact drive`(동일한 K-슬롯 파이프라인)** 도 선택지입니다. 인터랙티브 `/pact:parallel` 도 슬롯 파이프라인이라 wall-time 은 대등하지만, 매 완료마다 메인이 릴레이(1줄 보고)를 하므로 소량의 오케스트레이션 토큰이 듭니다. 반면 사람이 루프 안에서 매 완료·충돌·escalation 을 직접 관찰·개입할 수 있어 **신뢰성**이 높습니다. `pact drive` 는 오케스트레이션 토큰이 0 이지만 완전 무인입니다.
> - 무인으로 돌리려면: 별도 터미널에서 `pact drive --pact` (테스트 후 `--real`).
> - 이대로 인터랙티브로 계속해도 됩니다(관찰·개입 우선 시 권장).

사용자가 답하지 않거나 "계속"이면 그대로 아래로 진행(자동 전환 X — 철학 5번). 조건 미충족(task 2개 이하 또는 크기 균일)이면 이 절 생략.

## 단계 1: Review 확인 게이트

한국어로 묻기: plan-task-review / plan-arch-review / plan-ui-review 중 어디까지 했는지. 답 [검토 없이] 시 PROGRESS.md에 `risk_acknowledged: true` + ts.

리뷰를 했다면 추가 확인: **권장 액션을 `tasks/*.md`에 반영했는지.** 리뷰는 propose-only(철학 5번) — prepare는 `tasks/*.md`만 읽으므로 미반영이면 리뷰 **전** 원본 task가 워커에 넘어간다. 미반영이면: 작은 fix는 **메인이 사용자 승인 후 `tasks/<domain>.md` 해당 task를 직접 `Edit`**, 구조 변경은 `/pact:plan` 재분해 — 그 후 다시 호출하도록 한국어 안내.

## 단계 2: prepare 호출 (`--graph` = 전체 DAG)

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle prepare --graph --owner-pid=$PPID --session=parallel
```

`--graph` 는 batch0(즉시 spawn 대상)에 더해 **나머지 pending task 의 DAG**(`task_graph`)를 함께 emit 한다 — 슬롯이 빌 때 다음에 투입할 후보를 메인이 알아야 하므로 파이프라인에서는 필수. `--max=K`(1~5)로 이번 cycle 슬롯 수(동시 워커 수)를 줄일 수 있다.

`--owner-pid=$PPID`(claim.js 관례와 동일한 세션 pid)는 STAB-1 멀티세션 게이트용 — prepare 가 이 사이클의 owner 로 stamp 한다. 같은 레포에서 `pact drive`(헤드리스)나 다른 인터랙티브 세션이 **살아있는** 소유자로 같은 사이클을 이미 잡고 있으면 재개 시 `cycle-busy` 로 거부돼 워커 이중 spawn 을 막는다(소유자 세션이 죽었으면 크래시 resume 으로 채택). collect 가 사이클을 소비하면 owner 도 함께 해제된다.

stdout JSON 분기:

- `ok: false` → `stage`별 한국어 안내 후 중단 (`stage`: `preflight` / `task-parse` / `tbd` / `batch` / `worktree` / `spawn-prepare` / `cycle-busy`). 각 errors[i].fix 그대로 사용자에게 표시. `cycle-busy` 는 다른 세션(pid)이 소유 중이라는 뜻 — `error` 문구 그대로 보여주고 종료(그 세션 종료 대기 또는 `pact status`).
- `ok: true, empty: true` → "실행 가능 task 없음. /pact:status 또는 /pact:plan." 종료.
- `ok: true` → 단계 2.5 이후로 진행.
- `already_prepared: true` (재개) → 크래시·`/exit` 후 재호출. **단계 3(fan-out)을 스킵**하고, 혼합 상태(일부 done·미머지 + 일부 미완)를 오분류 없이 라우팅한다 — `current_batch` 의 각 task_id 에 대해 **먼저 `collect-one <id> --commit-status`** 를 호출해 상태를 판정한 뒤 그 결과 필드로 분기:
  - `merged`/`already_merged` → 그 슬롯은 비었으니 **4d(admit)** 로 다음 ready task 투입.
  - `rejected`/`failures`(미완) → **4c(resume-prompt 재투입)** 로 같은 슬롯에 이어서.
  - `conflicted` → **4b(정지)**.
  이 재개 경로에서는 done 워커를 절대 재spawn 하지 않는다(단계 3 fan-out 미실행). `ready_to_collect: true`(모든 워커 done)면 위 collect-one 루프가 전부 merged/already 로 끝나 자연히 4d·종료로 수렴한다.

prepare가 반환한 키:
- `task_prompts: [{task_id, title, task_prompt, status_path, working_dir, allowed_paths, ...}]` — batch0 워커들.
- `task_graph: {ready: [id, ...], tasks: {id: {deps:[...], allowed_paths:[...], status, title}}}` — batch0 밖 pending DAG. `ready` = 의존 충족된 즉시 투입 후보(단, 실제 admit 은 pathsOverlap 재검사를 거친다).
- `context_warnings` / `size_warnings` / `scope_warnings` / `bundle_warnings` / `ownership_warnings` — 있으면 단계 2.6 에서 표면화 (중단 X).
- `coordinator_review_needed: false` — **deprecated** (pre-spawn 검토 제거, P1-3). 무시.

## 단계 2.5: 분담 모드 인식 (v0.6.2)

이 세션이 멀티세션 분담 모드인지 확인 — `pact claim`으로 잡아둔 task가 있나:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact list-locks --mine --alive --json
```

stdout `task_ids`:
- `[]` → **단일세션 모드.** `task_prompts` + `task_graph` 전체를 그대로 사용.
- `[PACT-001, PACT-002, ...]` → **분담 모드.** `task_prompts`·`task_graph` 에서 그 ID들만 대상으로 (다른 세션이 잡은 건 그 세션이 처리).

분담 모드에서는 사용자에게 한국어 안내:
> 🪟 분담 모드: 이 세션이 잡은 N개만 sub-agent로 처리 (다른 세션이 나머지 처리 중).

## 단계 2.6: 슬로우니스·계약 경고 표면 (조건부, propose-only)

prepare 결과의 `size_warnings` / `scope_warnings` / `bundle_warnings` / `ownership_warnings` 중 **하나라도 비어있지 않으면**, fan-out **전에** 한국어로 요약하고 진행 여부를 확인한다 (자동 수정 X, 철학 5번). 전부 빈 배열이면 이 단계 스킵.

> ⚠️ fan-out 전 사전경보 (분해·수정이 아직 무료인 지점):
> - 🔴 **턴소진 위험** (size_warnings): `<task>` — `<reason>`. 워커가 한 턴에 못 끝내 resume·salvage로 wall-time이 배로 늘 수 있음.
> - 🔴 **계약모순** (scope_warnings): `<task>` — done_criteria가 allowed_paths 밖 파일 생성을 요구 → merge 게이트가 통째 거부(작업 유실).
> - 🔴 **오너십 침범** (ownership_warnings): `<task>` — allowed_paths가 MODULE_OWNERSHIP 어느 오너 영역에도 속하지 않음(`<violations[].path>`). merge 게이트도 못 잡는 계약 경계 위반.
> - 🟡 **컨텍스트 bloat** (bundle_warnings): `<task_id>` — `<ref>`(`<lines>`줄)가 anchor 없이 K워커에 통째 복제.
>
> 어떻게 할까요?
> 1. **분해/수정 후 재시작** (권장): `/pact:plan` 재분해(oversized) 또는 사용자 승인 후 메인이 `tasks/<domain>.md`의 해당 task를 직접 `Edit`(계약모순=경로 추가/의무 제거, 오너십=allowed_paths를 오너 영역 안으로 or MODULE_OWNERSHIP 갱신, bloat=ref에 anchor 추가) → 다시 `/pact:parallel`.
> 2. **경고 무시하고 이대로 진행**: risk 감수하고 fan-out 계속.

사용자가 2를 택하면 단계 3(fan-out)으로. 1을 택하면 정리 안내(worktree·payload는 이미 생성됨 → `pact run-cycle collect` 또는 수동 cleanup) 후 재분해로 유도.

> **참고 (P1-3)**: 워커 spawn 전 coordinator 검토 단계는 삭제됐다 — 그 검토 4항목(경로충돌·의존·TBD·스코프)은 이미 결정적 게이트(buildBatches/pathsOverlap·allDependenciesMet·parse·merge 게이트)가 커버하고, 유일하게 비중복이던 MODULE_OWNERSHIP 교차검토는 위 `ownership_warnings`로 결정적 승계됐다. 바로 spawn 한다.

## 단계 3: fan-out — batch0 워커 K개 백그라운드 spawn (Task tool ×K, **한 메시지**)

서브에이전트 nesting 불가 (ARCHITECTURE.md §14.2). 메인이 (단계 2.5에서 필터된) `task_prompts`의 각 항목으로 **한 메시지에서 동시** 호출:
- `subagent_type`: `worker`
- `description`: `<task_id>: <title>`
- `prompt`: `task_prompt` 그대로 (메인은 prompt.md/context.md를 read X)

Claude Code v2.1.198+ 는 서브에이전트를 **기본 백그라운드 실행**한다 — 메인이 블록되지 않고, 워커 완료 결과가 **개별적으로** 메인 대화에 도착하며 그때마다 메인이 행동할 수 있다(단계 4 이벤트 루프). 순차 호출은 직렬화하므로 **반드시 한 메시지에 K개 Task call**.

spawn 직후 사용자에게 상태 1줄:
> ▶ 실행 중: T-1, T-2, T-3 (슬롯 3/3). 대기 큐: T-4, T-5.

메인은 지금부터 **in-flight 목록**(현재 실행 중 task_id)과 **ready 큐**(`task_graph.ready` + 이후 dep 충족될 후보)를 릴레이용으로 들고 있는다. 이건 판단이 아니라 목록 부기다 — 투입 가부는 admit CLI 가 판정한다.

## 단계 4: 이벤트 루프 — 워커 완료가 도착할 때마다

워커 하나가 완료 결과를 보고할 때마다, 그 `<id>` 에 대해 아래 a→d 를 수행한다. (여러 완료가 근접해 도착하면 도착한 순서대로 각각 처리.)

### 4a. 단건 게이트 머지

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle collect-one <id> --commit-status
```

`collect-one` 은 그 task 하나만 게이트(report-gen → planMerge)를 거쳐 머지하고, 결과를 `.pact/merge-result.json`(사이클 SOT)에 누적(cycle_id)한다. `--commit-status` 는 머지된 task 의 `tasks/*.md` 상태(`status: done`)를 결정적으로 커밋(0토큰) — 다음 사이클 preflight(isClean) 통과용. **판단하지 말고 stdout 필드로 분기**:
- `merged: [<id>]` → 한국어 1줄 `✓ <id> merged`. → 4d.
- `already_merged: [<id>]` → 이미 머지됨(재진입) `✓ <id> (이미 머지됨)`. → 4d.
- `conflicted: {...}` (null 아님) → **4b (정지)**.
- `rejected: [{task_id, reason}]` 또는 `failures: [{task_id, status, blockers}]` → `⛔ <id> rejected: <reason>` → **4c (재투입/위임)**.
- `ok: false, stage: "merge-in-progress"` → **이미 앞선 충돌(4b)로 정지 중**이라 base 에 미해결 머지(MERGE_HEAD)가 남아 collect-one 이 게이트 이전에 거부된 것. 정상적 거부다(머지 성사 아님) — 머지 재시도·admit·resume 하지 말고 `⏸ <id> 보류 (머지 정지 중)` 1줄 보고 후 worktree 보존(`.pact/worktrees/<id>`). 충돌 해결 후 재개 대상.

### 4b. conflicted — **전체 정지** (자동해결 영구 금지, 철학 3·5번)

머지 충돌이면 base 에 미반영이라 판단 에러다. 메인이 절대 자동 해결하지 않는다:
- **남은 in-flight 워커는 계속 돌게 두되, 새 admit 을 중단**(더는 슬롯 채우지 않음).
- 즉시 사용자에게 한국어 보고 후 이 루프 종료:
> ⚠️ 머지 충돌 — `<id>`(파일 `<conflicted.files>`). 이후 task 투입을 멈췄습니다. 성공: `<지금까지 merged>`. 해결: `/pact:resolve-conflict` 또는 `git merge --abort`. worktree 보존: `.pact/worktrees/<id>`.

이후 남은 워커가 완료돼 4a 로 collect-one 을 호출하면, base 에 미해결 머지(MERGE_HEAD)가 남아 있어 게이트 이전에 `ok: false, stage: "merge-in-progress"` 로 **거부된다**(머지 성사 아님 — 4a 표의 해당 케이스로 보류 처리). 그 산출물은 worktree 에 보존되고 충돌 해결 후 재개한다. 새 task admit 도 하지 않는다.

### 4c. rejected/incomplete — resume-prompt 로 재투입 (직접 salvage 금지, 워커-완료 2.2)

워커가 turn/budget 소진으로 미완이거나 머지 게이트가 거부하면, **메인이 직접 끝내지 말 것** — 그게 salvage(솔로작업+ceremony), brewdy의 ~65% 시간을 먹은 패턴이다. 연속 프롬프트는 인라인으로 작문하지 말고, driver.mjs 와 동일 코어(`scripts/worker-completion/resume.js`)를 출력하는 결정적 CLI 단일소스에서 가져온다(drift 0, 회로차단기 영속):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact resume-prompt <id> --consume
```

stdout JSON `{continuationPrompt, resumes_remaining, escalate, resume_needed, incomplete_reason?}` 분기(**`escalate` 로만** 판정 — `resumes_remaining` 은 정보용):
- `escalate: true` → 재개 상한(`MAX_RESUME`=2) 도달(`--consume` 이 카운트를 못 늘리고 거부됨). **재투입 X**(슬롯은 비운 채) → 단계 4.5(메인 fallback) 시도 또는 사용자 위임(아래 안내). **위임/fallback 처리 후에도 이 슬롯은 비었으므로 4d(admit)로 흘러 다음 ready task 를 투입한다** — escalate 된 task 가 마지막 in-flight 이고 ready 큐가 남아 있어도 루프가 멈추지 않게 하는 재충전 경로다(4d 는 4a `merged` 뿐 아니라 이 경로에서도 도달). `--consume` 이 카운트를 영속 증가시키므로 헤드리스 드라이버와 **동일하게 2회 재투입** 예산(과거 인터랙티브 1회 재투입 off-by-one 해소).
- 아니면 `continuationPrompt` 문자열을 **그대로** worker 서브에이전트 prompt 로 **같은 슬롯에 fresh 재spawn**(`subagent_type: worker`, working_dir = 그 task 의 worktree = 부분작업 보존). 이 재spawn 워커도 완료되면 다시 4a 로 들어온다. → (재투입했으므로 4d 는 스킵 — 슬롯이 이 task 로 다시 찼다.)

escalate 로 위임할 때 사용자 안내:
> 🚨 `<id>` 재개 상한 도달 — 사람 위임. `/pact:takeover <id>`(보존된 worktree 직접 인계) 또는 `/pact:resume <id>`(fresh 재시도).

### 4d. 슬롯이 비었으니 다음 ready task 투입 (admit)

머지 성공(4a `merged`/`already_merged`)으로 슬롯 하나가 비었다. ready 후보(=`task_graph.ready` + 이제 dep 이 모두 merged 집합에 든 `task_graph.tasks` 항목) 중 하나를 골라:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/pact run-cycle admit <다음_id> --in-flight=<현재_실행중_id들> --owner-pid=$PPID --session=parallel
```

`--in-flight` 는 **지금 실행 중인 워커 id 들**(방금 완료한 id 제외). admit 은 그 순간의 CURRENT base(직전 머지 반영)에서 worktree 를 만들고, in-flight 들의 allowed_paths 와 pathsOverlap 을 재검사한다. **stdout 필드로 분기(판단 X)**:
- `ok: true, admitted: true` → `task_prompt`(단건) 를 그대로 worker 서브에이전트로 spawn. in-flight 목록에 추가, ready 큐에서 제거. `▶ <id> 투입 (슬롯 K/K)`.
- `ok: false, reason: "path_overlap", conflicts: [...]` → 에러 아님(exit 0). 그 task 를 **보류 큐**에 넣고(다음 완료 때 in-flight 가 줄면 재시도), **다른 ready 후보**를 같은 방식으로 시도.
- `ok: false, stage: ...` (hard fail) → errors[i].message 를 사용자에게 보고, 그 task 는 보류하고 다른 후보 시도.

ready 후보를 다 시도해도 지금 투입할 게 없으면(전부 path_overlap 보류 또는 dep 미충족) 슬롯을 비운 채 다음 완료를 기다린다.

### 4e. 루프 종료 조건

루프는 **in-flight 가 K 미만이고 실제 투입 후보(ready 큐 + dep 이 방금 충족된 task + path_overlap 보류분)가 남아 있으면 능동적으로 admit(4d)을 재개**한다 — 완료 이벤트뿐 아니라 escalate(4c)·path_overlap 보류(4d)로 슬롯이 빈 경우에도 스스로 다음 후보를 시도한다(수동 재충전, hang 방지).

**실제 투입 후보가 하나도 없고(전부 dep 미충족이거나 이미 소진) in-flight 0** 이면 루프 종료 → 단계 5.

보류 큐에 path_overlap 대기만 남고 in-flight 0 인 경우: in-flight 가 0 이면 admit 의 pathsOverlap 재검사에 비교할 대상이 없어 **후보 중 최소 1개는 반드시 admit 된다**. 그 task 완료가 다음 admit 을 트리거하므로, 보류 task 들이 **서로 겹치더라도** 라운드마다 한 개씩 순차 투입돼 결국 소진된다(진행 보장 — "서로 겹치지 않아서"가 아니라 "in-flight 0 → 겹칠 대상 없음 → 순차 admit").

> **배치 collect 재호출 금지 (이중 머지 방지)**: `collect-one` 이 완료마다 이미 머지·상태커밋·SOT 누적을 다 했다. 루프 종료 후 `pact run-cycle collect`(배치)를 다시 부르지 **않는다** — 이미 머지된 걸 재머지하려다 오류·이중집계가 난다. `merge-result.json` 은 collect-one 이 조립해 둔 완성 SOT 다.

## 단계 4.5: 메인 fallback (ADR-053) — resume 로 안 풀리는 머지 거부

4c 에서 `escalate: true` 이거나 resume 재투입이 반복 실패할 때, **reason 이 아래 4종이면** 메인이 사용자 승인 후 수동 처리하고 **그 task 의 단건 게이트를 재실행**(`pact run-cycle collect-one <id> --commit-status`) 가능(추측·자동수정 X). 재머지는 반드시 이 `collect-one <id>` 로 한다 — `pact merge <id>` 는 positional id 를 파싱하지 않아(오직 `--quiet`) **배치 전체를 재머지**하고 `merge-result.json`(사이클 SOT: `single_merge`/`cycle_id`/`failures`/`verification_summary`/`decisions_to_record`)을 통째 덮어써 collect-one 이 쌓은 누적을 파괴하므로 쓰지 않는다. 그 외 reason(`ownership 위반`·`verify fail`·`git diff에 allowed_paths 외 파일` 등)은 워커 spec drift/실결함이라 **메인이 임의 우회 X** → 사용자 결정.

1. **status.json 미작성** (`reason: "status.json missing"`) — worktree(`.pact/worktrees/<id>`) 보존. `git status`로 산출물 확인 → 있으면 메인이 status.json 작성(verify_results 는 실측 가능한 것만, 나머지 `skip`) 후 `collect-one <id>` 재실행, 없으면 `/pact:resume <id>` 안내. **report.md 는 수기 작성 X**(collect 시 report-gen 이 status.json 에서 결정 렌더).
2. **commit 미작성 + worktree 변경 존재** — worktree 안에서 메인이 직접 commit(`pact: salvage <id> (worker incomplete)`) 후 `collect-one <id>` 재실행.
3. **decisions schema 위반** — 메인이 schema 정합 형태로 정규화 후 status.json 덮어쓰기(위반 원본은 `.pact/runs/<id>/decisions.raw.json` 보존) 후 `collect-one <id>` 재실행.
4. **회로 차단기**: 같은 task 2회 fallback 실패 시 사용자 위임(`/pact:abort <id>` 안내).

## 단계 5: PROGRESS/DECISIONS 갱신 (통합)

`collect-one` 들이 이미 `.pact/merge-result.json`(사이클 deterministic SOT)에 merged·conflicted·rejected·failures·verification_summary·decisions_to_record를 다 누적해 뒀다. 갱신은 **그 파일 기준**으로 한다 — status.json 전량 재독·validate-status 재실행 X (collect-one 이 이미 소화함, TOK-2).

- **작은 사이클(머지 ≤ 2)**: 메인이 직접 `merge-result.json`만으로 PROGRESS.md 짧게 갱신 (Recently Done + Blocked만, ~5줄).
- **큰 사이클(머지 ≥ 3)**: Task tool로 **축소된** 통합 coordinator 소환:
  - `subagent_type: coordinator`
  - prompt:
```
통합 모드 (축소).
merge-result.json 만 read. status.json 전량 재독·validate-status 재실행 금지.
이번 사이클 종료 task: <task_ids>

PROGRESS.md 갱신: Recently Done(merged) · Blocked/Waiting(conflicted+failures+rejected, 사유 한 줄) · Verification Snapshot(verification_summary 그대로).
DECISIONS.md 에 decisions_to_record 누적 (사용자 승인 필요 건은 후보로 표시).
실패/블록 task 의 report.md 가 갱신에 필요하면 그 지목된 report.md 만 read (전량 X).
```

## 단계 5.5: bookkeeping 커밋 (다음 사이클 preflight 통과용)

`collect-one --commit-status` 는 `tasks/*.md` 상태 스탬프를 이미 커밋했다. 단계 5 가 갱신한 `PROGRESS.md`·`DECISIONS.md` 는 아직 tracked 미커밋 — 다음 `/pact:parallel` 의 prepare preflight(isClean)가 이걸로 막히므로 여기서 커밋한다:

```bash
git add PROGRESS.md DECISIONS.md && git commit -m "pact: cycle bookkeeping" || true
```

`DECISIONS.md` 의 승인대기 항목은 단계 5에서 이미 '후보'로 표시돼 이 커밋은 **기록 영속**일 뿐 결정 반영이 아니다(철학 5번 무위반). `|| true` 는 갱신 없어 커밋할 게 없을 때 무해 통과용. (`.pact/` 는 ignore 이므로 merge-result·runs 등은 커밋 대상이 아니다.)

## 단계 6: 결과 보고 (한국어)

성공: `✅ Cycle 완료. 머지 <N>개. 검증 lint/tc/test/build 결과.`

부분: `⚠️ Cycle 부분 완료. 성공 <N>: ✓ ids. 실패/거부 <M>: ⛔ id 사유. 충돌 <C>: ⚠️ id → /pact:resolve-conflict. worktree 보존: .pact/worktrees/<id>.`

worktree는 머지 성공한 것만 정리됨 — 실패·blocked·충돌은 `.pact/worktrees/<id>` 보존 (재개·디버깅).

## 단계 7: 새 세션 권장 안내 (필수, 한국어)

성공·부분 무관 cycle 끝나면 **반드시** 마지막에 출력 (생략 X):

> 💡 **다음 사이클은 새 세션에서 시작 권장** — 이 세션은 사이클 1회분 컨텍스트가 누적된 상태. 같은 세션에서 계속 돌리면 매 턴 cache_read 가 누적분만큼 부풀어 토큰 비용이 사이클마다 배수로 증가함 (실측: 57시간 한 세션 = 209M 토큰, 세션 분할 = 같은 작업 ~30M).
>
> 추천 흐름:
> 1. `/exit`
> 2. 같은 디렉토리에서 `claude` 재실행
> 3. `/pact:parallel` 재호출 — prepare 가 멱등 재개한다 (`already_prepared` — 진행 중 사이클을 어댑트, 미완이면 남은 task 를 파이프라인으로 이어감). 새 컨텍스트 0 에서 시작.
>
> 충돌·blocked 처리만 남았으면 이 세션에서 마무리 후 /exit 해도 됨.
> (`/pact:resume <task_id>` 는 **회로차단된 단일 task 재시도 전용** — 사이클 재개용이 아니다.)

charge 부담 적은 짧은 follow-up (예: "lint 결과 보여줘")이면 이 세션 유지 OK. **새 사이클 시작(=`/pact:parallel` 재호출)은 새 세션으로.**

## 단계 8: 구버전 폴백 (별도 플로우 불필요)

- **Claude Code < v2.1.198**: Task 호출이 포그라운드 블로킹이라, 한 메시지의 K개 Task call 이 **모두 함께 반환**된다. 그러면 위 이벤트 루프는 자연히 **배치 배리어로 강등**된다 — 반환된 K개를 순서대로 4a(collect-one)로 처리하고, 그 다음 4d(admit)로 다음 배치를 채운다. 지시문은 동일, 별도 분기 불필요(우아한 성능 저하).
- **"한 배치씩" 선호(--no-pipeline 상당)**: `--max=<batch 크기>` 로 prepare 하면 슬롯이 그 배치를 한 번에 채우고 전원 완료 후 다음으로 넘어가 배치 단위 동작과 동일해진다.

## 의문 시

- 동시 `/pact:parallel` 두 번: STAB-1 owner 게이트로 `cycle-busy` 거부, /pact:status·/pact:abort 안내.
- 워커 timeout: 대기 + 진행 보고 (완료 도착 시 4a 로).
- prepare 후 fan-out 전(단계 2.6)에서 abort 결정: `pact run-cycle collect` 호출하면 결정적으로 정리 (status.json 없는 워커는 rejected로 처리됨) — 이건 fan-out 전 유일한 배치 collect 허용 지점(머지된 게 없어 이중머지 위험 없음).
