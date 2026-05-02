# PROGRESS.md

> **현재 상태만 기록**. archive 섹션 X (git history가 자연스러운 archive).
> coordinator가 매 사이클 갱신. 사용자도 직접 읽기 가능.

## Current Goal

<현재 목표 한 줄>

## Active Cycle

```yaml
cycle: 0
status: not_started     # not_started | running | merging | reviewing | done | aborted
started_at: null
educational_mode: false
risk_acknowledged: false
```

## Recently Done

(완료된 task 누적, 최근순. git log가 더 정확하지만 빠른 참조용.)

- (비어있음)

## Blocked / Waiting

(회로 차단기 발동된 task. `/pact:resume <task_id>`로 사용자가 재개 가능.)

- (비어있음)

## Verification Snapshot

마지막 `/pact:verify` 결과:

```yaml
lint: unknown
typecheck: unknown
test: unknown
build: unknown
contract: unknown
docs: unknown
integration: unknown
last_run_at: null
```

## last_cross_review

```yaml
cycle: null
target: null              # plan | code
findings_count: 0
user_action: null         # accept_all | partial_accept | ignore | not_called
cost_external: 0
```

## external_review_cost (누적)

```yaml
total_usd: 0
last_updated: null
```
