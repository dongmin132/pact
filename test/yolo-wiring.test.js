'use strict';

// H1 회귀 — yolo 자동감지 체인 배선.
// 결함: SessionStart 페이로드에는 permission_mode 필드가 없다(도구 컨텍스트 이벤트에만 존재).
// 과거 session-start.js 는 없는 필드를 읽어 항상 permission_mode:'default'/is_yolo:false 를
// state.json 에 박았고, 이 오염된 state 가 detect-yolo 의 settings 폴백(defaultMode:bypass)까지
// 가려 yolo 경고·감지가 영구 무력화됐다.
// 수리: (a) session-start 는 오염 스탬프 중단 + settings 기반 startup 경고, (b) 런타임 mode 는
// pre-tool-guard(PreToolUse)가 state 에 스탬프, (c) detect-yolo 에 ignoreState 옵션.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { detectYolo } = require('../scripts/detect-yolo.js');

const SESSION_START = path.join(__dirname, '..', 'hooks', 'session-start.js');
const PRE_TOOL_GUARD = path.join(__dirname, '..', 'hooks', 'pre-tool-guard.js');

function pactRepo({ settingsYolo = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-yolo-wire-'));
  fs.mkdirSync(path.join(d, '.pact'), { recursive: true });
  if (settingsYolo) {
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  }
  return d;
}

function runHook(hookPath, payload, cwd) {
  return spawnSync('node', [hookPath], { input: JSON.stringify(payload), encoding: 'utf8', cwd });
}

function readState(d) {
  try { return JSON.parse(fs.readFileSync(path.join(d, '.pact', 'state.json'), 'utf8')); }
  catch { return {}; }
}

test('detect-yolo — ignoreState 는 state 를 건너뛰고 settings 를 본다', () => {
  const d = pactRepo({ settingsYolo: true });
  try {
    // 오염된 state: permission_mode:'default' (과거 session-start 가 박던 값)
    fs.writeFileSync(path.join(d, '.pact', 'state.json'),
      JSON.stringify({ permission_mode: 'default', is_yolo: false }));
    const r = detectYolo({ cwd: d, ignoreState: true });
    assert.equal(r.is_yolo, true, 'ignoreState 면 settings 의 bypassPermissions 를 감지해야 함');
    assert.match(r.source, /settings/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('session-start — SessionStart 페이로드(permission_mode 없음)에서 오염 스탬프 안 함', () => {
  const d = pactRepo({ settingsYolo: false });
  try {
    // SessionStart 실페이로드: permission_mode 없음
    const r = runHook(SESSION_START, { session_id: 's1', cwd: d, hook_event_name: 'SessionStart', source: 'startup' }, d);
    assert.equal(r.status, 0, r.stderr);
    const st = readState(d);
    // 핵심: 없는 필드를 'default' 로 박아 settings 폴백을 가리면 안 된다.
    assert.notEqual(st.permission_mode, 'default', 'session-start 가 permission_mode:default 오염 스탬프를 남기면 안 됨');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('session-start — settings 가 yolo 면 startup 경고를 내고 is_yolo 를 안 가린다', () => {
  const d = pactRepo({ settingsYolo: true });
  try {
    const r = runHook(SESSION_START, { session_id: 's1', cwd: d, hook_event_name: 'SessionStart', source: 'startup' }, d);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /yolo|bypassPermissions/i, 'settings yolo 면 세션 시작 경고가 나와야 함');
    // 그리고 detect-yolo 가 state 오염에 가려지지 않아야 한다
    const det = detectYolo({ cwd: d });
    assert.equal(det.is_yolo, true, 'session-start 후에도 yolo 감지가 유지돼야 함(오염 무)');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pre-tool-guard — PreToolUse permission_mode 를 state 에 스탬프(런타임 권위)', () => {
  const d = pactRepo({ settingsYolo: false });
  try {
    fs.writeFileSync(path.join(d, 'README.md'), '# t\n');
    const r = runHook(PRE_TOOL_GUARD, {
      tool_name: 'Read', tool_input: { file_path: 'README.md' },
      cwd: d, permission_mode: 'bypassPermissions',
    }, d);
    assert.equal(r.status, 0, r.stderr);
    const st = readState(d);
    assert.equal(st.permission_mode, 'bypassPermissions', 'PreToolUse 가 런타임 mode 를 state 에 스탬프해야 함');
    assert.equal(st.is_yolo, true);
    // 그 결과 detect-yolo 가 런타임 yolo 를 정확히 보고
    assert.equal(detectYolo({ cwd: d }).is_yolo, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pre-tool-guard — 비-pact 리포(.pact 없음)에서는 state 스탬프 안 함(무해)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-nonpact-'));
  try {
    fs.writeFileSync(path.join(d, 'README.md'), '# t\n');
    const r = runHook(PRE_TOOL_GUARD, {
      tool_name: 'Read', tool_input: { file_path: 'README.md' },
      cwd: d, permission_mode: 'bypassPermissions',
    }, d);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(d, '.pact', 'state.json')), '비-pact 리포엔 state.json 을 만들면 안 됨');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
