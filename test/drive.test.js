'use strict';

// pact drive — 헤드리스 드라이버 1급 CLI 런처.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACT_BIN = path.join(__dirname, '..', 'bin', 'pact');
function runPact(args, opts) {
  return spawnSync('node', [PACT_BIN, ...args], { encoding: 'utf8', ...opts });
}

test('pact drive --help — 사용법 출력', () => {
  const r = runPact(['drive', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /헤드리스/);
  assert.match(r.stdout, /--real/);
  assert.match(r.stdout, /--pact/);
  // DX-5: --max 는 '사이클당 워커 수'(오도) 가 아니라 driver.mjs 헤더와 정렬된 '동시 슬롯 수 K'.
  assert.match(r.stdout, /--max=N\s+동시 슬롯 수 K \(기본 5\)/);
  // DX-5: 레거시 배치-배리어 탈출구(--no-pipeline)를 --help 에서 발견 가능해야 한다.
  assert.match(r.stdout, /--no-pipeline/);
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

// ─── P2-2 · SPD-1: K-슬롯 풀이 기본 실행 경로 ─────────────────
test('drive — 기본은 K-슬롯 풀 (배치-배리어 아님)', () => {
  const r = runPact(['drive', '--max=2']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /K-슬롯 풀 \(슬롯=2/);       // 파이프라인 경로 로그
  assert.match(r.stdout, /완료 ✓2/);                  // 두 데모 task 완료
  assert.match(r.stdout, /오케스트레이터 토큰: 0/);   // 불변식 유지
});

test('drive --no-pipeline — 레거시 배치-배리어 폴백도 동작(회귀)', () => {
  const r = runPact(['drive', '--no-pipeline', '--max=2']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /레거시 배리어/);            // 폴백 경로 로그
  assert.doesNotMatch(r.stdout, /K-슬롯 풀/);
  assert.match(r.stdout, /완료 ✓2/);
  assert.match(r.stdout, /오케스트레이터 토큰: 0/);
});

// ─── STAB-1 belt: 이중 드라이버 실행 차단 ───────────────────────────────
test('drive --pact — 살아있는 드라이버 소유 중이면 exit 4 (이중 spawn 차단)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-drive-belt-'));
  try {
    // 살아있는 드라이버가 이미 소유 중인 상황을 mock — 테스트 러너 pid(항상 alive) 로 스탬프.
    fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.pact', 'drive-owner.json'),
      JSON.stringify({ pid: process.pid, session: 'other', acquired_at: new Date().toISOString() }),
    );
    // 두 번째 드라이버(--pact) 는 belt 에서 정지 — prepare 도달 전 exit 4.
    const r = runPact(['drive', '--pact', '--max=1'], { cwd: dir });
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /드라이버 이미 실행 중/);
    // 소유권 파일은 그대로(두 번째가 뺏지 않음)
    const held = JSON.parse(fs.readFileSync(path.join(dir, '.pact', 'drive-owner.json'), 'utf8'));
    assert.equal(held.pid, process.pid);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drive (demo, --pact 아님) — belt skip (drive-owner.json 미생성)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-drive-nobelt-'));
  try {
    const r = runPact(['drive', '--max=1'], { cwd: dir });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(fs.existsSync(path.join(dir, '.pact', 'drive-owner.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── DX-1: prepare 실패를 'Command failed' 셸 덤프 대신 actionable fix 로 노출 ───
test('drive --pact (준비 안 된 프로젝트) — prepare 실패 시 stage+fix 노출("Command failed" 덤프 아님)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-drive-dx1-'));
  try {
    // 빈 디렉토리 = CLAUDE.md/tasks/git 없음 → prepare 가 preflight 에서 fix 담긴 JSON emit 후 exit 1.
    const r = runPact(['drive', '--pact', '--max=1'], { cwd: dir });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /preflight/, `실패 stage 가 노출돼야 함:\n${out}`);
    assert.match(out, /pact:init|pact:plan|git 환경 정리/, `actionable fix 가 노출돼야 함:\n${out}`);
    assert.doesNotMatch(out, /Command failed/, `원시 셸 명령 덤프가 아니어야 함:\n${out}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── DX-3: escalation 안내가 salvageable 이면 목적특화 /pact:takeover 를 병기 ───
test('drive escalation — salvageable(부분작업 보존) 은 /pact:takeover 인계를 안내', () => {
  // loop-stuck → 정체 escalate(salvageable). resume 만이 아니라 takeover on-ramp 도 노출돼야 한다.
  const r = runPact(['drive', '--max=1', '--loop=DEMO-001:4', '--loop-stuck=DEMO-001']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /\/pact:takeover DEMO-001/, `salvageable escalation 은 takeover 병기:\n${r.stdout}`);
});

test('drive escalation — non-salvageable 은 /pact:resume 만 안내(takeover 아님)', () => {
  // --fail → 재시도 소진 escalate(부분작업 없음). 인계할 worktree 가 없으니 resume 만.
  const r = runPact(['drive', '--max=1', '--fail=DEMO-001']);
  assert.equal(r.status, 3, r.stdout);
  const esc = r.stdout.split('\n').filter((l) => l.includes('DEMO-001') && l.includes('/pact:'));
  assert.ok(esc.some((l) => /\/pact:resume DEMO-001/.test(l)), `resume 안내가 있어야 함:\n${r.stdout}`);
  assert.ok(!esc.some((l) => /takeover/.test(l)), `non-salvageable 은 takeover 안내 아님:\n${r.stdout}`);
});

// ─── DRV-2: 워커 done ≠ 머지 done — rejected 머지는 done 계상 X + exit 3 ───
test('drive — 머지 rejected 면 워커 done 이어도 done 미계상 + ⛔ 표기 + exit 3', () => {
  // MOCK 머지 게이트가 DEMO-001 을 reject → 워커는 done 이나 base 미반영. DEMO-002 는 정상 머지.
  const r = runPact(['drive', '--max=2', '--merge-reject=DEMO-001']);
  assert.equal(r.status, 3, `미머지(rejected) 존재 → exit 3:\n${r.stdout}`);
  // 완료 카운트는 실제 머지된 1개만 (rejected 는 제외)
  assert.match(r.stdout, /완료 ✓1/, `done 은 머지 성공 1개만:\n${r.stdout}`);
  // DEMO-001 은 done 이 아니라 rejected 로 표기(⛔), DEMO-002 는 done
  assert.doesNotMatch(r.stdout, /DEMO-001.*\[done\]/, `rejected task 를 done 으로 표기하면 안 됨:\n${r.stdout}`);
  assert.match(r.stdout, /DEMO-001.*\[rejected\]/, `rejected 표기:\n${r.stdout}`);
  assert.match(r.stdout, /DEMO-002.*\[done\]/, `머지 성공 task 는 done(=merged→done 경로 방어):\n${r.stdout}`);
});
