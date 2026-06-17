# pact 헤드리스 드라이버 (PoC)

> ⚠️ **실험용. v1.0 코어 아님.** 인터랙티브 `/pact:parallel`의 "오케스트레이터 재독 세금"을
> 없애는 방향(standalone Agent SDK 드라이버)의 최소 검증.

## 무엇을 증명하나

오케스트레이터를 **"생각하는 LLM 대화" → "생각 안 하는 스크립트"**로 바꾸면
코디네이션 토큰이 **0**이 된다. 워커 토큰만 지불.

| | 인터랙티브 `/pact:parallel` | 이 드라이버 |
|---|---|---|
| 오케스트레이터 | 메인 LLM 대화 | JS 스크립트 |
| 워커 1개 복귀 시 | 메인이 자기 컨텍스트 재독 (실측 50K→526K) | `Promise` resolve (**0**) |
| 한 세션 누적 | ~190M (실측, brewdy) | 워커 합계만 |

근거: 같은 brewdy 세션에서 워커 복귀 직후 메인 재독이 50K→526K로 커지며 누적 190M.
(`session-report` + 트랜스크립트 직접 분해로 측정.)

## 성능 비교 — 세 가지 실행 방식 (2026-06-17 실측)

"같은 워커를 **누가 지휘하나**"의 차이. (예전에 'raw SDK'라 부르던 걸 여기선 **기준선(baseline)**으로 명명 — pact를 한 겹도 안 씌운 맨 SDK 동시 실행 = 병렬의 *이론상 천장*.)

| 방식 | 오케스트레이터 | 워커 3개(trivial) 벽시계 | 오케스트레이터 세금 |
|---|---|---|---|
| **기준선 (baseline)** | 없음 (맨 SDK query 동시) | **32초** | **0** |
| **pact drive** | 스크립트 (JS) | **60초** ($0.91) | **0 토큰** |
| **`/pact:parallel`** | LLM 대화 (인터랙티브) | 워커 동일 + 메인 턴 | **~190M 재독** (멀티사이클) |

기준선은 천장(pact 오버헤드 0). drive·parallel은 그 위에 pact를 얹은 것 — 차이는 **오직 오케스트레이터 한 축**.

### ① 동시성 자체는 진짜 빠른가? → YES (`measure-concurrency.mjs`)
도구 없는 순수 query를 같은 K개 직렬 vs 동시로:
- K=3: **2.67배** (throughput 2407 → 6678 tok/min)
- K=5: **3.62배** (→ 8719 tok/min, 효율 89%→72%)
- → **구독에서도 진짜 병렬.** soft 천장 ~9K tok/min (4~5개 넘으면 효율 급락). **rate-limit 직렬화 아님.**

### ② pact 래퍼는 얼마나 무나? → 60초 vs 32초 (`fixture-setup.mjs` + `drive --real --pact`)
28초 갭의 정체 (분해):
- worktree 생성 + 머지 = **0.8초** → 무시 가능, **범인 아님**
- 오케스트레이터(drive) = **0**
- 진짜 세금 = **워커 스캐폴딩 ~13턴/워커** (prompt+context read · status.json · report.md 10줄 · verify · commit · validate)
- → **1줄 파일에도 13턴.** 작은 task엔 93% 오버헤드, 76턴짜리 feature엔 ~17%로 희석.

### ③ 왜 `/pact:parallel`만 비싼가? → LLM 오케스트레이터의 재독
parallel = drive + **LLM 오케스트레이터**. 단일 사이클·새 세션이면 차이 작지만, **멀티 사이클·긴 세션이면 메인이 매 턴 누적 transcript를 재독 → 복리로 190M.** drive는 스크립트라 사이클 수와 무관하게 0 (flat).

→ **속도 바닥 = 가장 느린 단일 feature의 작업 턴 체인** (병렬은 겹쳐줄 뿐 단일 feature를 못 빠르게 함). **비용 본체 = parallel 오케스트레이터 재독** (구조적, parallel 안에선 제거 불가 → drive 또는 세션 분할).

재현:
```bash
node measure-concurrency.mjs --k=3                       # ① 기준선 동시성
node fixture-setup.mjs /tmp/fx && (cd /tmp/fx && pact drive --real --pact --max=3)  # ② pact 래퍼
```

## 실행

### 1) 무료 데모 (즉시) — MOCK 워커
```bash
node driver.mjs
node driver.mjs --max=2 --cycles=2
```
SDK 설치도, 토큰도 필요 없음. 루프·동시 spawn·원장을 눈으로 확인.

### 2) 실제 헤드리스 spawn — REAL 워커
```bash
npm i @anthropic-ai/claude-agent-sdk   # 이 디렉토리에서
# claude 로그인 되어 있어야 함 (claude --version 확인)
node driver.mjs --real                 # 데모 태스크를 tmp dir에서 실제 수행
```

### 3) 진짜 pact 프로젝트에서
```bash
# cwd = pact 관리 프로젝트 루트 (CLAUDE.md + tasks + git 있는 곳)
node /path/to/pact/experiments/headless-driver/driver.mjs --real --pact
```
`pact run-cycle prepare`로 태스크를 받고, 워커를 worktree에 격리 spawn, 끝나면 `collect`.

## 플래그
| 플래그 | 기본 | 뜻 |
|---|---|---|
| `--real` | off | 실제 Agent SDK로 spawn (없으면 MOCK) |
| `--pact` | off | 태스크를 pact CLI에서 (없으면 DEMO) + collect |
| `--max=N` | 3 | 사이클당 워커 수 |
| `--cycles=N` | 1 | 사이클 반복 |
| `--model=NAME` | sonnet | 실제 워커 모델 |
| `--timeout=SEC` | 1200 | 워커 hang 백스톱 (작업 안 자름 — 진짜 cap은 budget) |
| `--budget=USD` | 10 | 누적 비용 상한 — 넘으면 정지 |
| `--retries=N` | 1 | 태스크당 재시도 (→ 최대 2회 시도) |
| `--fail=ID,..` | — | (MOCK) 영구 실패 → escalate 시연 |
| `--flaky=ID,..` | — | (MOCK) attempt1만 실패 → 재시도 회복 시연 |
| `--deny=ID,..` | — | (MOCK) scope 밖 쓰기 → 가드 deny 시연 |
| `--cost=USD` | 0.9 | (MOCK) 워커당 비용 — 예산 차단 시연 |

## 에러 처리 (v2 하드닝) — "아무도 안 보는데 터지면?"

6가지 안전장치. **기계적 에러는 드라이버가 흡수, 판단 에러는 사람 위임.**

| # | 안전장치 | 메커니즘 | 시연 |
|---|---|---|---|
| 1 | 워커 격리 | `Promise.allSettled` — 1개 실패가 배치 안 죽임 | `--fail=DEMO-002` |
| 2 | scope 가드 | `canUseTool` deny (bypass 안 씀) | `--deny=DEMO-002` |
| 3 | 타임아웃 | `abortController` + setTimeout | `--timeout=5` |
| 4 | 예산 차단 | `maxBudgetUsd` + 누적 ledger | `--budget=2 --cost=1.2 --cycles=3` |
| 5 | 회로차단기 | 1회 재시도 후 escalate | `--fail=`(영구) / `--flaky=`(회복) |
| 6 | 에러 분기 | result `subtype` 처리 (throw 아님) | real 모드 |

종료코드: 정상 `0`, 위임/정지 발생 시 `3` (자동화 파이프라인 감지용).
머지 충돌은 자동해결 X → 정지 + `/pact:resolve-conflict` 위임 (pact 안전 원칙).

### 시연 커맨드
```bash
node driver.mjs                              # 정상
node driver.mjs --fail=DEMO-002             # 1개 영구실패 → 격리+escalate (나머지 생존)
node driver.mjs --flaky=DEMO-001            # 일시실패 → 재시도 회복
node driver.mjs --deny=DEMO-002             # scope 위반 → 가드 deny ⛔
node driver.mjs --cycles=3 --budget=2 --cost=1.2  # 예산 초과 → 정지
```

## 핵심 구조 (driver.mjs)
```js
for (let c = 1; c <= CYCLES; c++) {
  const tasks = getTasks();                          // 결정적 CLI/소스 — 토큰 0
  const results = await Promise.all(tasks.map(runWorker)); // ★ 워커만 토큰
  if (USE_PACT) execSync('pact run-cycle collect');  // 결정적 CLI — 토큰 0
}
// ledger.orchestratorTokens === 0  ← 불변식, 끝에서 단언
```

## 한계 / 다음 단계 (정직하게)
- ✅ **고침**: 오케스트레이터 재독 세금(190M) → 0. (v1)
- ✅ **고침**: 에러 격리·타임아웃·예산·재시도·scope 가드. (v2, `canUseTool`로 bypass 제거)
- ⚠️ **여전히 미해결**: 워커 1개당 비용(자기 컨텍스트 다중 턴 재독). + **스캐폴딩 ~13턴 고정**(위 성능 비교 ②).
  → 스펙·계약 정밀화(=SDD 강화) + context 슬라이스(C1, 적용됨)로 워커 턴 수를 줄여야 함. 별개 작업.
- ✅ **real 모드 실행 검증됨** (2026-06-17): `drive --real --pact --max=3` → 실제 Sonnet 워커 3개가 코드 작성→커밋→collect 머지까지 `merged=3` 성공.
- ✅ **Bash allowed_paths 가드 추가**: `pre-tool-guard.checkBashWrite` 단일소스로 **drive(worker-guard)·parallel(hook) 양쪽** 적용. 이전엔 Bash 리다이렉션이 allowed_paths 우회 백도어였음(CLEANUP-029).
- ⚠️ **yolo 감지·crash 복구 루프**: 미구현(드라이버 크래시 시 재실행은 collect 멱등으로 안전하나 자동 재개는 미구현).
- ⚠️ **사람 개입·실시간 가시성**: 인터랙티브 대비 약함. 로그 + 종료코드 3 + escalation 목록으로 대체.
