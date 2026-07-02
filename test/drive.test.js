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

test('drive — 기본 병렬폭 5 (--max 미지정, prepare 상한과 정합)', () => {
  const r = runPact(['drive']);        // --max 없음 → 기본값 사용
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /max=5/);     // 헤더가 기본 병렬폭 5 를 보고
  assert.match(r.stdout, /오케스트레이터 토큰: 0/);
});

test('pact (인자 없음) usage 에 drive 노출', () => {
  const r = runPact([]);
  assert.match(r.stderr, /drive/);
});

test('drive loop — 카운트 감소로 done', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:6', '--loop-step=2']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /DEMO-001.*\[done\]/);   // 6→4→2→0, 3 iteration
  assert.match(r.stdout, /오케스트레이터 토큰: 0/);
});

test('drive loop — 정체면 escalate(no-progress)', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:6', '--loop-stuck=DEMO-001']);
  assert.equal(r.status, 3, r.stdout);            // escalation → exit 3
  assert.match(r.stdout, /DEMO-001.*\[escalated\]/);
  assert.match(r.stdout, /정체|no-progress/);
});

test('drive loop — max_iterations 도달 escalate', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:100', '--loop-step=1', '--loop-max=3']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /max_iterations/);
});

test('drive loop — budget 소진 escalate', () => {
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:100', '--loop-step=1', '--cost=5', '--budget=8']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /budget|예산/);
});

test('drive — loop_until 없는 일반 task는 기존 경로(회귀)', () => {
  const r = runPact(['drive', '--max=1']);          // loop 플래그 없음
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /DEMO-001.*\[done\]/);
});
