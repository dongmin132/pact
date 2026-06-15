'use strict';

// pact drive — 헤드리스 드라이버 1급 CLI 런처.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const PACT_BIN = path.join(__dirname, '..', 'bin', 'pact');
function runPact(args) {
  return spawnSync('node', [PACT_BIN, ...args], { encoding: 'utf8' });
}

test('pact drive --help — 사용법 출력', () => {
  const r = runPact(['drive', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /헤드리스/);
  assert.match(r.stdout, /--real/);
  assert.match(r.stdout, /--pact/);
});

test('pact drive (mock demo) — 오케스트레이터 토큰 0 으로 동작', () => {
  const r = runPact(['drive', '--max=1']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /오케스트레이터 토큰: 0/);
});

test('pact (인자 없음) usage 에 drive 노출', () => {
  const r = runPact([]);
  assert.match(r.stderr, /drive/);
});
