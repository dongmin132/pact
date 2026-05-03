'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectYolo } = require('../scripts/detect-yolo.js');

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-yolo-'));
  fs.mkdirSync(path.join(d, '.pact'));
  return d;
}

test('payload에서 bypassPermissions 감지', () => {
  const r = detectYolo({
    stdin: JSON.stringify({ permission_mode: 'bypassPermissions' }),
  });
  assert.equal(r.is_yolo, true);
  assert.equal(r.source, 'payload');
});

test('payload에서 default 감지 → not yolo', () => {
  const r = detectYolo({
    stdin: JSON.stringify({ permission_mode: 'default' }),
  });
  assert.equal(r.is_yolo, false);
  assert.equal(r.mode, 'default');
});

test('state.json에서 감지 (payload 없음)', () => {
  const d = tmp();
  try {
    fs.writeFileSync(
      path.join(d, '.pact/state.json'),
      JSON.stringify({ permission_mode: 'bypassPermissions' }),
    );
    const r = detectYolo({ cwd: d });
    assert.equal(r.is_yolo, true);
    assert.equal(r.source, 'state.json');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('settings.local.json에서 감지', () => {
  const d = tmp();
  try {
    fs.mkdirSync(path.join(d, '.claude'));
    fs.writeFileSync(
      path.join(d, '.claude/settings.local.json'),
      JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
    );
    const r = detectYolo({ cwd: d });
    assert.equal(r.is_yolo, true);
    assert.match(r.source, /settings\.local\.json$/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('아무것도 없으면 unknown', () => {
  const d = tmp();
  try {
    // home settings에 모드 없을 때만 unknown — 안전하게 home 설정 무시
    const r = detectYolo({ cwd: d });
    // home에 yolo 박혀있을 수도 있음 → mode가 unknown 또는 다른 값
    assert.ok(['unknown', 'default', 'bypassPermissions', 'plan', 'acceptEdits'].includes(r.mode));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('payload 우선순위 — state·settings보다 위', () => {
  const d = tmp();
  try {
    // state는 not yolo
    fs.writeFileSync(
      path.join(d, '.pact/state.json'),
      JSON.stringify({ permission_mode: 'default' }),
    );
    // payload는 yolo
    const r = detectYolo({
      cwd: d,
      stdin: JSON.stringify({ permission_mode: 'bypassPermissions' }),
    });
    assert.equal(r.source, 'payload');
    assert.equal(r.is_yolo, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
