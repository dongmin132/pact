---
description: 진행 상황 표시 — 활성 cycle, 워커 상태, 검증 결과 한 화면에
---

사용자가 `/pact:status`를 실행했습니다.

## 단계 1: 사전 검사

`CLAUDE.md` 없으면 "/pact:init 먼저" 후 중단.

## 단계 2: 정보 수집

다음 정보 모으기:

```bash
# PROGRESS.md
cat PROGRESS.md 2>/dev/null

# 활성 worktree
node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js  # 인자 없으면 require로만 — bash로:
node -e "
const { listWorktrees } = require('${CLAUDE_PLUGIN_ROOT}/scripts/worktree-manager.js');
console.log(JSON.stringify(listWorktrees(), null, 2));
"

# 워커 status.json 들
ls .pact/runs/*/status.json 2>/dev/null

# 머지 진행 중?
git rev-parse -q --verify MERGE_HEAD && echo "merge in progress" || echo "clean"
```

## 단계 3: 한국어 출력

```
📊 pact 상태

Cycle: <current_cycle> | <not_started | running | merging | reviewing | done | aborted>
교육 모드: <ON | OFF>
yolo: <true | false>

활성 워커:
  ▶ PACT-042  로그인 API     (15m)
  ▶ PACT-043  회원가입 API   (12m)

완료된 task (이번 cycle):
  ✅ PACT-040  유저 모델
  ✅ PACT-041  토큰 발급

차단됨 (Blocked):
  ⏸ PACT-039  typecheck 반복 실패 (retry: 2)
    → /pact:resume PACT-039 또는 /pact:plan으로 재분해

검증 (마지막 /pact:verify):
  Code: ✅ PASS  Contract: ✅  Docs: ✅  Integration: ✅

활성 worktree: 2개 (디스크 ~280MB)
머지: clean

Cross-review:
  마지막: cycle 7, target=code, findings=2, 사용자 무시
  외부 비용 누적: $0.04
```

## 단계 4: 동시 실행 검사 (G12)

병렬 cycle이 진행 중이면 (PROGRESS.md status가 running·merging 등):
```
⚠️ 진행 중인 cycle이 있습니다. /pact:abort로 중단할 수 있습니다.
```

## 의문 시

- PROGRESS.md 형식 깨짐: 사용자에게 알림, 부분 정보만 표시
- worktree-manager.js 호출 실패 (git 환경 X 등): 그 부분 생략, 나머지 표시
