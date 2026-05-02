---
description: 외부 도구(Codex)에게 cycle diff 검토 요청 — 의견만, 머지 차단 X
---

사용자가 `/pact:cross-review-code`를 실행했습니다.

**원칙**: 머지 자체는 차단 X. 의견만, 사용자가 다음 cycle fix task 추가 결정.

## 단계 1: 사전 검사

- `CLAUDE.md`의 `cross_review.adapter`가 `null` 아님
- 마지막 머지 commit 식별 가능 (`.pact/merge-result.json` 또는 `git log --grep "pact: merge"`)

## 단계 2: cycle diff 범위 결정

```bash
# 마지막 cycle merge commit들 식별
git log --grep="pact: merge pact/" --pretty=format:"%H" | head -10
```

또는 PROGRESS.md `Active Cycle.cycle`을 보고 해당 cycle의 commit 범위.

## 단계 3: Codex 호출

```bash
node -e "
const { createCodexAdapter } = require('${CLAUDE_PLUGIN_ROOT}/scripts/cross-review/codex-adapter.js');
const adapter = createCodexAdapter();

(async () => {
  const findings = await adapter.call_review({
    target: 'code',
    artifacts: ['<cycle commit 범위>'],
    context: '<CLAUDE.md 발췌 + 변경 모듈 요약>',
  });
  console.log(JSON.stringify({findings}, null, 2));
})();
"
```

## 단계 4: 결과 보고 (한국어)

```
🔍 Cross-Review (Codex) — Cycle <N> Code

발견 <N>건:

1. src/api/auth/login.ts:42  [warn] (confidence: 8/10)
   "SQL injection 가능성. 파라미터 바인딩 사용 권장."
2. ...

다음 액션:
  [1] 다음 cycle fix task로 추가 — planner 재호출
  [2] 일부만
  [3] 무시 (DECISIONS.md ADR 권장)
```

## 단계 5: PROGRESS.md 갱신

`last_cross_review` 블록 + `external_review_cost` 누적.

## 의문 시

- cycle commit 식별 실패: 사용자에게 commit 범위 직접 입력 요청
- false positive 의심: 그대로 보고, 자체 판단 X (사용자가 결정)
