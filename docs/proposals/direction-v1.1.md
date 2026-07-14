# 제안: v1.1 방향 — 안전층(freeze+gate) 재포지셔닝

> **상태: 제안 (미결정) — 사용자 논의용.** 2026-07-13 방향 리서치(32-에이전트, 웹 1차출처 적대검증)와
> 2026-06-27 경쟁 벤치(49-에이전트)의 결론을 결정 가능한 형태로 압축한 문서다.
> 채택 시 항목별 ADR로 기록.

## 1. 상황 (2026-07 기준, 검증된 사실)

- **위협 주체가 경쟁 OSS → 플랫폼(Claude Code) 자체로 이동.** v1.0 헤드라인 4개 중 2개를 CC가 흡수:
  - #2 worktree 격리 → 네이티브 worktree + `/batch`(정식 GA, worktree 서브에이전트 각자 PR)가 무료화.
  - #4 결정적 CLI·0토큰 오케스트레이션 → dynamic workflows(v2.1.154+)가 토큰축에서 pact의 파일 SOT보다 앞섬.
- **아직 pact 만 가진 것 (코드 확인)**: ① 결정적 머지 게이트(`merge-coordinator.js` — git diff vs allowed_paths, LLM 0, 거짓머지-0) ② prelude 공유표면 자동추출(freeze 후보 detect). `/batch`·dynamic workflows·Agent Teams 전부 이 reject-SOT·안전층이 없다(Agent Teams는 "같은 파일 덮어씀·수동 분할" 안내가 공식 문서에 명시된 공백).
- **brownfield 는 이제 scope 결손이 아니라 경쟁 결손**: spec-kit(120k★)·jmcentire/pact 는 adopt/assess 출시. 제3자 스캐폴드 벤치(HAL·DPAI)가 전부 brownfield 전제라 greenfield-only 인 pact 는 구조적으로 벤치에서 배제된다.
- **Orca(YC) 등 GUI 병렬 도구는 경쟁이 아니라 보완/잠재 호스트** — "머지는 100% 사람" 이 명시 한계 = 정확히 pact 게이트가 메우는 화이트스페이스.

## 2. 제안 방향 (베팅 순위)

**베팅 ① — freeze+gate 를 축으로 재포지셔닝 + 네이티브 task-set 소비 개방.**
오케스트레이션 하부(병렬 spawn·worktree)는 플랫폼에 위임하고, pact 는 그 위의 **안전층**(계약 게이트 + prelude freeze + propose-only)으로 선다. `/batch`·spec-kit 산출물(task list)을 pact task 로 소비하는 얇은 입구를 열면 "정면 경쟁" 대신 "보완재" 포지션. (마케팅 문구: "어떤 병렬 도구를 쓰든, 머지는 pact 게이트를 통과한다.")

**베팅 ② — `/pact:adopt` 얇은 결정적 어댑터 (v1.1 여부 사용자 결정 필요).**
범용 코드분석(repomix 류) 재구현이 아니라: 기존 레포에서 `contracts/modules` 초안 + MODULE_OWNERSHIP + freeze 후보를 **결정적으로**(rg/git 기반) 추출해 propose-only 로 제시하는 최소형. 채용 장벽 제거 + 제3자 벤치(HAL·DPAI) 잠금해제가 목적. **CLAUDE.md v1.0 out-of-scope 항목이므로 v1.1 착수는 명시적 사용자 승인 필요.**

**베팅 ③ — 모델불가지는 게이트웨이 문서화로만 값싸게.**
`ANTHROPIC_BASE_URL` 게이트웨이 경유를 문서로 안내(README 한 절). 워커를 Agent SDK 밖으로 이식하는 것은 함정(SDK 가 Claude-shaped) — 안 한다.

## 3. 안티패턴 (하지 않기로 리서치가 결론낸 것)

- 오케스트레이션 재구현을 헤드라인 마케팅으로 (플랫폼이 이미 무료 제공)
- 범용 코드분석 브라운필드 (repomix 등으로 commoditized)
- 계약 본문 자동생성 (거짓 확신 게이트 — 철학 #3·#5 위반)
- salvage/effective_parallelism 를 "증명" 헤드라인으로 (self-serving — 코드 스스로 "독립 벤치 아님" 라벨)

## 4. 실증 트랙 (병행)

- **brewdy 새 사이클**: 0.10.0 이전 기준선(155 task/salvage 19%/충돌 1%) 대비 0.12.0 실측 — task 지정은 사용자 몫.
- **공개 스코어카드**: 표준 task-set 에 metrics 4축을 붙인 before/after 공개 — 기능 해자가 얇아진 지금, 실증 숫자가 차별의 본체.

## 5. 결정 질문

1. 베팅 ①(재포지셔닝 + 네이티브 task-set 소비)을 채택하나? — README/포지셔닝 문구와 입구 어댑터 설계로 이어짐.
2. `/pact:adopt` 최소형을 v1.1 로 승격하나? (v1.0 out-of-scope 해제 — 사용자 명시 승인 필요)
3. brewdy 새 사이클을 언제·어떤 task 로 돌리나?
