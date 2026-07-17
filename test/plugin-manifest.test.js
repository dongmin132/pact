'use strict';

// dogfood 발견 #6·#7 — plugin.json 은 사용자가 받는 배포 표면인데 테스트가 없었다.
// #6: 버전이 package.json 과 어긋난 채 릴리스됨(0.10.0 vs 0.12.0).
// #7: PreToolUse matcher 에 Bash 가 빠져 pre-tool-guard 의 checkBashWrite(Bash 쓰기
//     우회 차단, CLEANUP-029/P1-#4)가 인터랙티브 경로에서 한 번도 발화할 수 없었다 —
//     SDK 쪽 canUseTool shadow 와 동형의 "가드는 있는데 배선이 끊긴" 버그.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const marketplace = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));

test('plugin.json version == package.json version (릴리스 시 함께 bump)', () => {
  assert.equal(manifest.version, pkg.version,
    `plugin.json(${manifest.version}) ≠ package.json(${pkg.version}) — 사용자가 보는 배포 버전이 어긋남`);
});

test('marketplace.json plugin version == plugin.json version (M4 — 3자 버전 일치)', () => {
  const mp = (marketplace.plugins || []).find(p => p.name === 'pact');
  assert.ok(mp, 'marketplace.json 에 pact 플러그인 항목 존재');
  assert.equal(mp.version, manifest.version,
    `marketplace(${mp.version}) ≠ plugin.json(${manifest.version}) — 형제 매니페스트 버전 드리프트`);
});

test('systemMessage 알림 훅은 async 아님 — stdout 이 처리돼 사용자에게 도달 (M1)', () => {
  // async:true 훅은 stdout/exit 무시(fire-and-forget)라 systemMessage 가 사장된다.
  // post-edit-doc-sync·stop-verify·teammate-idle 은 systemMessage 전달이 유일 효과 → async 금지.
  const events = { PostToolUse: 'post-edit-doc-sync', Stop: 'stop-verify', TeammateIdle: 'teammate-idle' };
  for (const [evt, name] of Object.entries(events)) {
    const groups = (manifest.hooks && manifest.hooks[evt]) || [];
    const hooks = groups.flatMap(g => g.hooks || []).filter(h => (h.command || '').includes(name));
    assert.ok(hooks.length, `${evt} 에 ${name} 등록 존재`);
    for (const h of hooks) {
      assert.notEqual(h.async, true, `${name} 은 async:true 면 systemMessage 가 사장됨 (M1)`);
    }
  }
});

test('PreToolUse matcher 에 Bash 포함 — checkBashWrite 배선 (우회 차단이 실제 발화)', () => {
  const pre = (manifest.hooks && manifest.hooks.PreToolUse) || [];
  const guardEntry = pre.find(e => (e.hooks || []).some(h => (h.command || '').includes('pre-tool-guard')));
  assert.ok(guardEntry, 'pre-tool-guard PreToolUse 등록 존재');
  const tools = String(guardEntry.matcher || '').split('|');
  for (const t of ['Read', 'Write', 'Edit', 'Bash']) {
    assert.ok(tools.includes(t), `matcher 에 ${t} 필요 — 현재: ${guardEntry.matcher}`);
  }
});
