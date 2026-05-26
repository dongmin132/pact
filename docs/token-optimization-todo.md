# pact 토큰 절감 TODO

> 작성: 2026-05-26
> 배경: brewdy 에서 pact 사용 중 5h 한도 자주 침. 분석 결과 메인 세션 길이 + 일부 명령/agent prompt 가 비효율적.
> 이 파일은 **결정 안 된 후보 목록**. 우선순위는 너가 결정.

## 이미 한 것 (참고)

- ✅ `commands/parallel.md` 단계 9 추가 — cycle 끝나면 "새 세션 권장" 안내 출력
- ✅ **A-1 완료** (2026-05-26) — `commands/reflect.md` drift grep 패턴 확장
- ✅ **A-2 완료** (2026-05-26) — `commands/reflect.md` planner prompt 에 SOT 우선순위 룰 추가
  - planner.md 자체는 안 건드림 (reflect 외 모드는 doc 갱신 권장 X, 룰 불필요)
- ✅ **B-2 완료** (2026-05-26) — `commands/verify.md` Contract 축 prompt shard 우선 명시
- ✅ **B-3 완료** (2026-05-26) — `commands/plan-arch-review.md` description + Section 4 shard 우선
- ✅ **B-4 완료** (2026-05-26) — `agents/reviewer-code.md` Contract 축 + Integration 축 shard 우선
- ✅ **B-1 완료** (2026-05-26) — `bin/cmds/split-docs.js` 똑똑하게:
  - `FRAMEWORK_PREFIXES` set 추가 (functions, edge, v1~v5, rest, graphql, rpc, internal, public, protected)
  - `domainFromFunctionName` 헬퍼 (signup-step1 → signup)
  - `domainFromApiSection` 우선순위 재구성: function: → path: → title METHOD → related_tasks → slugify
  - 테스트 4개 추가, 전체 225/225 통과

## brewdy 에서 재실행 가이드 (B-5)

업데이트된 pact 로 brewdy 의 API_CONTRACT.md 를 다시 분할하려면:

### 1. 사전 백업 (필수)
```bash
cd /Users/dongminkim/Documents/github/brewdy

# 현재 상태 commit (작업 중인 변경 있으면)
git status
git add -A && git commit -m "wip: before split-docs re-run" || true

# 안전망: 현재 contracts/ 백업 brand
git branch backup/before-split-docs-rerun
```

### 2. 기존 functions.md 정리 (또는 --force)
기존 `contracts/api/functions.md` 가 있는 상태에서 split-docs 돌리면 `exists` 로 skip 됨.
새 inference 결과로 덮어쓰려면:

```bash
# 옵션 A: 강제 덮어쓰기
node /Users/dongminkim/Documents/github/pact/bin/pact split-docs --force

# 옵션 B: 기존 shard 삭제 후 재분할 (더 안전, 깔끔)
rm -rf contracts/api contracts/db contracts/modules contracts/manifest.md docs/context-map.md
node /Users/dongminkim/Documents/github/pact/bin/pact split-docs
```

### 3. 결과 확인
```bash
ls contracts/api/    # signup, profile, meetup, rating, report, block, notification 등 분할 확인
ls contracts/db/     # 기존 13개 유지 (DB 는 잘 분할되어 있었음)
cat contracts/manifest.md
```

### 4. 검증 — /pact:reflect 가 shard 가리키는지
brewdy 디렉토리에서 새 세션 (또는 /compact 후):
```
/pact:reflect
```

출력에 `DB_CONTRACT.md` / `API_CONTRACT.md` (legacy root) 가 등장하면 룰 적용 안 된 거. shard 경로 (`contracts/api/<domain>.md`) 가 나와야 정상.

### 5. drift 잡혔던 SOT 들 갱신
A-1 에서 추가된 grep 패턴으로 reflect 가 이제 `ARCHITECTURE.md`, `CLAUDE.md`, `docs/*.md` 변경도 잡음. 미반영된 갱신 사항 한 번에 정리 권장.

### 위험
- shard 가 사용자가 손으로 편집한 내용 있으면 덮어써질 수 있음. 옵션 B 의 `rm -rf` 전에 git status 로 확인.
- 새 inference 결과가 의도와 다르면 백업 브랜치 (`backup/before-split-docs-rerun`) 에서 cherry-pick 가능.

---

## 그룹 A — reflect.md 고치기 (드리프트 감지 정확하게)

### A-1. drift 패턴에 빠진 SOT 추가 ⏱️ 5분

**문제**: 지금 `/pact:reflect` 의 drift 감지가 `contracts/`, `tasks/`, `PROGRESS.md` 만 봄. 그래서 ARCHITECTURE.md / CLAUDE.md / docs/ 안 .md 들 바뀌어도 못 잡음.

**고침**: `commands/reflect.md` 의 grep 패턴 수정.
```
변경 전: ^(contracts/|PROGRESS\.md|tasks/)
변경 후: ^(contracts/|tasks/|docs/.*\.md$|PROGRESS\.md|ARCHITECTURE\.md|CLAUDE\.md)
```

**왜 DECISIONS.md / API_CONTRACT.md / DB_CONTRACT.md 는 안 넣나**
- DECISIONS.md: append-only 로그라 drift 개념 안 맞음. 새 ADR 은 reflect 가 별도로 이미 제안.
- API_CONTRACT.md / DB_CONTRACT.md: legacy. `contracts/api/**`, `contracts/db/**` shard 가 진짜 SOT.

---

### A-2. reflect 가 shard 무시하고 루트 가리키는 버그 ⏱️ 30분

**문제**: brewdy 의 reflect 출력이 이렇게 나옴:
```
변경: 0109 (chat_read_state)
갱신 권장: DB_CONTRACT.md 신규 테이블 + ARCHITECTURE.md §8 unread SOT
```
근데 brewdy 에는 `contracts/db/chat.md` 가 이미 있음. **루트 DB_CONTRACT.md 가 아니라 shard 를 가리켜야 함.**

**원인**: planner 의 reflect prompt 에 "shard 있으면 shard 우선" 룰이 없음.

**고침**:
1. `commands/reflect.md` 의 planner 호출 prompt 에 SOT 우선순위 룰 추가
   ```
   갱신 권장 시:
   - 1순위: contracts/<api|db|modules>/<domain>.md (shard 있으면 무조건)
   - 2순위: ARCHITECTURE.md, CLAUDE.md (shard 없는 SOT)
   - 3순위: docs/*.md
   - ❌ 금지: API_CONTRACT.md / DB_CONTRACT.md (shard 있을 때) 
   ```
2. `agents/planner.md` 의 reflect 모드 가이드에도 동일 룰

---

### A-3. drift=0 일 때 LLM 호출 건너뛰기 ⏱️ 1일

**문제**: reflect 매번 planner(opus, 약 3M 토큰) 호출. 근데 drift 없고 실패 없으면 LLM 안 부르고 한 줄 출력하면 됨.

**고침**:
- `pact drift` CLI 추가 (LLM 안 거치고 결정적 분석만)
- `commands/reflect.md` 가 먼저 `pact drift` 호출 → 결과 0 이면 "표류 없음" 한 줄 출력 후 종료, 0 아니면 planner 호출

**효과**: 깨끗한 cycle 에서 reflect 비용 3M → 0

---

## 그룹 B — shard 도입 후 안 고친 부분들

브루디 케이스로 발견된 문제. **A-2 만 고쳐선 부족. 아래 4개 같이 해야 reflect 결과가 진짜 깔끔해짐.**

### B-1. split-docs 가 Supabase 같은 framework path 인식 못함 ⏱️ 3시간

**문제**: brewdy 의 API_CONTRACT.md 가 shard 1개 (`contracts/api/functions.md`, 933줄) 로만 분할됨. 사실상 분할 실패.

**원인**: `bin/cmds/split-docs.js` 의 `domainFromEndpoint` 가 `/api/` prefix 만 필터링.
Supabase 의 `/functions/v1/signup-step1` 같은 경로면 첫 파츠가 `functions` → 모든 endpoint 가 같은 도메인.

**고침**: `bin/cmds/split-docs.js`
- 프레임워크 prefix 필터 확장: `functions`, `edge`, `v1`/`v2`, `rest`, `graphql`, `rpc`, `internal`
- function name 우선 추출 (`function: signup-step1` → `signup`)
- related_tasks fallback (`- AUTH-001` → `auth`)
- 테스트 4-6개 추가

**효과**: brewdy 의 functions.md (933줄) → 8개 도메인 shard (auth/profile/meetup/rating/...)

---

### B-2. `commands/verify.md` 가 root 파일 가리킴 ⏱️ 5분

**문제**: line 44
```
Contract: API_CONTRACT.md ↔ 실제 라우트 비교
```
shard 도입 전 그대로. 이래서 verify 가 root 가리킴.

**고침**:
```
Contract: contracts/api/<domain>.md (shard 우선, 없으면 API_CONTRACT.md) ↔ 실제 라우트
```

---

### B-3. `commands/plan-arch-review.md` 도 root 가리킴 ⏱️ 5분

**문제**: description 에 "API_CONTRACT·MODULE_OWNERSHIP·DB_CONTRACT 교차 검증" 박힘.

**고침**: `contracts/api/**`, `contracts/db/**`, `contracts/modules/**` 로 교체.

---

### B-4. `agents/reviewer-code.md` Contract 축 ⏱️ 15분

**문제**: Contract 검증 섹션의 prompt 가 root 파일 가리킴.

**고침**: shard 우선 명시 + root 는 fallback 으로만.

---

### B-5. brewdy 에 split-docs 재실행 + 검증 ⏱️ 30분

B-1~4 끝나면 brewdy 에서:
```bash
cd /Users/dongminkim/Documents/github/brewdy
pact split-docs --force      # 새 inference 로 재분할
```
그리고 `/pact:reflect` 다시 돌려서 출력이 shard 가리키는지 확인.

---

## 그룹 C — 토큰 절감 (행동 변화 + 약간의 코드)

브루디 실측 기반 우선순위.

### C-1. worker 모델 분기: 단순 task → Haiku ⏱️ 0.5–1일

**현재**: 모든 워커 = Sonnet
**바뀜**: tasks/*.md frontmatter 에 `worker_model: haiku|sonnet|opus` 추가, spawn-worker 가 읽어서 분기

**효과**: Haiku = Sonnet 1/3 가격. 워커가 batch 토큰의 70% 차지하므로 batch 5M → 1.7M 가능. **5h 한도 내 batch 수 3배.**

**위험**: Haiku 가 복잡 task 못하는 경우 → fallback 으로 Sonnet 재시도 패턴 필요

---

### C-2. worker maxTurns 60 → 30 ⏱️ 1줄

**현재**: `agents/worker.md` 의 `maxTurns: 60`. 워커 평균 1.45M 토큰 (긴 task 가 평균 끌어올림).
**바뀜**: 30 으로 cap. runaway 워커 자동 중단 → blocked → 사용자가 task 쪼개기.

**효과**: 평균 1.45M → 800k–1M. 월 70M 토큰 절감 추정.

---

### C-3. reviewer-arch 모델 opus → sonnet (테스트 후) ⏱️ 1줄 + 베타

**현재**: `agents/reviewer-arch.md` model: opus. Opus = Sonnet 의 **5배 가격**.
**바뀜**: sonnet 으로 한 사이클 베타. 품질 비교.

**효과**: `/pact:plan-arch-review` = 5–10M → 1–2M. **5배 절감.**

**위험**: review 품질 저하 가능성. 베타 결과 보고 결정.

---

### C-4. /pact:verify Code 축 자동 skip ⏱️ 30분

**문제**: docs-only cycle 에서도 lint/typecheck/test/build 다 돌림 (5.8M 토큰 낭비).
**고침**: `commands/verify.md` 가 `git diff --name-only HEAD~1` 로 코드 파일 변경 있는지 먼저 체크. 없으면 Code 축 skip.

**효과**: docs-only cycle 에서 verify 5.8M → 0

---

### C-5. agents/*.md 중복 "parallel tool use" 블록 제거 ⏱️ 5분

**현재**: 8개 agent 에 똑같은 5줄 블록 박혀있음. modern Claude default 동작이라 사실상 noise.
**고침**: CLAUDE.md 에 한 번만, 또는 그냥 삭제.

**효과**: 매 agent spawn 마다 ~150 토큰 절약. 누적 효과 + 파일 깔끔.

---

### C-6. plan-arch-review batch dump (한 번에 4 섹션 출력) ⏱️ 1시간

**현재**: reviewer-arch 가 섹션 1 → 사용자 결정 → 섹션 2 → 결정... (4 turn).
**바뀜**: 4 섹션 한 번에 출력, 사용자가 한 메시지로 결정.

**효과**: 4 turn → 1 turn. **3–4x 절감.**
**단점**: 한 번에 정보량 많음.

---

## 우선순위 추천

| 단계 | 작업 | 시간 | 효과 |
|---|---|---|---|
| **1** | A-1 (drift 패턴 확장) + A-2 (shard 우선 룰) + B-2/B-3/B-4 (3 군데 prompt) | **1시간** | reflect 결과 정확해짐 |
| **2** | C-2 (worker maxTurns) + C-5 (중복 블록 제거) | **10분** | 즉시 절감 |
| **3** | C-1 (worker 모델 분기) | **0.5–1일** | **5h 한도 3배** |
| **4** | B-1 (split-docs 똑똑하게) + B-5 (brewdy 재분할) | **3.5시간** | shard 진짜 분할 |
| **5** | C-3 (reviewer-arch opus→sonnet) 베타 | **베타 1 cycle** | plan-arch-review 5x 절감 |
| **6** | A-3 (reflect LLM skip) | **1일** | reflect 비용 3M → 0 (조건부) |
| **7** | C-4 + C-6 | **1.5시간** | 작은 추가 절감 |

**가장 빠른 ROI**: 단계 1+2 (1시간 10분) = reflect 가 제대로 동작 + 워커 runaway 차단.

---

## 작업 시작할 때 확인할 것

- [ ] 어느 단계부터 시작할지 결정
- [ ] 단계별로 commit / PR 분리 (한 번에 다 묶지 X)
- [ ] 변경 후 brewdy 에서 한 cycle 돌려 검증
- [ ] CHANGELOG.md / DECISIONS.md (필요 시 ADR) 갱신
