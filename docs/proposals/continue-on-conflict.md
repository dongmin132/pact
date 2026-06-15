# 제안: continue-on-conflict (머지 충돌 시 나머지 진행)

> **상태: REJECTED (2026-06-15) — 현행 "즉시 stop" 유지. 동작 변경 없음.**
> 아래 "결정" 절 참고. 운영에서 충돌 빈도가 유의미하게 높아지면 재검토한다.

## 배경 (현재 동작)

`mergeAll`(`scripts/merge-coordinator.js`)은 cycle 단위 sequential 머지 중 **첫 충돌에서 즉시 stop**한다(ARCHITECTURE §15 / W5). 충돌 task 이후의 task들은 `skipped`로 보고되고 그 사이클에서 머지되지 않는다. 충돌은 자동 해결하지 않고 사용자에게 위임한다(5철학: "머지 충돌 자동 해결 — 영구 X").

## 문제

헤드리스 무인 멀티task 배치에서 **task 하나가 충돌하면 나머지 무충돌 task까지 전부 멈춘다.** 5개 중 1개만 충돌해도 4개의 멀쩡한 작업이 그 사이클에 반영되지 않아, 무인 운영의 처리량이 떨어지고 사람이 개입할 때까지 진척이 막힌다.

## 제안

`--continue-on-conflict`(기본 OFF) 플래그를 도입한다. 충돌 발생 시:

1. 그 충돌 머지를 **즉시 `git merge --abort`**로 정리한다(현재는 abort 안 함 → MERGE_HEAD 잔존).
2. 충돌 task를 `conflicted` 목록에 기록하고 **worktree·branch를 보존**한다(작업 손실 없음).
3. **나머지 task의 머지를 계속** 진행한다.
4. 충돌 task는 **escalation**으로 사람에게 위임한다(`/pact:resolve-conflict`).

핵심: 이것은 **충돌을 자동 해결하는 게 아니라**, 충돌 task만 격리하고 무관한 task를 계속 머지하는 것이다. 충돌 자체의 해결은 여전히 사람 몫 → 5철학("자동 해결 X")과 충돌하지 않는다.

## 트레이드오프 / 리스크 (정직하게)

- **거짓 충돌/거짓 성공**: sequential 머지에서 충돌 task를 건너뛰면 이후 task의 머지 베이스가 달라질 수 있다. 파일이 겹치는 task 간에는 "A를 빼고 B를 머지"가 의도와 다른 결과를 낼 수 있다. → 완화: 충돌 직후 `git merge --abort` 필수, 그리고 batch 내 **파일 중첩 task는 사전 정렬/분리**(merge 순서 결정성)가 선행 권장.
- **부분 반영 상태**: 한 사이클이 "일부 머지 + 일부 충돌 보존"으로 끝나므로, 사람이 충돌을 해결할 때 main이 이미 일부 진행된 상태임을 인지해야 한다.
- **ARCHITECTURE 변경**: §15 W5의 "즉시 stop" 원칙을 바꾸는 것이므로 ADR 등재 + 승인 필요.

## 미승인 시 폴백 (현재 안전 동작)

승인 전까지는 현행 유지: 첫 충돌에서 stop, `conflicted` 보고, `collect`가 MERGE_HEAD를 남기고(또는 P2 크래시복구가 journal로 식별), 다음 `prepare` preflight(`isMergeInProgress`)가 막아 사람이 `/pact:resolve-conflict`로 해결. **이미 충분히 안전하다.**

## 결정 (2026-06-15)

**거부 — 현행 "즉시 stop" 유지.**

근거: pact는 계약 + `allowed_paths` + MODULE_OWNERSHIP + worktree 격리로 머지 충돌을 **설계상 최소화**한다. 충돌이 드물다면 "stop + 사람 해결(`/pact:resolve-conflict`)"이 이미 안전하고, continue-on-conflict의 처리량 이득은 작은 반면 sequential 머지 거짓충돌 리스크 + ARCHITECTURE §15 개정 부담이 크다. **이득 < 리스크.**

- [ ] continue-on-conflict 도입
- [x] **도입하지 않음 (현행 유지)** ← 선택됨

재검토 트리거: 실제 운영에서 머지 충돌 빈도가 유의미하게 높아질 때(즉 task 스코핑/계약이 충돌을 못 막는 증거가 쌓일 때). 그때 승인 시 구현 범위: `mergeAll`에 `continueOnConflict` 옵션 + 충돌 시 `abortMerge` + 충돌 task 보존/escalation, `run-cycle collect --continue-on-conflict` 플래그, ARCHITECTURE §15 개정, 회귀 테스트.
