---
description: 회로 차단된 task 재시도 — /pact:resume <task_id>
---

사용자가 `/pact:resume $ARGUMENTS`를 실행했습니다.

## 단계 1: 인자 검증

`$ARGUMENTS`가 비어있거나 task_id 형식(`[A-Z][A-Z0-9]*-\d+`) 아니면:
```
Usage: /pact:resume <task-id>
예: /pact:resume PACT-042
```
후 중단.

## 단계 2: 사전 검사

1. `CLAUDE.md` 존재
2. PROGRESS.md `Blocked / Waiting` 섹션에 해당 task_id 있나 확인
3. `.pact/runs/<task_id>/payload.json` 존재 (이전 spawn 정보 보존됨) 확인
4. `.pact/worktrees/<task_id>/` 보존돼있나 확인

조건 미충족 시 한국어로 사유 + 안내 후 중단.

## 단계 3: 이전 실패 사유 표시

`.pact/runs/<task_id>/status.json`이 있으면 `blockers` 배열을 사용자에게 보여주기:

```
PACT-042 이전 실패:
  - typecheck 반복 실패 (재시도 1회)
  - 타입 에러: src/api/auth/login.ts:42 string vs number

재시도하시겠습니까? [y/N]
```

'y' 외 답변 → 취소.

## 단계 4: 재시도

`.pact/runs/<task_id>/payload.json`을 read하여 retry_count 증가:

```bash
node -e "
const fs = require('fs');
const p = '.pact/runs/$ARGUMENTS/payload.json';
const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
payload.retry_count = (payload.retry_count || 0) + 1;
fs.writeFileSync(p, JSON.stringify(payload, null, 2));
console.log('retry_count:', payload.retry_count);
"
```

retry_count가 **2를 넘으면** (= 누적 3회) 영구 차단:
```
⚠️ <task-id>는 누적 3회 실패. 재시도 거부.
DECISIONS.md에 "이 task가 왜 실패하는가" ADR 기록 후 /pact:plan으로 재분해 권장.
```

이하는 누적 3회 미만일 때만:

`/pact:parallel`의 단계 5-9와 동일하게 실행 (단, 한 task만):
1. spawn-worker.js로 prompt 준비 (보존된 payload + retry_count 반영)
2. Task tool로 worker subagent 호출
3. 종료 후 status.json 검증·통합
4. 결과를 PROGRESS.md에 반영 (Blocked → Recently Done 또는 Blocked 유지)

## 단계 5: 결과 보고 (한국어)

성공:
```
✅ <task-id> 재시도 성공
PROGRESS.md Blocked에서 제거, Recently Done에 추가됨.
```

실패:
```
⚠️ <task-id> 재시도 실패 (retry_count: <N>)
status.json blockers: <목록>

다음:
  /pact:resume <task-id>  # 또 시도 (3회 미만일 때)
  /pact:plan              # task 재분해
```

## 의문 시

- worktree 외부에서 변경된 파일 있음: 사용자에게 알림, 강제 진행 X
- payload schema가 옛 버전: 사용자에게 안내, /pact:plan 재호출 권장
