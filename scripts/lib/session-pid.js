'use strict';

// 락 소유자 정체성 헬퍼 (H3-2).
//
// 문제: Claude Code Bash 도구는 복합 커맨드를 매 호출 새 셸(zsh)로 포크하므로 CLI(node)의
//   부모(process.ppid)는 명령 반환 즉시 죽는다. 이를 락 holder pid 로 쓰면 상호배제가 no-op 이 되고,
//   자동 session_label(ppid-즉사셸)이 훅의 mySession 과 불일치해 소유 세션 자신이 차단(자기 락아웃)된다.
//
// 해법:
//   - 정체성(matching): Claude Code 세션 UUID. CLI 는 env CLAUDE_CODE_SESSION_ID, 훅은 payload.session_id
//     로 동일 값을 본다 — 유일하게 CLI·훅 양쪽에서 일관된 안정 식별자. 이걸 session_label 로 써서
//     자기 락 인식(락아웃 방지) + 다른 세션(다른 UUID) 구분.
//   - liveness(stale 판정): 세션 프로세스 pid. node 의 부모(즉사 셸)의 부모(조부모)가 세션 프로세스
//     (claude/터미널)로 세션 동안 살아있다. ps 로 조부모를 구하고, 실패(Windows 등) 시 process.ppid.

const { spawnSync } = require('child_process');

function sessionPid() {
  const ppid = process.ppid;
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(ppid)], { encoding: 'utf8' });
    if (r.status === 0) {
      const gp = parseInt((r.stdout || '').trim(), 10);
      if (Number.isInteger(gp) && gp > 1) return gp;   // 조부모 = 세션 프로세스
    }
  } catch { /* ps 미지원(Windows 등) — process.ppid 폴백 */ }
  return ppid;
}

// 세션 정체성 라벨. 우선순위: explicit(--session) > $PACT_SESSION > $CLAUDE_CODE_SESSION_ID.
// 하나도 없으면 null(호출부가 ppid 기반 폴백 라벨 구성).
function sessionId(explicit) {
  return explicit || process.env.PACT_SESSION || process.env.CLAUDE_CODE_SESSION_ID || null;
}

module.exports = { sessionPid, sessionId };
