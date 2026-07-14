# Changelog

## 0.11.0 — 2026-07-14

> 안전선 하드닝 릴리스 — 외부 코드리뷰 P1 4건 + 가드 실효성 실측 검증에서 나온 2건 수리, red_observed soft 경고(ADR-058), rate-limit 적응 다운시프트.

### Fixed
- **락 stale takeover TOCTOU 봉쇄** (리뷰 P1-#1) — stale 판정 후 rename 전 간극에 타 프로세스가 갱신한 락을 무조건 밀어내던 구멍. `reclaimStale` 헬퍼(rename 후 재검증 + `linkSync` 비-clobber 복원)로 4개 락(cycle/drive/edit/claim) 단일소스화. POSIX 무-CAS 환경의 4자 극단 레이스는 TTL 바운드 구조적 잔여(net-neutral)로 명시.
- **already_prepared adopt 이중 spawn 차단** (리뷰 P1-#2) — owner 생존 검사가 cycle-lock 밖에서 일어나 두 세션이 동시에 같은 배치를 입양 가능하던 레이스 → 배타 구간으로 이동.
- **per-worker 예산 cap 누수 2겹 봉쇄** (리뷰 P1-#3) — ① `Math.max(0.5,…)` 바닥값이 declared 예산(<0.5)을 초과 + in-flight 예약 미차감으로 동시 K 워커 배정 cap 합이 budget 초과 → remaining clamp + `reservedUsd` 예약 회계. ② 1차 수리를 적대검증이 재-뚫음: 예약 해제(finally)와 지출 가산(상위 호출자) 사이 마이크로태스크 간극에 재투입 워커가 잔여 예산 과대평가 → 해제·가산을 한 동기 블록에서 원자화(`spentAccounted` 마커로 이중계상 방지).
- **Bash 쓰기 경계에 목적지 추출 확장** (리뷰 P1-#4) — `checkBashWrite`가 리다이렉션(`>`·`tee`·`touch`)만 봐서 `cp`/`mv`/`install`/`sed -i`/`dd`/`ln`으로 홈·형제 worktree에 탈출 가능(머지 diff 백스톱도 worktree 밖이라 무효) → 명령별 목적지 인자 추출로 차단.
- **canUseTool shadow 봉쇄** — `allowedTools`에 든 도구는 SDK가 `canUseTool`을 스킵(자동 승인)한다는 사실을 공식 permissions 문서 + SDK 0.3.178 라이브 프로브로 확정(deny 콜백 0회 호출, Write 실행됨). `pact drive --real`에서 worker-guard가 죽은 코드였던 구멍 → `allowedTools` 제거, canUseTool(worker-guard) 단일 관문화. worker-guard는 미지 도구 기본 allow라 도구 표면 변화 없음. 계약 테스트로 재도입 방지 고정.
- **abort/timeout 워커 비용 $0.00 미포착** — SDK는 abort 시 result(total_cost_usd) 없이 throw(0.3.178 실측) → budget cap이 중단 워커 실비용을 과소계상. assistant `message.usage`를 message.id dedup 누적 후 `scripts/lib/cost-estimate.js`(모델별 단가, cache_read 0.1×/creation 1.25×, 미지 모델은 opus 단가 보수 추정)로 추정, `costEstimated` 마커. 실측이 있으면 항상 실측 우선.

### Added
- **red_observed soft 경고 게이트 (ADR-058, 옵션 B)** — `tdd: true`인데 `red_observed !== true`면 `planMerge`가 `tdd_warnings`로 가시화(reject 아님, 머지 진행). `pact merge` 출력·`merge-result.json`·collect/collect-one emit 노출. red_observed는 순수 자기보고라 hard 게이트는 theater — 철학 #5(propose-only) 정합.
- **rate-limit 반응형 동시폭 다운시프트 (IMP-5 최소형)** — `pact drive`가 `rate_limit_event`를 관측하면 유효 동시폭을 일시 축소 후 점진 복원. soft 천장(~9K tok/min)에서 효율 급락하던 K=5 병렬의 낭비 완화.

### Docs
- stale 문서 3건 정리 — loop-until-dry 제안/플랜 상태값(구현완료·ADR-057), reviewer-task의 존재하지 않는 TODOS.md 참조(→ tasks/*.md blocked/failed 이월분), token-optimization C-2(maxTurns cap) 폐기 표기(f5b2350 방향과 상충).

## 0.10.0 — 2026-07-13

> 슬로우니스 종합 로드맵 (stability + architecture) — `pact drive` 파이프라인화, 레버 배선, 멀티세션 안전성, 레이어 정리. `--real` 실토큰 e2e 검증 완료(단일 워커 스모크 + `--real --pact` 풀사이클 3워커 — K-슬롯 풀·admit·collect-one 머지·오케스트레이터 0토큰 실증).

### Added
- **K-슬롯 파이프라인 드라이버** (`scripts/headless-driver/`) — `pact drive --pact`가 사이클-배리어(배치마다 전원 종료 대기) 대신 **K-슬롯 워커 풀**(`pool.mjs` 순수 스케줄러)로 동작. 한 슬롯이 비면 다음 ready task를 즉시 admit → cycle time을 Σmax(batch)에서 ≈total/K로 축소. `--no-pipeline`으로 레거시 배리어 폴백. ready 큐는 LPT(가장 큰 task 우선) 정렬.
- **`pact run-cycle` 파이프라인 서브커맨드** — `prepare --graph`(전체 DAG emit) + `admit <task_id> --in-flight=…`(경로충돌 검사 후 온디맨드 슬롯 배정) + `collect-one <task_id>`(워커 완료 즉시 단건 머지, 게이트 경유).
- **`pact resume-prompt <task_id>`** — fresh-resume 연속 프롬프트의 단일 결정적 소스. `--consume`로 resume 카운트를 `.pact/runs/<id>/resume.json`에 **영속**(파일 기반 회로차단기 — LLM 기억 비의존). 드라이버(`resume.js` 코어 공유)와 인터랙티브 예산 정합.
- **`pact report-gen <task_id>|--all`** — status.json → report.md 결정적 렌더(0토큰). status.json에 `summary` 자유 서술 필드 추가 → 워커 종료 ceremony(report.md 수기 10줄)를 제거하고 결정적 렌더로 대체.
- **슬로우니스 레버 propose-only 배선** — `run-cycle prepare` emit이 size/scope/ownership/bundle 경고를 `context_warnings`에 **fold**(prose 지시 대신 JSON — LLM이 못 건너뜀, 0 추가턴).
- **멀티세션 이중 spawn 차단** — `run-cycle prepare --owner-pid=N`이 장수 pid를 `current_batch.json`에 스탬프, adopt 분기에서 살아있는 타 세션 소유 시 spawn 전 거부. `pact drive`는 `.pact/drive-owner.json` belt 락(`acquireDriveLock`)으로 이중 드라이버 exit 4.
- **재발버그 계약 테스트** (TST-1) — `runWorkerReal`의 SDK query를 주입식으로 만들고 스크립트된 가짜 async-generator로 zombie·spent_usd 0·SIGINT 고착 3종을 고정. 훅 스모크 백필.

### Changed
- **인터랙티브 `/pact:parallel` 이벤트 루프 슬롯 파이프라인화** — 사이클-배리어("모든 워커 종료 후 배치 collect")를 폐기하고, 워커를 백그라운드 spawn 후 **완료마다 `collect-one`(단건 게이트 머지) → 슬롯이 비면 `admit`(다음 ready task 온디맨드 투입)** 하는 이벤트 루프로 재작성. `prepare --graph` 로 DAG 확보. wall-time 이 헤드리스 `pact drive` 와 대등하면서 사람이 루프 안에서 매 완료·충돌·escalation 을 관찰·개입(신뢰성). "판단은 CLI, 릴레이는 LLM" 명문화. CC <v2.1.198 은 동일 지시가 배리어로 우아하게 강등. **실워커 dogfood e2e 완주**(3 task + 재투입 3회 + admit 파이프라이닝 + 게이트 거부/회복 + coordinator/bookkeeping — 거짓 머지 0).
- **dogfood 발견 수리 4건** — merge-result 사이클 내 stale rejected 화해(머지 성공 task가 Blocked 로 오기록되던 SOT 오염, DOG-1) · 워커 status.json 필수 필드 skeleton 예시 + 스키마 drift 방지 테스트(실워커 2/3 이 verify_results/clean_for_merge/files_changed 형태 실수, DOG-2) · resume 연속 프롬프트에 머지 거부 사유 주입(재투입 워커가 뭘 고칠지 즉시 인지 — 드라이버 공용 코어, DOG-3) · parallel.md 슬롯 회계 보강(재투입 대기 포함 K 초과 방지, DOG-4).
- **헤드리스 드라이버 승격** — `experiments/headless-driver/` → `scripts/headless-driver/`(production). 순수 실험물(`measure-concurrency`·`trace-worker`·`fixture-setup`)만 `experiments/`에 잔류.
- **레이어 정리** — `planMerge`(→`scripts/merge-coordinator.js`)·`collectLongDocs`(→`scripts/context-guard.js`)를 코어로 co-locate. `bin/cmds/*.js`는 `../../scripts`만 import하도록 `test/layer-lint.test.js`가 정적 강제(형제 bin/cmds import 차단).
- **pre-spawn coordinator 검토 제거** — MODULE_OWNERSHIP 교차검토를 결정적 게이트로 승계. `coordinator_review_needed`는 deprecated(항상 false).
- **워커 종료 메시지 구조화** — 종료 요약을 1~2줄 구조화 페이로드로 규약화 + `context_refs` 재나열 제거 → 메인 컨텍스트 누적 차단.
- **worker Bash 경계 분류** — 형제 worktree·본체 트리 쓰기는 deny, 자기 `.pact/runs`·`/dev`·tmp는 allow. heredoc-aware 스캔.

### Fixed
- **락 획득 TOCTOU** (STAB-2) — `writeFileExclusive`(완성 tmp → linkSync 배타 공개)로 lock/cycle/edit-lock 획득 교체. stale은 rename 후 재공개, 단일 승자 수렴.
- **미커밋 작업물 데이터 손실** (STAB-3) — `reconcileWorktree`에 dirty 게이트 → force-remove 차단.
- **yaml-mini 주석 제거 오류** (STAB-8) — quote/flow 인지형으로 교체(따옴표·flow 안 `#` 값 보존).
- **손상 ownership fail-open** (STAB-9) — `countOwnershipParseErrors` 진단 + 비차단 경고 표면화.
- **boot_epoch 락 자가치유** (STAB-5) — 재부팅 후 pid 재사용 영구락을 boot_epoch 양자화로 stale 판정 + 24h TTL 백스톱, 회수 사유 표면화.
- **검수/후속 수리** — RC-1(인터랙티브 resume 예산 off-by-one), WC-2(standalone `pact merge`가 planMerge 전 report-gen 렌더 → report 미작성 워커 전량 reject 회귀 해소), LG-1(boot_epoch 회수 전 isAlive 우선 — 살아있는 락 보존), ORCH-1/CI-1(collect-one이 cycle_id 경계에서 merge-result fresh 시작 + admit이 사이클 중간 재생성 시 진행 중 cycle_id 재사용), LG-2(here-string `<<<`를 heredoc 오프너로 오탐하던 Bash 경계 fail-open), ORCH-2·CI-2(`pact drive`·`run-cycle` help 문구 실제값 정합).

### 감사 2라운드 (전체 플러그인 재감사 후 확정 20건 수리)
- **드라이버 거짓 성공 제거** — 워커 done이어도 머지 게이트에서 rejected/conflicted면 완료로 계상하지 않고 ⛔ 별도 표기 + exit 3 (DRV-2, 레거시 경로 대칭). `already_prepared` 재개도 `--graph`를 재emit해 미-admit DAG 누락 차단 + 최종보고 직전 잔여 pending 스캔(DRV-1).
- **예산 안전장치 실효화** — per-worker `maxBudgetUsd`를 동시 in-flight 수로 분할 — 동시 K 워커의 K×BUDGET 폭주 차단, 마지막 워커는 잔여 전액(DRV-3).
- **관측 복구** — `pact status --watch`의 done/escalation 카운터가 종료 전까지 0 고착이던 것을 라이브 카운터로(DX-2). escalate 워커의 status.json을 드라이버 권위 데이터로 합성(자기보고 보존)해 metrics "비용0/failed" 오집계 수리(IMP-2).
- **effective_parallelism 실측** — 파이프라인 dispatch/settle 타이밍을 `.pact/driver-events.jsonl`로 영속, `pact metrics`가 유효 병렬폭·actual_width를 measured로 산출(이벤트 부재 시 기존 출력 불변)(IMP-1).
- **인터랙티브 재개 체인 복구** — parallel.md의 허구 재개 안내(`/pact:resume`의 state/batch 픽업)를 `/pact:parallel` 멱등 재개로 교정(CMD-1), collect `--commit-status` 대칭화 + 단계 7.5 bookkeeping 커밋으로 다음 batch preflight 통과(CMD-2), report.md 수기 지시 잔재 제거(AP-1/AP-3).
- **`pact next` 크래시 수리** — `current_batch.json` 1차 read + `batch.json` 폴백의 실제 포맷 파싱(CLI-NEXT-1/BATCHFILE-2), multi-session 게이트 파일명 통일(CMD-3).
- **codex 어댑터 결정적 캡처** — stdout 정규식 스크레이핑 → `--output-last-message` 파일 캡처(실패 시 폴백)(XREV-CODEX-3).
- **context_budget_tokens 활성화** — 번들 총량 추정이 예산 초과 시 `over_budget` 경고(anchor 우회 커버, propose-only)(IMP-3).
- 문서: drive `--help` 슬롯 의미 정정+`--no-pipeline` 노출(DX-5), escalation에 `/pact:takeover` 병기(DX-3), prepare 실패를 actionable fix로 노출(DX-1), `worker_concurrency` 죽은 노브 제거(DX-4), MODULE_OWNERSHIP 가드 주체 정정(AP-6).

## 0.9.0 — 2026-06-18

### Added
- **`/pact:wrap` — drive 후 1턴 LLM 문서 갱신 스킬** (`commands/wrap.md`) + **`merge-result.json` = 사이클 deterministic SOT 강화** (`bin/cmds/run-cycle.js`가 `decisions_to_record`·`verification_summary`·`failures`·`cleanup`까지 persist). `pact drive`(0토큰 grind)는 머지·status·report·merge-result 까지 결정적으로 남기지만 PROGRESS/DECISIONS 서사 갱신은 LLM 판단이라 안 했음 → `/pact:wrap`이 merge-result.json만 읽어 PROGRESS.md(Recently Done/Blocked/Verification) + DECISIONS.md(decisions 후보, propose-only) 갱신. parallel 단계7 coordinator와 동일 포맷 → **drive·parallel 둘 다 기록(#4) 유지, 차이는 "parallel이 LLM으로 더 보느냐"뿐.** 테스트(merge-result SOT 필드 검증).
- **`pact drive --verbose`/`-v` — 내부 동작 실시간 로그** (`experiments/headless-driver/driver.mjs`): 워커 도구 호출(`[task_id] 🔧 Read/Edit/Bash`) + prepare/spawn/collect 단계 스트리밍. 토큰 0(콘솔만). 헤드리스 grind 내부 가시화.
- **status 대시보드 색 + `--watch` 깜빡임 제거** (`bin/cmds/status.js`): phase 신호등 색 · 비용 바 임계색(70%/90%) · escalation 빨강 강조 · 라벨 dim (TTY일 때만, 파이프는 평문). `--watch`는 전체 clear 대신 커서 제자리 덮어쓰기(`\x1b[H`+줄별 `\x1b[K`+`\x1b[J`) + 커서 숨김 → 깜빡임 없는 라이브 갱신.
- feat(drive): loop-until-dry — `loop_until` 선언 task는 측정된 진행 중 fresh 워커 자동 재투입 (질식 방지, ADR-057)
- **`pact status` 에 헤드리스 드라이버 라이브 대시보드 (P5 reader side)** — `bin/cmds/status.js`가 `.pact/driver-state.json`을 읽어 `pact drive` 진행을 **hero 대시보드**로 표시: phase 신호등(🟢 spawning / 🟡 collecting / ✅ done / 🔴 aborted / 💀 죽음), `진행/활성/비용/갱신` 정렬 블록, **비용 진행률 바**(`$3.91 / $5 ▕█████████████░░░▏ 78%` — driver-state 에 `budget` 분모 추가), **상대시간**("3초 전"). `--summary`엔 `drive:<phase> spent:$X`. **`pact status --watch`(2초 폴링) = 둘째 터미널 라이브 모니터** — `pact drive`는 오케스트레이터가 스크립트라 채팅 narration이 없는 관측 공백을 메움. 비종료 phase인데 드라이버 pid 죽으면 stale 경고(`lock.js isAlive` 재사용). 테스트 4 (TDD).

### Fixed
- **context.md 번들 bloat — anchor 없는 ref 가 파일 전체를 포함 (워커 토큰 세금 폭증)** — `scripts/context-bundle.js`: `context_refs` 가 `tasks/cleanup.md`처럼 anchor 없으면 `extractAnchoredSection`이 **파일 전체를 반환**해(실측 CLEANUP-029 context.md = 147KB / 2458줄), SDK 워커가 매 턴 재독 → 7.64M 토큰/$3.91/76턴의 주범. 이제 anchor 없으면 **task_id 를 암시적 anchor 로 자동 슬라이스**(`## CLEANUP-029` 섹션 50줄만 = **98.2% 절감**). task_id heading 이 없는 계약 shard 는 통째 fallback(통독 의도 보호) + 200줄↑ bloat 경고. 테스트 4 (TDD).
- **Bash 리다이렉션이 allowed_paths 우회 백도어 (parallel·drive 둘 다)** — Write/Edit 는 allowed_paths 로 막지만 Bash `>`/`cat >`/`tee`/`touch` 는 안 막혀서, 워커가 `cat > docs/ui/cleanup-011-review.md` 로 **범위 밖 파일을 써서** merge 게이트가 029 통째 reject(16분·$3.91 낭비). **단일 소스 `hooks/pre-tool-guard.js`의 `checkBashWrite`**로 구현 → drive(`scripts/lib/worker-guard.js` canUseTool)와 **parallel(hook PreToolUse)이 같은 규칙**. 이전엔 hook 이 Bash 를 아예 미검사(`tool_name` 화이트리스트에서 제외)라 **parallel 은 무방비였음** — 이제 워커 worktree 컨텍스트의 Bash 쓰기 타겟이 워크트리 *안* + allowed_paths 밖이면 deny. 밖(.pact/runs 보고영역·/dev/null)은 미검사 → status.json 안 깨짐. 셸 파서는 첫 줄만 + 따옴표/heredoc 본문(`=>`·`>`) 오탐 방지. 휴리스틱(완벽X) — 최종 백스톱은 merge 게이트 git-diff. 테스트 19 (worker-guard 10 + hook 9, 통합테스트로 parallel deny 실증, TDD).
- **worker.md scope/검수 honesty 강화** — `agents/worker.md` "절대 안 하는 것"에 명시: (1) **Bash 로 allowed_paths 우회 금지**(>·cat·tee·cp·mv·touch), `.pact/runs/<id>/` 보고만 예외, (2) **리뷰·사인오프·디자인 검수 문서 생성 금지**(인간 게이트 — `docs/**review*` 등), (3) **verify(typecheck/test/build) fail 인데 `done` 금지** → `blocked`. 029 가 거짓 done + 범위밖 검수문서로 거부된 패턴 차단.
- **`pact drive --help`/driver 주석의 `--timeout` 기본값 drift** — "기본 120"으로 남아있던 표기를 실제값 **1200(hang 백스톱, 작업 안 자름)**으로 정정. 직전 120→1200 변경의 잔여 문서.
- **worker `maxTurns` cap 제거** — `agents/worker.md`의 `maxTurns: 60` 삭제. dense task(컴포넌트 3파일 토큰 매핑 등)에서 워커가 60턴에 잘려 부분완료+미커밋으로 작업 통째 유실되던 패턴(brewdy 028/029, `pact drive --real` 시범에서 재현). 인터랙티브는 사람이 backstop이라 턴 cap을 떼고 자연 완료까지 둔다(제거는 truncation을 완화만 하지 악화 불가). 무인 `pact drive`의 폭주 차단은 budget으로 — 별도. "워크플로우 서브에이전트처럼 끝까지 두고 폭주는 다른 축으로" 방향.
- **worker 중간 커밋 강제** — 긴 작업을 논리 단위마다 commit하도록 `agents/worker.md`에 명시. 끊겨도 진행분이 worktree 브랜치에 보존돼 재개·검토 가능. 못 끝낼 것 같으면 부분 commit + `status=blocked`.
- **`pact drive` 턴/시간 cap 완화 + 미완 작업 보존** — `experiments/headless-driver/driver.mjs`: `maxTurns 60→200`(backstop), `--timeout` 기본 `120→1200s`(hang-backstop), **budget을 진짜 cap으로**. (1) 타임아웃 발화 시 `q.close()`로 SDK 워커 실제 종료(abort만으론 zombie 잔존하던 Bug1), (2) 모든 메시지에서 usage/cost 갱신 → 끊겨도 partial 비용 캡처(spent_usd 0 Bug3), (3) budget/시간 소진 워커는 재시도 말고 즉시 escalation + worktree 보존(작업 유실 방지), (4) SIGINT/SIGTERM에 `driver-state.json` finalize(spawning 고착 Bug2). `pact drive --real` 029 시범에서 드러난 버그 3개 대응. 실제 `--real` 재검증은 사용자 환경 필요.

## v0.8.1 — 2026-06-01

`decisions` 배열 schema 안내 누락 fix — brewdy cycle 3·4 worker 사고 5건 누적 (GitHub issue #3).

### 동기

v0.8.0 ADR-026이 `status.json` required 필드를 완화했으나 `decisions` 배열의 **item 형식 안내 자체**가 worker prompt에 없었음. brewdy cycle 3 CLEANUP-003~006 (4건) + cycle 4 INFRA-111 (1건) 워커가 동일하게 `string[]` 패턴으로 작성 → merge gate reject → 메인 수동 정규화 반복.

근본 원인: pact가 worker에게 형식 알려주는 안내 부재 + reject 메시지의 schema path 미노출.

### 변경

**`prompts/worker-system.md` (A — P0)**
- `decisions` 형식 yaml 예시 1블록 추가 (OK/금지 대조). 5건 패턴 명시 차단.

**`scripts/lib/validate-mini.js` (B — P1)**
- `decisions` item `must be object` 메시지를 `must be object {topic, choice, rationale} — got <type>`로 풍부화. worker self-correct 가능.
- 필드별 메시지에도 받은 타입 명시 (`must have 'topic' (string)`, `must be string — got number`).

**`bin/cmds/merge.js` (B — P1)**
- schema 위반 reject reason에 `instancePath` 포함 (`/decisions/0 must be object {...}`). 어디 어떤 필드인지 즉시 식별.

**`bin/cmds/validate-status.js` + `bin/pact` 라우팅 (C — P2)**
- 새 명령 `pact validate-status <path/to/status.json>` 노출. worker가 status.json 작성 직후 self-validate.
- 기존 `scripts/validate-status.js` 로직을 CLI 명령으로 wrap. exit code 0/1/2/3.

**`agents/worker.md`**
- 종료 의무에 §5 추가 — self-validate 호출 강력 권장. exit 3이면 즉시 수정 후 종료.

### 테스트

- `test/validate-status.test.js` — issue #3 케이스 3종 추가 (string[] 메시지 + path).
- `test/pact-cli.test.js` — `pact validate-status` 4종 (ok/위반/missing/usage).
- 전체 통과.

### 영향

- brewdy 메인 fallback 빈도 6번 cycle 합산 ~0회 예상 (A만으로 5건 패턴 차단).
- 디버깅 시간 단축 (B — schema path 노출).
- 메인 fallback 호출 자체 제거 가능 (C — worker self-validate).

### Migration

기존 worker는 호환 (validate-status 호출은 강력 권장이지 강제 X). 신규 cycle부터 prompt 예시 + self-validate 자연스러운 흐름.

---

## v0.8.0 — 2026-06-01

워커/cycle 안정성 — brewdy cycle 3 회고 upstream fix (GitHub issue #1, 5건 묶음).

### 동기

brewdy(RN+Supabase 모노레포)에서 pact v0.7.0 cycle 2~3 운영 중 메인 워크플로우가 매 cycle 수동 보정으로 우회하던 5가지 결함. 누적 ROI 가장 큰 항목 (rejected 102건 중 94건 원인)부터 묶음 해결.

### 변경

**`bin/cmds/run-cycle.js` (ADR-022 = brewdy ADR-048)**
- `doCollect`에 `setTaskStatus(id, 'done')` 추가 — 머지 후 task source frontmatter sync.
- `executeMerge`는 이미 동일 로직 (merge.js:163-169) 수행 중이었으나 `run-cycle collect` 경로만 누락.
- `merge-result.json` + emit 페이로드에 `status_updates: [{task_id, ok, action, file, error}]` 포함.

**`bin/cmds/merge.js` (ADR-023 = brewdy ADR-049)**
- `planMerge`에 `report.md` 게이트 — 파일 존재 + 비공백 10줄 이상 강제.
- 위반 시 `rejected.reason: "report.md missing"` 또는 `"too short (N non-blank lines, min 10)"`.
- self-report 아닌 파일 시스템 사실로 검증 — ADR-012 정신 유지.

**`scripts/spawn-worker.js` (ADR-025 = brewdy ADR-055)**
- `validatePayload`에 `yolo_mode + forbidden_paths` 검증:
  - `yolo_mode === true`인데 `forbidden_paths` 누락 → reject
  - `forbidden_paths: []` 빈 배열 → reject (deny-all 의도면 `["**/*"]` 명시 강제)
  - `forbidden_paths` 비배열 → reject
- `prompts/worker-system.md` forbidden 섹션에 "비어있어도 allowed_paths 외 자동 금지 (deny-all)" 명시.

**`scripts/lib/validate-mini.js` + `schemas/worker-status.schema.json` (ADR-026 = brewdy ADR-056)**
- `validateStatus` required 필드 7개 → 2개 (`task_id`, `status`).
- 누락 필드는 merge gate가 안전 default (`|| []`, `|| {}`) 또는 명시 reject로 분기.
- `schema_version` 도입 X — ARCHITECTURE.md L371 룰 ("schema_version 안 쓴다") 유지.
- 구워커 산출물(cycle 1.5 시점 등) 호환.

**`commands/parallel.md` + `agents/coordinator.md` (ADR-024 = brewdy ADR-053)**
- 단계 5.5 신설 — "워커 실패 시 메인 fallback (4종)":
  1. status.json 미작성 → worktree 사실 기반 메인 작성
  2. commit 누락 + worktree 변경 → salvage commit
  3. report.md 미작성 → 워커 의도 추정 보고서
  4. decisions schema 위반 → 정규화 + 원본 `decisions.raw.json` 보존
- 4종 외 사유는 메인 임의 우회 X — 사용자 결정 필요. 2회 fallback 실패 시 사용자 위임.
- `agents/coordinator.md` 분류 테이블에 fallback 매핑 짧게 명시.

**`agents/worker.md`**
- 종료 의무 §4에 `report.md` 비공백 10줄 강제 명시 + "절대 안 하는 것"에 추가.

### 테스트

- `test/validate-status.test.js` — ADR-056 케이스 7종 추가 (required 완화, tdd_evidence 누락 허용 등)
- `test/spawn-worker.test.js` — ADR-055 케이스 6종 추가 (yolo + forbidden 조합)
- `test/run-cycle.test.js` — ADR-048/049 통합 검증 (E2E에 status_updates assert + report.md gate 2 case)
- 전체 통과

### 영향

- **메인 수동 sync 절감** — cycle당 ~30분 (ADR-022)
- **rejected alert fatigue 해소** — 머지된 task 재평가 노이즈 제거 (ADR-022) + 구워커 산출물 호환 (ADR-026)
- **회고 입력 품질 향상** — report.md 작성률 ~42% → 100% 강제 (ADR-023)
- **spec drift 차단** — yolo 모드 4건 같은 결함 spawn 단계 reject (ADR-025)
- **메인 워크플로우 일관성** — fallback 4종 외 임의 우회 X (ADR-024)
- **GitHub issue #1 close** — brewdy 측 ADR-048/049/053/055/056 5건 upstream 해결

### Migration

- 기존 cycle 산출물 호환 — 구버전 워커가 작성한 `status.json`(필드 누락 다수)도 검증 통과.
- 단 `report.md` 없는 머지된 task는 v0.8.0부터 reject — brewdy 측 fallback (ADR-024 #3) 활용 또는 메인 수동 작성.

---

## v0.7.1 — 2026-05-26

토큰 소모 절감 — shard 우선 SOT 룰 + split-docs domain inference 개선.

### 동기

brewdy 운영 분석에서 두 가지 누수 확인:
1. `/pact:reflect` 가 `contracts/db/chat.md` shard 가 있는데도 `DB_CONTRACT.md` 같은 legacy root 를 가리킴 → 사용자가 root 만 고치고 shard 와 drift 벌어짐.
2. `pact split-docs` 가 Supabase Edge Function 경로(`/functions/v1/...`) 같은 framework prefix 를 도메인으로 잘못 잡아 모든 endpoint 가 `functions.md` 한 파일로 뭉침. 진짜 도메인 분할 효과 0.

이번 패치는 그 두 누수를 직접 봉합.

### 변경

**`commands/reflect.md`**
- drift 감지 grep 패턴 확장 — 기존 `contracts/`, `tasks/`, `PROGRESS.md` 만에서 `docs/.*\.md`, `ARCHITECTURE.md`, `CLAUDE.md` 추가
- planner 호출 prompt 에 **SOT 우선순위 룰** 추가:
  1. 1순위: `contracts/<api|db|modules>/<domain>.md` shard (있으면 무조건)
  2. 2순위: `ARCHITECTURE.md`, `CLAUDE.md`, `docs/*.md` (shard 없는 root SOT)
  3. ❌ 금지: `API_CONTRACT.md` / `DB_CONTRACT.md` / `MODULE_OWNERSHIP.md` (shard 있을 때)
- DECISIONS.md 는 append-only 라 drift 개념 부적합, 제외

**`bin/cmds/split-docs.js`**
- `FRAMEWORK_PREFIXES` set 도입 — `functions`, `edge`, `v1~v5`, `rest`, `graphql`, `rpc`, `internal`, `public`, `protected` 를 도메인 추론 시 무시
- `domainFromFunctionName` 헬퍼 — kebab-case function 이름의 prefix 를 도메인으로 (signup-step1 → signup)
- `domainFromApiSection` 우선순위 재구성: `function:` → `path:` → title `METHOD /path` → `related_tasks:` → title slugify
- **`splitMultiFunctionSection`** — 한 level-3 섹션 안에 `function:` 블록이 N개면 level-4 (`####`) 헤더로 내부 분할. Supabase Edge Function 카탈로그 패턴(`### §2.2 endpoint별 시그니처` 안에 `#### signup-step1` 등) 정확히 분리.

**`commands/verify.md`**, **`commands/plan-arch-review.md`**, **`agents/reviewer-code.md`**
- Contract 축 / Integration 축 prompt 가 shard 를 1순위로 가리키도록 갱신
- legacy root (`API_CONTRACT.md` 등) 는 shard 없을 때만 fallback 으로 명시

**`commands/parallel.md`**
- 단계 9 추가 — cycle 끝나면 메인이 "/exit + 새 세션 + /pact:resume" 강력 권장 안내 출력 (필수)
- 동기: brewdy 분석에서 한 세션 57시간 누적 → 209M 토큰, batch 단위 세션 분할 → 같은 작업 ~30M

### 테스트

- `test/pact-cli.test.js` 에 6개 추가:
  - Supabase `/functions/v1/` path domain inference
  - REST 버전 prefix (`/api/v2/`) 무시
  - `function:` 가 path 보다 우선
  - `related_tasks:` fallback
  - 섹션 내 N개 function 블록 sub-header 분할
  - function 1개 섹션은 분할 X (정상 처리)
- 전체 **227/227 통과**

### 영향

- 기존 split-docs 출력이 달라질 수 있음 (`functions.md` 같은 framework-prefix 도메인 → 실제 도메인별 shard). 첫 재실행 시 옛 shard 정리 권장.
- reflect / verify / plan-arch-review 가 shard 가 있으면 shard 가리킴. legacy 가리키는 출력 사라짐.
- parallel cycle 끝마다 세션 권장 안내 → 사용자 행동 변화 유도, 누적 컨텍스트 비용 절감.

### 다음 (별도 plan)

- `docs/token-optimization-todo.md` — C 그룹 (worker 모델 분기, maxTurns cap, reviewer-arch opus→sonnet, verify Code축 skip 등) 미적용 상태로 남김. 우선순위 결정 후 진행.

## v0.7.0 — 2026-05-15

자유 수정 단계 멀티세션 안전망 — 모듈/파일 edit-lock + pre-tool-guard 차단.

### 동기

사이클 끝나고 사용자가 직접 코드·문서 수정할 때, 두 세션이 동시 같은 영역 만지면 race. v0.6.2 분담 모드는 빌드 단계까지만 안전. 자유 수정엔 빈 자리였음.

### 추가

- **`scripts/edit-lock.js`** — 모듈/파일 edit-lock 코어
  - `acquireEditLock(target, opts)` — target이 모듈(`auth`)이면 owner_paths + shard 자동 묶음. 파일 경로(`PROGRESS.md`)면 단일.
  - `releaseEditLock` — 자기 session_label 일치 시만 (force 옵션)
  - `listEditLocks` / `findLockForFile` / `cleanStaleEditLocks` / `expandModuleFiles`
  - stale takeover, session_label 우선순위는 v0.6.2와 동일
- **`pact edit-lock <target>` / `pact edit-release <target>` CLI**
  - `--session <label>` / `--kind module|file` / `--json` / `--force`
  - edit-release는 마지막 acquire 이후 git status로 drift 분석 + 알림
- **`hooks/pre-tool-guard.js` 확장**
  - Write/Edit/MultiEdit 시 파일 → 매칭 edit-lock 검사
  - 다른 session_label이 잡은 lock이면 차단 (모듈 owner_paths glob 매칭 또는 파일 정확 일치)
  - 자기 session(`PACT_SESSION` 또는 `ppid-<N>`) 잡은 lock이면 통과

### 모듈 lock의 자동 묶음

`pact edit-lock auth` 호출 시 다음 경로 일괄 lock:
- `contracts/modules/auth.md`의 `owner_paths` (예: `src/auth/**`, `src/api/auth/**`)
- `contracts/api/auth.md` (있으면)
- `contracts/db/auth.md` (있으면)
- `contracts/modules/auth.md`
- `tasks/auth.md` (있으면)

코드·계약·task가 한 묶음으로 보호됨.

### 글로벌 md 처리

`PROGRESS.md`, `DECISIONS.md`, `CLAUDE.md` 같은 글로벌은 파일 단위 lock으로:
```bash
pact edit-lock PROGRESS.md --session me
# ... 수정 ...
pact edit-release PROGRESS.md
```

### 사용 예

```bash
세션 A: pact edit-lock auth --session a
        # auth 모듈의 코드 + contracts + tasks 다 보호됨
        # ... 수정 작업 ...
        pact edit-release auth --session a
        
세션 B: pact edit-lock auth --session b
        # → 거부 (a가 잡고 있음)
        
세션 B: pact edit-lock payment --session b
        # → OK (다른 모듈)
```

### ADR

- **ADR-021** — 멀티세션 자유 수정 안전망 (모듈/파일 edit-lock)

### 테스트

- 211 → 221 (+10)
  - detectTargetKind / expandModuleFiles / acquire 4 / release 1 / findLockForFile 2 / cleanStaleEditLocks 1

### Breaking Changes

- 없음. edit-lock은 opt-in. 명시적 호출 X면 기존 동작.

---

## v0.6.2 — 2026-05-15

한 사이클을 여러 세션이 분담하는 패턴 정식 지원 — 각 세션이 잡은 task만 자기 sub-agent로 spawn.

### 시나리오

```
[메인]   /pact:plan → /pact:contracts → pact run-cycle prepare    (9 task batch)
[세션 1] pact claim PACT-001 PACT-002 PACT-003
         /pact:parallel   ← 내 3개만 sub-agent로 처리
[세션 2] pact claim PACT-004 PACT-005 PACT-006 (동시에)
         /pact:parallel   ← 내 3개만
[세션 3] pact claim PACT-007 PACT-008 PACT-009
         /pact:parallel   ← 내 3개만
[누구든] pact run-cycle collect   ← 머지 (멱등)
```

각 세션의 메인 컨텍스트에 9개 sub-agent 결과 누적 X → 3개씩 분산. multi-tenant cycle 디자인 변경 없이 lock 기반으로.

### 추가

- **`pact claim` 다중 task** — `pact claim PACT-001 PACT-002 PACT-003` 한 번에 여러
- **세션 라벨 자동 인식** 우선순위:
  1. `--session <label>` 명시
  2. `$PACT_SESSION` 환경변수
  3. `process.ppid` 자동 (부모 셸 PID, `ppid-<N>` 형태)
- **`pact list-locks` 신규 CLI** — `--mine` / `--session <label>` / `--alive` / `--json`
- **`commands/parallel.md` 단계 2.5 신설** — 분담 모드 자동 인식. 자기 세션이 잡은 task 있으면 그 ID만 필터해 Task tool spawn. 잡은 게 없으면 batch 전체 (기존 단일세션 동작).

### 사용자 부담

명령 1개 추가(`list-locks`)지만 slash 명령은 그대로 `/pact:parallel` 하나로 작동. 분담 모드는 자동 인식.

### 트레이드오프

- ✅ 메인 누수 분산 (3 세션 × 3 task = 9개 동시, 메인 1개에 누적 X)
- ✅ 디자인 변경 0 (v0.7.0 multi-tenant 폐기)
- ✅ slash 명령 외울 게 그대로
- ❌ 사용자가 `pact claim` 명시적으로 호출해야 분담 모드 진입 (자동 분배 X — 안전 우선)

### 테스트

- 204 → 211 (+7)
  - resolveSessionLabel 3 (명시/env/ppid)
  - list-locks 3 (--session / --mine env / --alive stale 제외)
  - claim 다중 1

### Breaking Changes

- `pact claim`이 다중 task 받으면서 lock 출력 형식 변경 (`results: [...]` 배열). 단일 task 호출은 기존과 동일 결과.

---

## v0.6.1 — 2026-05-14

`pact run-cycle prepare/collect` 멱등화. 멀티세션에서 "orchestrator 한 세션" 제약 제거 — 누구든 안전하게 호출 가능.

### 배경

v0.6.0 멀티세션 SDK 후 dogfooding 중 발견: prepare/collect는 여전히 한 세션에서만 안전하게 호출 가능. 두 세션이 동시 prepare 부르면 batch.json 동시 write·worktree 충돌. 사용자가 "메인 세션" 개념을 두는 게 부담스럽다는 피드백.

### 추가

- **`.pact/cycle.lock`** 기반 사이클 lock (prepare/collect 동시 호출 차단)
  - `scripts/lock.js`에 `acquireCycleLock` / `releaseCycleLock` / `readCycleLock` / `cycleLockPath` 추가
  - stale takeover (죽은 PID 잡은 lock은 자동 인계)
  - `cleanStaleLocks`가 cycle lock도 청소
- **`pact run-cycle prepare` 멱등**
  - `.pact/current_batch.json` + 모든 task의 worktree·prompt.md 존재하면 → `already_prepared: true` 반환
  - `--force`로 무시 가능
  - lock 획득 전 preflight 먼저 (lock 파일 생성이 clean tree 검사 깨지 않게)
- **`pact run-cycle collect` 멱등**
  - `current_batch.json` 없으면 → `already_collected: true` 반환 (이전 동작: 실패)
  - lock으로 동시 collect 차단

### 사용

```
세션 A: pact run-cycle prepare    # 첫 호출 — 정상 진행
세션 B: pact run-cycle prepare    # 두 번째 — already_prepared skip
세션 A or B: pact run-cycle collect # 어느 세션이든 한 번만 실행됨
```

"orchestrator 세션" 개념 사라짐. 모든 세션이 동등하게 prepare/collect 호출 가능.

### Breaking Changes

- `pact run-cycle collect` (current_batch 없음 케이스): 이전엔 exit 1 + `stage: no-current-batch`. v0.6.1부터 exit 0 + `already_collected: true`.
  - 영향: 이 케이스를 실패로 분기하던 호출자 코드 (없을 가능성 높음). pact 내부에선 없음.

### 테스트

- 198 → 204 (+6)
  - cycle lock: acquire 3 + release 1 + cleanStale 1
  - run-cycle 멱등: prepare 두 번 호출 시 already_prepared, collect 시 already_collected

---

## v0.6.0 — 2026-05-13

멀티세션 sibling 패턴 SDK. cmux/tmux 등으로 여러 Claude Code 세션을 진짜 OS 프로세스 병렬로 굴리는 모드 추가. sub-agent 패턴과 공존.

### 동기

기존 sub-agent 패턴(Task tool로 자식 conversation spawn)은 부모 메인 컨텍스트에 워커 prefix가 일부 누적. v0.4.1 run-cycle CLI로 95→5 turn 압축했지만 누적 0은 못 함. 사용자 요청: "진짜로 N개 세션을 동시 실행"으로 메인 누수 0 달성.

### 추가

- **`scripts/lock.js`** — `.pact/runs/<id>/lock.pid` 파일 기반 멀티세션 점유 락
  - `acquireLock` — fresh / takeover(stale PID) / 거부(살아있는 holder) 3가지 동작
  - `releaseLock` — 자기 PID 일치 시만 삭제 (다른 세션 lock 보호), `--force` 옵션
  - `releaseAllByPid` — 자기 PID 잡은 락 일괄 해제
  - `cleanStaleLocks` — 죽은 PID 잡은 락 일괄 정리
  - `listLocks` — alive/stale 표시
- **`pact claim <task_id> [--session <label>] [--json]`** — 명시적 점유 + 다음 단계 안내(worktree·prompt·context 경로)
- **`pact next [--all] [--json]`** — 현재 batch에서 미점유 task 한 개 (또는 전체) 출력
- **`pact status --watch [SECS]`** — 주기 폴링(default 2s)으로 다른 세션 진행·lock 상태 실시간 보기
- **`commands/multi-session.md`** — `/pact:multi-session` 슬래시 명령 가이드
- **session-start / progress-check hook** — stale lock 자동 청소 (이전 세션 비정상 종료 잔재)

### 멀티세션 흐름

```
[메인 세션]
  pact run-cycle prepare              # 기존 — batch + worktree + payload 준비
  pact next                           # 미점유 task ID 한 개

[워커 세션 (각자 cmux/tmux 패널)]
  pact claim PACT-001 --session 'pane:0.1'
  cd .pact/worktrees/PACT-001/
  claude                              # 새 세션, prompt.md 첫 입력
  # ... 작업 ... status.json + report.md 남기고 종료

[메인 세션]
  pact status --watch                 # 진행 모니터
  pact run-cycle collect              # 모든 워커 종료 후 머지 + cleanup
```

### sub-agent 패턴과 비교

| | sub-agent (Task tool) | 멀티세션 (이번 patch) |
|---|---|---|
| spawn | 부모 conversation 내부 | OS 프로세스 N개 |
| 메인 컨텍스트 누수 | 일부 누적 | **0** |
| 모니터링 | 메인 turn마다 | 파일 polling (`pact status --watch`) |
| 사용자 인터랙션 | 메인이 게이트 | 각 세션 자율 (yolo 권장) |
| Hooks | 부모 컨텍스트 hooks | 각 세션 독립 |

### 안전망

- 같은 task 중복 시작: `acquireLock`이 살아있는 PID 검사로 거부
- 비정상 종료 stale lock: SessionStart/SessionEnd hook이 자동 정리
- 머지 race: 머지는 메인 단일 지점(`pact run-cycle collect`)에서만

### 테스트

- 184 → 198 통과 (+14: isAlive 3 + acquireLock 4 + releaseLock 3 + releaseAllByPid 1 + cleanStaleLocks 1 + listLocks 1 + 회귀 1)

### ADR

- **ADR-020** — 멀티세션 sibling 패턴 (sub-agent 패턴과 공존)

### Breaking Changes

- 없음. sub-agent 패턴 그대로 작동. 멀티세션은 opt-in (사용자가 `pact claim` + 새 세션 시작 시에만).

---

## v0.5.2 — 2026-05-12

사이클 종료 후 사용자의 직접 수정과 contracts/PROGRESS의 표류(drift)를 두 시점에서 잡는다.

### 증상

`/pact:parallel` 끝나서 contracts/api/auth.md가 박혔는데, 사용자가 응답 형식을 직접 손대고 contracts 안 갱신. 다음 사이클 워커가 옛 contracts 믿고 잘못 짬.

### 추가

- **`hooks/stop-verify.js`**: turn 끝마다 git status 분류 — 코드 변경 있고 contracts/PROGRESS/MODULE_OWNERSHIP/tasks 변경 0개면 "문서 표류 가능" 별도 알림 추가. async라 응답 흐름 방해 X.
- **`commands/reflect.md`**: 단계 1.5 신설 — `.pact/merge-result.json`의 timestamp 이후 `git log --since`로 변경 파일 수집, planner reflect 모드 prompt에 CODE_CHANGED / DOCS_CHANGED 전달. 회고 출력에 "Docs Drift" 섹션 추가.

### 동작 시점

| 시점 | 어디서 잡나 |
|---|---|
| 매 turn 끝 | `stop-verify`가 단발 알림 (가벼움) |
| 사이클 회고 | `/pact:reflect`가 마지막 머지 이후 누적 분석 (정밀) |

### 테스트

- 177 → 184 통과 (+7: `stop-verify`의 `classifyChanges`/`extractPath` 7개 시나리오)
- pure 함수로 추출해서 hook 본체와 분리

### Breaking Changes

- 없음. 알림만 추가, 차단 X.

---

## v0.5.1 — 2026-05-10

`/pact:parallel` 무한루프 hotfix. 머지 완료된 task가 다음 batch에 다시 잡히던 문제를 두 단계로 차단.

### 증상

BOOT-001 머지 성공 → 다음 사이클이 다시 BOOT-001을 batch에 넣음. cycle 진행 불가.

### 원인 (두 단계)

1. **`scripts/parse-tasks.js:113-119`** — `{...parsed, status: 'todo', retry_count: 0}` spread 순서. yaml frontmatter의 `status: done`이 hardcoded `'todo'`로 덮어씌워짐.
2. **task source에 `done`을 박는 코드가 부재** — 워커는 `.pact/runs/<id>/status.json`에 done 기록, `pact merge`는 git 머지만 함. `tasks/<domain>.md`의 yaml은 영원히 `todo`. 다음 cycle batch-builder가 `t.status === 'done'`으로만 제외하므로 머지된 task 재선택.

### Fix

- `scripts/parse-tasks.js`: spread 순서 정정. `status`/`retry_count` default를 spread 앞에 두고, `id`/`title`은 spread 뒤에 두어 헤더 값 보호.
- `scripts/task-sources.js`: `setTaskStatus(taskId, status, opts)` helper 추가. yaml 블록에 `status:` 라인 있으면 replace, 없으면 append. tasks/*.md shard와 legacy TASKS.md 모두 지원.
- `bin/cmds/merge.js`: `mergeAll` 성공 후 `result.merged.forEach(id => setTaskStatus(id, 'done'))`. 충돌·skipped는 건드리지 않음 (재시도 가능 상태 보존). `merge-result.json`에 `status_updates` 필드 누적.

### 즉시 unblock (v0.5.0 사용자)

`tasks/<domain>.md`의 머지된 task yaml 블록에 `status: done` 한 줄 수동 추가. v0.5.1 적용 후엔 자동.

### 테스트

- 172 → 177 통과 (+5: parse-tasks 회귀 2개, setTaskStatus 5개 중 3개는 task-sources 테스트로 흡수)

### Breaking Changes

- 없음. yaml에 `status:` 라인이 없던 task는 default 'todo'로 동일 동작. v0.5.0에서 머지 후 멈춘 사이클은 즉시 unblock 절차로 풀림.

---

## v0.5.0 — 2026-05-09

서브에이전트별 모델 차등 매핑. 이전엔 8개 agent 전부 `model: inherit` (메인과 동일 모델) → 큰 batch에서 비용 비효율. 이번 릴리즈는 superpowers의 3계층 가이드(cheap/standard/most capable)를 pact 8개 역할에 매핑.

### 매핑

**Opus (판단 영역)**:
- `planner` — 요구사항 → task 분해 (잘못되면 나머지 다 망감)
- `architect` — 시스템 설계 결정
- `coordinator` — 배치 검토 + 결과 통합 + 충돌 판단 (silent failure 위험)
- `reviewer-arch` — 아키텍처 plan 검토 ("lock in" 단계)

**Sonnet (실행/검토 영역)**:
- `worker` — 단일 task 구현 (대부분 mechanical)
- `reviewer-task` — task 분해 검토
- `reviewer-code` — 머지 후 4축 검증
- `reviewer-ui` — UI/UX 검토

### 원칙

워커는 가볍게(sonnet), 워커를 통제하는 매니저·검토자는 강하게(opus). sonnet 워커가 흔들려도 opus reviewer가 잡아냄 (체크 효과).

### 효과 추정

- 큰 batch (5 worker 동시) 기준 **약 40-50% 비용 절감**
- worker spawn 시 첫 토큰 빠름 (Sonnet < Opus)
- coordinator·planner는 그대로 opus라 *판단 품질은 유지*

## v0.4.1 — 2026-05-08

메인 turn 압축 통합 CLI 도입 + 토큰 디시플린 6개 fix.

batch15 실측 (11.3M cache_read / cycle) 분석 결과 누수 96%가 메인 prefix 누적이었음. 이번 릴리즈는 그 패턴을 구조적으로 차단.

### 새 CLI: `pact run-cycle prepare/collect`
- `/pact:parallel`의 결정적 작업(사전검사·worktree·payload·status수집·머지·cleanup)을 두 CLI에 응집. 메인 LLM 도구 호출 turn 수 95→5 압축.
- `prepare`: preflight + buildBatches + worktree 생성 × N + payload·prompt 렌더 (atomic 롤백). stdout JSON으로 `task_prompts`·`coordinator_review_needed`·`context_warnings` 반환.
- `collect`: planMerge → mergeAll → cleanup + `verification_summary`·`decisions_to_record` 요약.
- `commands/parallel.md` 재작성 (291→101줄, -65%) — run-cycle 호출 + Task tool ×N spawn 흐름.

### 토큰 디시플린 (메인 prefix 누적 차단)
- **`commands/parallel.md` 1차 압축** (291→124, 1차) → 2차 재작성 (124→101). 이전 7.1k 토큰 본문이 매 turn cached read로 누적되던 단일 최대 누수원 차단.
- **`agents/worker.md` ↔ `prompts/worker-system.md` 통합**: TDD 단계·status.json schema·anti-pattern을 양쪽에서 50%+ 중복 정의하던 것을 분리. 198→86줄(-57%) + 199→49줄(-75%) = 워커 spawn당 ~3.3k 절감.
- **`pre-tool-guard` 차단 목록 확장**: `ARCHITECTURE.md`/`DECISIONS.md` 추가. 워커가 통째 read 시도 시 차단 + rg/sed 안내 (전체 7개 큰 SOT 차단).
- **작은 batch coordinator review 스킵 게이트**: `batches[0].length ≤ 2 && skipped.length === 0`이면 LLM 검토 생략 (CLI가 이미 결정적 검증).
- **`pact status --summary` / `-s`**: 단일 라인 요약 (`cycle:N active:N worktree:N merge:clean`). PROGRESS.md 통째 cat 대체.
- **worktree 생성 시 `node_modules` symlink 자동**: 워커가 tsx/tsc 경로 디버깅하던 ~12 turn × 누적 prefix = ~150k 누수 원천 제거. `opts.linkNodeModules: false`로 opt-out.

### Refactor
- `bin/cmds/merge.js`: `planMerge(opts)` pure 함수 추출 (run-cycle이 직접 호출). 기존 CLI handler는 그대로 동작.
- `bin/cmds/context-guard.js`: `collectLongDocs(maxLines, opts)` export + cwd 옵션 지원.

### 효과 추정 (batch15 11.3M baseline 기준)
- run-cycle (turn 수 95→5): cache_read **~94% 감소** (700k 추정). 단일 최대 lever.
- parallel.md 압축 (1차+2차): cycle당 ~300k cache_read 감소.
- node_modules symlink: 디버깅 cycle 자체 제거 = ~150k 감소.
- 합계: 11.3M → ~700k-1M (~91~94% 감소).

### 테스트
- 161 → 170 통과 (+9: 6 run-cycle 시나리오 + 3 worktree symlink + 2 status --summary).

### Breaking Changes
- 없음. `commands/parallel.md` 흐름이 바뀌었지만 기존 모든 CLI/agent/hook 동작 무영향.

### 호환성
- `pact merge`/`pact batch` CLI는 기존과 동일 (run-cycle 내부에서 pure 함수로 호출).
- `agents/worker.md`/`prompts/worker-system.md` placeholder 호환 (renderPrompt 인터페이스 동일).

---

## v0.4.0 — 2026-05-04

워커 truncation 한계 해소 + CLI 토큰 디시플린.

### 워커-side 수정
- **`agents/worker.md`**: `maxTurns: 30 → 60`. cycle 1 측정 결과 워커들이 RED+GREEN+verify+commit+status 한 번에 못 마치고 30~50 tool_use 부근에서 잘려 메인이 마무리하는 패턴 반복. 60으로 올려 정상 종료 가능하게.
- **`hooks/pre-tool-guard.js`**: 프로젝트 루트 밖 경로(예: `/tmp/foo`, `~/.claude/plugins/...`) Edit/Write 시도 시 MODULE_OWNERSHIP에 없다고 차단하던 false positive 해소. 이제 cwd 기준 상대경로가 `..`로 시작하거나 절대경로면 ownership 검사 건너뜀.

### CLI 토큰 디시플린 (메인 conversation context 절감)
- **`pact merge --quiet` / `-q`**: rejected 리스트(보통 28~31건)를 stderr 1줄 요약으로 압축. stdout에는 머지 성공만. `merge-result.json`에는 그대로 풀버전 기록.
- **`pact batch --next` / `-n`**: 전체 batch 19개 dump 대신 `batches[0]` 한 줄만. 잘못된 batch 선택 방지 + 출력 압축.
- **`pact context-guard --quiet` / `-q`**: 8줄 경고 → 1줄 요약 (`context-guard ok` 또는 `context-guard warn: N long doc(s)`).

### 측정 (사용자 환경)
- batch 15 (룰 X) → batch 16 (CLAUDE.md §8 운영 룰 O): 1회 /pact:parallel 토큰 442k → 256k (-42%). 본 v0.4 CLI 패치로 추가 절감 기대.

## v0.3.0 — 2026-05-03

Context-light SOT 시스템 안정화 + 자기 review 라운드 수정.

### 추가 (4 ADR)
- **ADR-015~017** (앞 커밋에서): tasks/contracts shard, worker context bundle, split-docs 마이그레이션
- **ADR-018**: `MODULE_OWNERSHIP.md` → `contracts/modules/<domain>.md` shard (API/DB와 일관)
- **`pact context-map sync`** CLI — Domains 표만 현재 shard 상태로 재생성 (idempotent, prose 보존)

### 변경
- `task-sources.js` frontmatter — silent overwrite → 첫 번째만 채택, 충돌은 error로 보고
- `pact split-docs`가 task 메타데이터(`contracts.api_endpoints`, `contracts.db_tables`, allowed_paths)에서 `context_refs` 자동 주입
- `pact split-docs`가 `MODULE_OWNERSHIP.md`도 분할 (`contracts/modules/<domain>.md`)
- `contracts/manifest.md`에 Modules 표 추가
- `pre-tool-guard` hook이 legacy `MODULE_OWNERSHIP.md` + `contracts/modules/*.md` 합집합으로 검증
- architect prompt에 Step 5 (`pact context-map sync` 호출) 명시
- `/pact:contracts`가 새 `contracts/modules/` 디렉토리도 mkdir
- ADR-017에 PRD 자동 분할은 v1.1+ scope임을 명시

### 호환성
- legacy 단일 파일 (`MODULE_OWNERSHIP.md`, `API_CONTRACT.md`, `DB_CONTRACT.md`, `TASKS.md`) 그대로 인식
- 기존 frontmatter 구조 동일 (충돌 시 첫 shard만 채택은 새 동작)

### 테스트
- 145/145 통과 (137 → +8: split-docs context_refs, modules 분리, context-map sync idempotent, task-sources frontmatter conflict, ownership shard 합집합)

---

## v0.2.1 — 2026-05-03

긴급 patch — 큰 PRD/TASKS 컨텍스트 폭발 fix.

### 추가
- **`pact slice` CLI** — TASKS.md 슬라이스 (`--status`, `--priority`, `--ids`, `--tbd`, `--headers`)
- **`pact slice-prd` CLI** — PRD 섹션 추출 (`--section`, `--sections`, `--headers`, `--refs-from`)

### 변경
- 모든 매니저 agent prompt에 **"큰 파일 통째 read 금지"** 강제
- planner·architect·reviewer-* 모두 slice/grep/sed 패턴 사용
- parse-tasks.js: `### TASK-XXX` (3 hashes) 헤더도 인식 (양쪽 호환)

### 효과
- 큰 PRD (1500+줄) + 큰 TASKS (1000+줄) 환경에서 매니저 호출 가능해짐
- review·plan 호출 시 컨텍스트 80%+ 절감

### 호환성
- 기존 사용자 영향 없음 (agent 행동만 변경, API 동일)


## v0.2.0 — 2026-05-02

v0.1.0 출시 후 즉시 보강. zero-dependency + 핵심 보안 fix + agent 분할.

### 추가 (5개 ADR)
- **ADR-011**: yolo 모드 자동 감지 (`permission_mode` 필드 활용, ADR-002 폐기)
- **ADR-012**: 워커 자기 보고 신뢰 X — 실제 git diff vs payload.allowed_paths 대조
- **ADR-013**: zero-dependency 전환 (js-yaml·ajv 제거, hand-written 대체)
- **ADR-014**: reviewer 4 분할 (reviewer-code/task/arch/ui) + 8 agent gstack 패턴 polish

### 보안·견고성
- `pact merge`가 status.json 신뢰 X, 실제 diff와 allowed_paths 대조
- `pre-tool-guard` hook이 워커 worktree 경계 + per-task allowed_paths 사전 차단
- yolo 모드 자동 감지 + SessionStart 즉시 위험 알림
- worker status.json schema strict 강제

### 배포 친화
- npm install 불필요 (zero deps)
- 마켓플레이스 캐시에서 즉시 작동

### Breaking Changes
- `subagent_type`: `reviewer` → `reviewer-code | reviewer-task | reviewer-arch | reviewer-ui` (4개 분할)
- 기존 `agents/reviewer.md` 삭제됨

### 테스트
- 133/133 통과 (yaml-mini 11개 + detect-yolo 6개 + ADR-012 시나리오 1개 신규)

---

## v0.1.0 — 2026-05-02

첫 공개 릴리스.

### Highlights
- **계약 기반 병렬 워커** — git worktree 격리, 같은 파일도 안전한 동시 수정
- **결정적 작업 = CLI** (`pact batch`·`pact merge`·`pact status`), **판단 = LLM** (매니저 4명)
- **Zero-dependency** — npm install 없이 `git clone` 후 즉시 작동
- **한국어 UX** + 사용자 결정 게이트 (propose-only)

### 핵심 자산
- **5 매니저 서브에이전트**: planner, architect, coordinator, reviewer (4 mode), worker
- **17 슬래시 명령**: init, plan, contracts, plan-task/arch/ui-review, parallel, verify, status, abort, resume, reflect, resolve-conflict, cross-review-plan/code, worktree-status/cleanup
- **8 hooks**: pre-tool-guard, tdd-guard, post-edit-doc-sync, stop-verify, subagent-stop-review, teammate-idle, progress-check, session-start
- **pact CLI**: `pact batch`·`pact merge`·`pact status`
- **JSON Schema** strict (worker-status, task)
- **Marketplace 등록** (`.claude-plugin/marketplace.json`)

### 흡수한 외부 영감
- gstack: cognitive 7 패턴, UX 3법칙, confidence calibration, coverage audit
- TDD Guard (nizos): PreToolUse 차단 패턴
- Specmatic / OSSA: JSON Schema strict
- Claude Code Agent Teams: TeammateIdle hook
- Hook async pattern: 텔레메트리 분리

### ADR 13개 (DECISIONS.md)
1. Task tool working_dir 강제 불가 → post-hoc + pre-block 하이브리드
2. ~~Yolo 자동 감지 불가~~ (ADR-011로 supersede)
3. plugin.json 위치 `.claude-plugin/`
4. 매니저·워커 모델 `inherit`
5. Worktree 정책 W1~W3
6. worker prompt 단일 파일 통합
7. Worktree 정책 W4·W5
8. Plan-review 3개 재편성 (gstack 영감 자체 구현)
9. Contract-First / TDD Guard / Async hooks 도입
10. 슬래시 명령 16 → 17 확장
11. Yolo 모드 감지 가능 (`permission_mode` 발견, ADR-002 supersede)
12. 워커 자기 보고 신뢰 X, 실제 git diff 대조 강제
13. Zero-dependency 전환

### 테스트
- 133/133 통과
- 통합 테스트 3 시나리오 (정상 cycle / 충돌 / schema 위반·거짓 보고)

### 알려진 한계 (v1.0)
- Brownfield 미지원 (v1.1+)
- Codex 외 cross-review 어댑터 X (인터페이스만)
- PRD .md만 (.docx/.pdf 미지원)
- monorepo 디스크 부담
- yaml-mini 파서 우리 subset만 (anchors·multi-doc 등 미지원)

### 출처
- 외부 영감: README.md
- 빌드 사실: docs/CLAUDE_CODE_SPEC.md
- 결정 누적: DECISIONS.md
