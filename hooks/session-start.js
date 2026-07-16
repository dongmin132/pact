#!/usr/bin/env node
'use strict';

// pact session-start hook
// 트리거: SessionStart
// 동작: stale lock 정리 + yolo startup 경고.
//   ※ SessionStart 페이로드에는 permission_mode 필드가 없다(도구 컨텍스트 이벤트에만 존재, H1).
//     과거엔 없는 필드를 읽어 permission_mode:'default' 를 state 에 박아 detect-yolo 의 settings
//     폴백까지 가렸다. 이제 (a) 직전 세션의 stale permission_mode 를 제거하고, (b) settings 기반
//     is_yolo 로 startup 경고만 낸다. 런타임 mode 스탬프는 pre-tool-guard(PreToolUse)가 담당.

const fs = require('fs');
const path = require('path');
const { detectYolo } = require('../scripts/detect-yolo.js');

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();
  const stateDir = path.join(cwd, '.pact');
  if (!fs.existsSync(stateDir)) process.exit(0);  // pact 미초기화 프로젝트 → skip

  // 멀티세션 stale lock 정리 (v0.6.0) — 이전 세션이 비정상 종료해 남긴 lock 일괄 청소.
  let cleanResult = null;
  try {
    const { cleanStaleLocks } = require(path.join(__dirname, '..', 'scripts', 'lock.js'));
    cleanResult = cleanStaleLocks({ cwd });
  } catch { /* skip */ }

  const statePath = path.join(stateDir, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch { /* 새로 생성 */ }

  // H1-2: compact/resume 는 같은 세션 연속 — 런타임 스탬프를 지우면 다음 도구 호출까지 CLI-flag
  // yolo 감지 공백이 생긴다. 새 세션(startup/clear)에서만 stale 런타임 mode 를 리셋한다.
  const source = payload.source || 'startup';
  const freshSession = source === 'startup' || source === 'clear';
  if (freshSession) {
    // 직전 세션이 남긴 런타임 mode 는 새 세션에선 stale — 제거해 detect-yolo 가 오염 없이
    // 판정하게 한다(런타임 값은 이번 세션 첫 도구 호출 때 pre-tool-guard 가 다시 스탬프).
    delete state.permission_mode;
    // startup 경고용 best-effort: state 무시하고 settings(defaultMode) 직행.
    const det = detectYolo({ cwd, ignoreState: true });
    state.is_yolo = det.is_yolo;
    state.yolo_source = det.source;
  }
  // compact/resume: permission_mode·is_yolo 보존(런타임 연속). 아래 메타만 갱신.
  state.session_started_at = new Date().toISOString();
  state.session_id = payload.session_id || null;

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

  const messages = [];

  // settings 가 yolo(defaultMode:bypassPermissions)이면 사용자에게 한 번 경고 (systemMessage).
  // ※ CLI 플래그(--dangerously-skip-permissions)로 켠 yolo 는 SessionStart 페이로드에 신호가
  //    없어 여기서 못 잡는다 — 그 경우 첫 도구 호출 때 pre-tool-guard 스탬프로 감지가 정정된다.
  if (state.is_yolo) {
    messages.push(
      '⚠️ pact: yolo 모드(settings defaultMode:bypassPermissions) 감지. 권한 자동 승인됨. ' +
      '파일 수정·삭제·외부 호출이 묻지 않고 진행됩니다. /pact:abort로 중단 가능.',
    );
  }

  // 락 자가치유 표면화(STAB-5) — 재부팅 후 PID 재사용/24h TTL 로 회수한 경우만 알린다.
  // 평범한 죽은 PID 정리(deadPid)는 노이즈라 조용히 넘어간다(기존 무출력 동작 유지).
  if (cleanResult) {
    const reboot = cleanResult.reclaimedByReboot || [];
    const ttl = cleanResult.reclaimedByTTL || [];
    if (reboot.length || ttl.length) {
      const parts = [];
      if (reboot.length) parts.push(`재부팅 후 PID 재사용 감지 회수(reboot): ${reboot.join(', ')}`);
      if (ttl.length) parts.push(`24h TTL 초과 회수(ttl): ${ttl.join(', ')}`);
      messages.push('🔓 pact: stale 락 자가치유 — ' + parts.join('; '));
    }
  }

  if (messages.length) {
    process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n') }));
  }
  process.exit(0);
}

if (require.main === module) main();
