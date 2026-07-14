# loop-until-dry Implementation Plan

> **상태: 구현 완료 (0.9.0 출시, ADR-057).** 체크박스 미갱신은 기록 원본 보존 목적 — 실제 구현은 `driver.mjs`(`runLoopTask`/`measureCount`)·`schemas/task.schema.json`(`loop_until`)·`run-cycle.js` 배선 완료.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pact drive`(헤드리스 드라이버)가 `loop_until`을 선언한 task에 대해, 측정된 진행이 있는 동안 fresh 워커를 자동 재투입해 한 워커가 질식하지 않고 done_criteria에 도달하게 한다.

**Architecture:** 드라이버 전용 신규 경로. `loop_until.count` 명령의 stdout 정수로 done(0)·progress(엄격 감소)를 결정적으로 판정한다. `runLoopTask`가 `[측정 → 워커(부분커밋) → 재측정]`을 반복하고, 정체·max_iterations·budget·측정불가에서 사람에게 위임한다. 일반 task는 기존 `attemptTask` 경로 무손상.

**Tech Stack:** Node.js (CJS for `bin/`, ESM for `experiments/headless-driver/driver.mjs`), `node:test`, JSON Schema draft-07. zero external dep (드라이버만 opt-in Agent SDK).

설계 출처: `docs/proposals/loop-until-dry.md`.

---

## File Structure

- `DECISIONS.md` — ADR-057 추가 (loop-until-dry 자동루프금지 화해 기록).
- `schemas/task.schema.json` — `loop_until` 선택 필드 정의.
- `bin/cmds/run-cycle.js` — prepare가 `loop_until`을 payload + task_prompts(fresh·rebuild 두 경로)로 전달.
- `experiments/headless-driver/driver.mjs` — `measureCount`, `runLoopTask`, dispatch 분기, mock `--loop` 시뮬레이션.
- `test/drive.test.js` — loop 시나리오 CLI 통합 테스트(done·stuck·max_iter·budget·회귀).
- `bin/cmds/drive.js` + `CHANGELOG.md` — HELP/변경 기록.

---

## Task 1: ADR-057 기록 + `loop_until` 스키마 필드

**Files:**
- Modify: `DECISIONS.md` (최상단 또는 최신 ADR 다음에 ADR-057 추가)
- Modify: `schemas/task.schema.json:79-86` (`retry_count` 다음에 `loop_until` 추가)
- Test: `test/task-schema.test.js` (loop_until 허용 확인)

- [ ] **Step 1: 실패 테스트 작성** — `test/task-schema.test.js`에 추가

```javascript
test('task.schema — loop_until 선택 필드 허용 (count + max_iterations)', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'task.schema.json'), 'utf8'));
  assert.ok(schema.properties.loop_until, 'loop_until 프로퍼티 정의되어야 함');
  assert.equal(schema.properties.loop_until.properties.count.type, 'string');
  assert.equal(schema.properties.loop_until.properties.max_iterations.type, 'integer');
  // 선택 필드여야 함 (required에 없음)
  assert.ok(!schema.required.includes('loop_until'));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/task-schema.test.js`
Expected: FAIL — `loop_until 프로퍼티 정의되어야 함`

- [ ] **Step 3: 스키마에 필드 추가** — `schemas/task.schema.json`의 `retry_count` 블록(라인 83-86) 다음, `}` 닫기 전에 삽입

```json
    "retry_count": {
      "type": "integer",
      "minimum": 0
    },
    "loop_until": {
      "type": "object",
      "required": ["count"],
      "properties": {
        "count": { "type": "string", "minLength": 1 },
        "max_iterations": { "type": "integer", "minimum": 1 }
      }
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/task-schema.test.js`
Expected: PASS

- [ ] **Step 5: ADR-057 작성** — `DECISIONS.md`에 추가 (기존 ADR 포맷: `## ADR-NNN — 제목` + 발견/결정/트레이드오프)

```markdown
## ADR-057 — loop-until-dry: 측정된 진행 중에만 자동 재투입

- **출처**: bulk cleanup 질식 반복 (CLEANUP-009/026/029), `docs/proposals/loop-until-dry.md`
- **관련**: ADR-012(워커 자기보고 불신), headless-driver-initiative

### 발견 / 배경

대량 기계적 정리 task에서 워커가 예산/턴 소진으로 절반만 하고 멈추는 질식이 반복됨. 진짜 제약은 컨텍스트 윈도우가 아니라 턴/예산 — 한 워커가 한 번에 N개 수정을 못 함. 현 드라이버는 incomplete를 즉시 escalate. 그러나 f5b2350(중간 커밋 강제)로 부분작업이 보존되므로 fresh 워커가 이어받으면 새 진행을 만든다.

### 결정

`loop_until.count`(stdout=남은 개수) 신호가 **엄격히 감소하는 동안에만** fresh 워커를 자동 재투입한다. 정체(`cur ≥ prev`)·`max_iterations`·budget 초과·측정 불가 시 즉시 사람에게 위임한다. done/progress는 워커 보고가 아니라 `measureCount`(결정적)로만 판정(ADR-012 정렬). 머지 게이트·verify는 우회하지 않음 — loop는 done_criteria 도달까지만.

"자동 루프 금지"(2회 실패 위임) 원칙은 *실패 시 무한 재시도* 금지를 뜻하며, 측정된 단조 진행은 그 예외다.

### 트레이드오프

- ✅ 질식 클래스 제거 — 각 iteration fresh 컨텍스트, 누구도 통째로 안 함
- ✅ 엄격 감소 = 무한루프 수학적 차단 (+ max_iterations + budget 백스톱)
- ✅ 드라이버 전용 — `/pact:parallel`(메인 LLM)은 무손상, 토큰 세금 0 유지
- ❌ opt-in 측정 신호 필요 — 카운트 안 나오는 task엔 적용 불가(의도된 범위)
- ❌ 측정 명령 오작성 시 오판 가능 — 측정 불가는 즉시 위임으로 방어

---
```

- [ ] **Step 6: 커밋**

```bash
git add schemas/task.schema.json test/task-schema.test.js DECISIONS.md
git commit -m "feat(schema): loop_until 필드 + ADR-057 (loop-until-dry 결정 기록)"
```

---

## Task 2: prepare가 `loop_until`을 task_prompts로 전달

`loop_until`은 task → payload → payload.json → task_prompts 두 emit 경로(fresh·rebuild)로 흘러야 드라이버가 `task.loop_until`로 읽는다.

**Files:**
- Modify: `bin/cmds/run-cycle.js:280` (payload 객체), `:293-302` (fresh emit), `:112-121` (rebuild emit)
- Test: `test/run-cycle.test.js` (기존 prepare fixture에 loop_until 전달 확인)

- [ ] **Step 1a: `writeTasks` 헬퍼가 `loop_until`을 내보내도록 확장** — `test/run-cycle.test.js`의 `writeTasks`(라인 47-65) `tdd` 줄(라인 59) 다음에

```javascript
    md.push(`tdd: ${t.tdd ?? false}`);
    if (t.loop_until) md.push(`loop_until: ${JSON.stringify(t.loop_until)}`);
```

- [ ] **Step 1b: 실패 테스트 작성** — `test/run-cycle.test.js`에 추가 (기존 `makeProject`/`writeTasks`/`runPact`/`cleanupProject` 헬퍼 사용)

```javascript
test('prepare — task의 loop_until을 task_prompts로 전달', () => {
  const dir = makeProject();
  writeTasks(dir, [{ id: 'LOOP-001', allowed_paths: ['src/**'], loop_until: { count: 'echo 0', max_iterations: 4 } }]);
  try {
    const r = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    const j = JSON.parse(r.stdout);
    const tp = (j.task_prompts || []).find(t => t.task_id === 'LOOP-001');
    assert.ok(tp, `LOOP-001 task_prompt 존재: ${r.stdout}`);
    assert.deepEqual(tp.loop_until, { count: 'echo 0', max_iterations: 4 });
  } finally {
    cleanupProject(dir);
  }
});
```

> ⚠️ 전제: `yaml-mini`가 `loop_until: {"count":"echo 0","max_iterations":4}`(인라인 JSON 객체)를 파싱해야 한다. **이 테스트를 먼저 돌려라** — 통과하면 OK. `loop_until`이 파서에서 누락되면(yaml-mini 인라인 객체 미지원), self-review의 대체 경로(rebuild 단위 테스트)로 전환한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/run-cycle.test.js`
Expected: FAIL — `tp.loop_until`이 undefined

- [ ] **Step 3: payload에 필드 추가** — `bin/cmds/run-cycle.js:284` `context_budget_tokens` 줄 다음에

```javascript
      context_budget_tokens: task.context_budget_tokens || 20000,
      loop_until: task.loop_until || null,
```

- [ ] **Step 4: fresh emit에 추가** — `bin/cmds/run-cycle.js:301` `working_dir: wt.working_dir,` 다음에

```javascript
      working_dir: wt.working_dir,
      loop_until: payload.loop_until || null,
```

- [ ] **Step 5: rebuild emit에 추가** — `bin/cmds/run-cycle.js:120` `working_dir: payload.working_dir,` 다음에

```javascript
      working_dir: payload.working_dir,
      loop_until: payload.loop_until || null,
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `node --test test/run-cycle.test.js`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add bin/cmds/run-cycle.js test/run-cycle.test.js
git commit -m "feat(prepare): loop_until을 payload+task_prompts(fresh·rebuild)로 전달"
```

---

## Task 3: 드라이버 loop 코어 (`measureCount` + `runLoopTask` + dispatch + mock)

드라이버에 loop 경로를 추가한다. mock 모드는 `--loop=ID:N`으로 시작 카운트를 주고, mock 워커가 iteration마다 `--loop-step`(기본 2)만큼 줄여 진행을 시뮬레이션한다. `--loop-stuck`은 줄지 않게 해 정체를 시연.

**Files:**
- Modify: `experiments/headless-driver/driver.mjs` (플래그 파싱, `loopState`, `measureCount`, `getTasksDemo`, `runWorkerMock`, `runLoopTask`, dispatch)
- Test: `test/drive.test.js` (CLI 통합 시나리오)

- [ ] **Step 1: 실패 시나리오 테스트 작성** — `test/drive.test.js`에 추가

```javascript
test('drive loop — 카운트 감소로 done', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:6', '--loop-step=2']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /DEMO-001.*\[done\]/);   // 6→4→2→0, 3 iteration
  assert.match(r.stdout, /오케스트레이터 토큰: 0/);
});

test('drive loop — 정체면 escalate(no-progress)', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:6', '--loop-stuck=DEMO-001']);
  assert.equal(r.status, 3, r.stdout);            // escalation → exit 3
  assert.match(r.stdout, /DEMO-001.*\[escalated\]/);
  assert.match(r.stdout, /정체|no-progress/);
});

test('drive loop — max_iterations 도달 escalate', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:100', '--loop-step=1', '--loop-max=3']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /max_iterations/);
});

test('drive loop — budget 소진 escalate', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:100', '--loop-step=1', '--cost=5', '--budget=8']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /budget|예산/);
});

test('drive — loop_until 없는 일반 task는 기존 경로(회귀)', () => {
  const r = runPact(['drive', '--max=1']);          // loop 플래그 없음
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /DEMO-001.*\[done\]/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/drive.test.js`
Expected: FAIL — loop 시나리오들이 `[done]`/`[escalated]`/정체 매칭 실패

- [ ] **Step 3: 플래그 파싱 + loopState 추가** — `driver.mjs`의 `--cost` 파싱(라인 68) 다음에

```javascript
const MOCK_COST = getNum('--cost', 0.9);
// loop-until-dry mock 시뮬레이션 (REAL 모드는 measureCount가 실제 명령 실행)
const getLoopMap = (n) => new Map((getStr(n, '') || '').split(',').filter(Boolean)
  .map((p) => { const [id, v] = p.split(':'); return [id, Math.max(0, Math.floor(Number(v) || 0))]; }));
const LOOP = getLoopMap('--loop');          // Map<task_id, 시작 카운트>
const LOOP_STEP = getNum('--loop-step', 2); // mock 워커가 iteration당 줄이는 양
const LOOP_MAX = getNum('--loop-max', 6);   // mock loop_until.max_iterations
const LOOP_STUCK = getSet('--loop-stuck');  // 줄지 않음 → 정체 시연
const loopState = new Map(LOOP);            // 가변 남은 카운트
```

- [ ] **Step 4: `measureCount` 추가** — `runWorkerReal` 정의(라인 153) 앞에

```javascript
// 진행 신호 측정 (결정적). MOCK: loopState 읽기 / REAL: loop_until.count 명령 실행 후 stdout 마지막 정수.
function measureCount(task) {
  if (!REAL) return loopState.has(task.task_id) ? loopState.get(task.task_id) : 0;
  try {
    const out = execSync(task.loop_until.count, { cwd: task.working_dir, encoding: 'utf8', shell: '/bin/bash' });
    const nums = String(out).match(/-?\d+/g);
    if (!nums) return null;                  // 정수 없음 → 측정 불가
    return Math.max(0, parseInt(nums[nums.length - 1], 10)); // 마지막 정수
  } catch { return null; }                   // 명령 에러 → 측정 불가
}
```

- [ ] **Step 5: demo task에 loop_until 부착 + mock 워커가 카운트 감소** — `getTasksDemo`(라인 107-119)에서 task 객체에 추가, `runWorkerMock`(라인 136)에서 감소 로직 추가

`getTasksDemo` 내 task 객체 리턴에 추가:
```javascript
      allowed_paths: ['**'],
      loop_until: LOOP.has(`DEMO-${String(i + 1).padStart(3, '0')}`)
        ? { count: 'mock', max_iterations: LOOP_MAX } : null,
```

`runWorkerMock` 함수 본문 맨 앞(`await new Promise...` 다음)에 추가:
```javascript
  // loop task mock: 진행 시뮬레이션 — stuck 아니면 LOOP_STEP 만큼 남은 카운트 감소
  if (task.loop_until && loopState.has(task.task_id) && !LOOP_STUCK.has(task.task_id)) {
    loopState.set(task.task_id, Math.max(0, loopState.get(task.task_id) - LOOP_STEP));
  }
```

- [ ] **Step 6: `runLoopTask` 추가** — `attemptTask` 정의(라인 208) 다음에

```javascript
// loop-until-dry: 측정된 진행 중에만 fresh 워커 재투입. 절대 throw 안 함(attemptTask 와 동일 계약).
async function runLoopTask(task) {
  const MAX = (task.loop_until && task.loop_until.max_iterations) || 6;
  let prev = measureCount(task);
  if (prev === null) return { task_id: task.task_id, status: 'escalated', reason: 'loop 측정 불가(초기)', salvageable: true, attempts: 0 };
  if (prev === 0)    return { task_id: task.task_id, status: 'done', via: REAL ? 'real' : 'mock', attempts: 0, usage: null, turns: 0 };
  let iter = 0, lastUsage = null;
  while (true) {
    if (ledger.spentUsd >= BUDGET) return { task_id: task.task_id, status: 'escalated', reason: `budget 소진 ($${ledger.spentUsd.toFixed(2)} ≥ $${BUDGET})`, salvageable: true, attempts: iter };
    let r;
    try { r = await runWorker(task, ++iter); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e), cost: 0, usage: null }; }
    ledger.spentUsd += (r.cost || 0);
    if (r.usage) lastUsage = r.usage;
    const cur = measureCount(task);
    if (cur === null)   return { task_id: task.task_id, status: 'escalated', reason: 'loop 측정 불가', salvageable: true, attempts: iter, usage: lastUsage };
    if (cur === 0)      return { task_id: task.task_id, status: 'done', via: r.via, attempts: iter, usage: lastUsage, turns: r.turns };
    if (cur >= prev)    return { task_id: task.task_id, status: 'escalated', reason: `정체(no-progress) — 남은 ${cur}`, salvageable: true, attempts: iter, usage: lastUsage };
    if (iter >= MAX)    return { task_id: task.task_id, status: 'escalated', reason: `max_iterations(${MAX}) — 남은 ${cur}`, salvageable: true, attempts: iter, usage: lastUsage };
    prev = cur;
  }
}
```

- [ ] **Step 7: dispatch 분기** — main 루프의 `Promise.allSettled(tasks.map(attemptTask))`(라인 277)을 교체

```javascript
    const settled = await Promise.allSettled(tasks.map((t) => t.loop_until ? runLoopTask(t) : attemptTask(t)));
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `node --test test/drive.test.js`
Expected: PASS (5개 신규 시나리오 + 기존 3개)

- [ ] **Step 9: 커밋**

```bash
git add experiments/headless-driver/driver.mjs test/drive.test.js
git commit -m "feat(drive): loop-until-dry — measureCount+runLoopTask+dispatch, mock --loop 시나리오"
```

---

## Task 4: HELP/문서 갱신 + 전체 회귀

**Files:**
- Modify: `experiments/headless-driver/driver.mjs` (상단 주석 플래그 표), `bin/cmds/drive.js` (HELP), `CHANGELOG.md`

- [ ] **Step 1: 드라이버 주석 플래그 표 갱신** — `driver.mjs` 상단 `--cost` 설명 줄 다음에

```javascript
//   --loop=ID:N       [MOCK] loop task 시작 카운트(콤마 다수) — loop-until-dry 시연
//   --loop-step=K     [MOCK] iteration당 감소량 (기본 2)
//   --loop-max=N      [MOCK] mock loop_until.max_iterations (기본 6)
//   --loop-stuck=ID   [MOCK] 줄지 않음 → 정체 escalate 시연
```

- [ ] **Step 2: `bin/cmds/drive.js` HELP 한 줄 추가** — `--budget` 설명 다음

```javascript
  '  --budget=USD    누적 비용 상한 — 넘으면 정지 (기본 10)',
  '  (loop task) loop_until.count 가 0 될 때까지 fresh 워커 재투입, 정체·cap·budget 시 위임',
```

- [ ] **Step 3: CHANGELOG 항목 추가** — `CHANGELOG.md` 최상단 미릴리스 섹션

```markdown
- feat(drive): loop-until-dry — `loop_until` 선언 task는 측정된 진행 중 fresh 워커 자동 재투입 (질식 방지, ADR-057)
```

- [ ] **Step 4: 전체 테스트 회귀**

Run: `node --test test/`
Expected: PASS (기존 282 + 신규 케이스, 0 실패)

- [ ] **Step 5: mock 데모 수동 확인**

Run: `node experiments/headless-driver/driver.mjs --max=1 --loop=DEMO-001:6 --loop-step=2`
Expected: stdout에 `DEMO-001 [done]`, `오케스트레이터 토큰: 0`

- [ ] **Step 6: 커밋**

```bash
git add experiments/headless-driver/driver.mjs bin/cmds/drive.js CHANGELOG.md
git commit -m "docs(drive): loop-until-dry HELP/주석/CHANGELOG"
```

---

## Self-Review 메모 (작성자 확인 완료)

- **Spec 커버리지**: 데이터모델(T1)·passthrough(T2)·measureCount+runLoopTask+dispatch+무한루프3중차단(T3)·테스트(T3 시나리오 ⓐ~ⓕ)·ADR-057(T1)·HELP/CHANGELOG(T4) — 스펙 전 항목 매핑됨.
- **measureCount REAL 모드**: 실제 명령 실행은 mock 시나리오로 unit 검증 불가 → `--real --pact` 풀사이클(P4 방식 수동)로 별도 확인 필요. mock 경로가 loop 로직 자체는 전부 커버.
- **Task 2 passthrough 테스트 의존성**: `loop_until`(객체)이 task yaml에서 파싱되려면 `yaml-mini`가 인라인 JSON 객체를 지원해야 함. Task 2 Step 1b를 먼저 돌려 확인. **미지원 시 대체 경로**: rebuild 경로를 단위 테스트 — 임시 `.pact/runs/LOOP-001/payload.json`(plain JSON, `loop_until` 포함) + `.pact/batch.json`(`task_ids:["LOOP-001"]`)를 만들고 prepare(already_prepared→`rebuildTaskPrompts`) 호출해 `task_prompts[].loop_until` 확인. yaml 파서를 거치지 않으므로 passthrough만 격리 검증. (코어 loop 기능 T3는 이 의존성과 무관 — mock으로 완전 검증됨.)
- **타입 일관성**: `loop_until.count`(string)·`max_iterations`(int) 스키마=드라이버 사용 일치. outcome 객체는 기존 main 루프(라인 281-288) `{task_id,status,reason,attempts,usage,turns,salvageable}` 형태와 일치(아이콘맵 done/escalated 처리됨).
- **알려진 한계**: REAL 모드 `loop_until.count`는 `/bin/bash`로 실행 — Windows 미지원(pact 전반 가정과 동일). 측정 불가(null)는 즉시 위임으로 안전 처리.
