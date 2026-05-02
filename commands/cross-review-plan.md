---
description: 외부 도구(Codex)에게 plan 검토 요청 — 의견만, 차단 X
---

사용자가 `/pact:cross-review-plan`을 실행했습니다.

**원칙** (ARCHITECTURE.md §19): 정보 제공만. 자동 차단·자동 fix task 추가 X.

## 단계 1: 사전 검사

- `TASKS.md` 존재 — 없으면 "/pact:plan 먼저"
- CLAUDE.md `cross_review.adapter` 확인:
  - `null` → "Codex 미감지. /pact:init에서 활성화하거나 codex CLI 설치 후 다시 시도" 후 종료
  - `codex` → 진행

## 단계 2: 어댑터 호출

```bash
node -e "
const { createCodexAdapter } = require('${CLAUDE_PLUGIN_ROOT}/scripts/cross-review/codex-adapter.js');
const adapter = createCodexAdapter();

(async () => {
  if (!await adapter.check_available()) {
    console.log(JSON.stringify({error: 'codex unavailable'}));
    process.exit(1);
  }
  const findings = await adapter.call_review({
    target: 'plan',
    artifacts: ['TASKS.md', 'API_CONTRACT.md', 'MODULE_OWNERSHIP.md'].filter(f => require('fs').existsSync(f)),
    context: '사용자 요구사항·CLAUDE.md 발췌',
  });
  console.log(JSON.stringify({findings}, null, 2));
})();
"
```

## 단계 3: 결과 한국어 보고

```
🔍 Cross-Review (Codex) — Plan

발견 <N>건:

1. <file>:<line>  [<severity>] (confidence: <N/10>)
   <한국어 message>
2. ...

다음 액션:
  [1] 모든 의견을 fix task로 — /pact:plan 재호출
  [2] 일부만 — 번호 골라서 답
  [3] 모두 무시
```

## 단계 4: PROGRESS.md 갱신

`last_cross_review` yaml 블록:
```yaml
last_cross_review:
  cycle: <N>
  target: plan
  findings_count: <N>
  user_action: <accept_all | partial_accept | ignore>
  cost_external: <USD 추정 — codex 응답 메타에서 추출>
```

`external_review_cost.total_usd` 누적 갱신.

## 안 하는 것 (ARCHITECTURE.md §19)

- ❌ 자동 차단 (의견만)
- ❌ 자동 fix task 추가 (사용자 명시 수용 후만)
- ❌ DECISIONS.md 자동 변경

## 의문 시

- codex 응답 형식 깨짐: parseFindings가 빈 배열 반환, 사용자에게 알림
- timeout (5분 default): 명확히 알리고 재시도 권유
