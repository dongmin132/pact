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
| `--timeout=SEC` | 120 | 워커별 타임아웃 (abortController) |
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
- ⚠️ **여전히 미해결**: 워커 1개당 비용(자기 컨텍스트 다중 턴 재독, 실측 1.64M/워커).
  → 스펙·계약 정밀화(=SDD 강화)로 워커 턴 수를 줄여야 함. 별개 작업.
- ⚠️ **real 모드 미실행**: API는 검증(2026-06)했으나 실제 spawn은 아직 안 돌림(설치+로그인+토큰 필요).
- ⚠️ **가드 범위**: 현재 Write/Edit 경로 + 위험 Bash 패턴만. Bash가 동적으로 파일 쓰는 경우는
  worktree 격리 + collect의 `files_attempted_outside_scope` 사후검사에 의존. pre-tool-guard와 로직 공유 권장.
- ⚠️ **yolo 감지·crash 복구 루프**: 미구현(드라이버 크래시 시 재실행은 collect 멱등으로 안전하나 자동 재개는 미구현).
- ⚠️ **사람 개입·실시간 가시성**: 인터랙티브 대비 약함. 로그 + 종료코드 3 + escalation 목록으로 대체.
