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

test('plugin.json version == package.json version (릴리스 시 함께 bump)', () => {
  assert.equal(manifest.version, pkg.version,
    `plugin.json(${manifest.version}) ≠ package.json(${pkg.version}) — 사용자가 보는 배포 버전이 어긋남`);
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
