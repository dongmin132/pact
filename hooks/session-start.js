#!/usr/bin/env node
'use strict';

// pact session-start hook
// 트리거: SessionStart
// 동작: hook payload의 permission_mode를 캡처해 .pact/state.json에 박음.
//       이후 commands가 yolo 여부를 file에서 read 가능.

const fs = require('fs');
const path = require('path');

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
  try {
    const { cleanStaleLocks } = require(path.join(__dirname, '..', 'scripts', 'lock.js'));
    cleanStaleLocks({ cwd });
  } catch { /* skip */ }

  const mode = payload.permission_mode
    || payload.permissionMode
    || (payload.metadata && payload.metadata.permission_mode)
    || 'default';

  const statePath = path.join(stateDir, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch { /* 새로 생성 */ }

  state.permission_mode = mode;
  state.is_yolo = mode === 'bypassPermissions';
  state.session_started_at = new Date().toISOString();
  state.session_id = payload.session_id || null;

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

  // yolo이면 사용자에게 한 번 경고 (systemMessage)
  if (state.is_yolo) {
    const out = {
      systemMessage:
        '⚠️ pact: yolo 모드(bypassPermissions) 감지. 권한 자동 승인됨. ' +
        '파일 수정·삭제·외부 호출이 묻지 않고 진행됩니다. /pact:abort로 중단 가능.',
    };
    process.stdout.write(JSON.stringify(out));
  }
  process.exit(0);
}

if (require.main === module) main();
