'use strict';

// H3 회귀 테스트 — pact claim / edit-lock 이 세션 수명 pid(부모 셸)를 락 holder 로
// 기록하는지 검증. 과거엔 단명 CLI process.pid 를 기록해 명령 반환 즉시 dead-pid stale
// 이 됐고, 멀티세션 상호배제(pact claim 차단 · edit-lock pre-tool-guard deny)가 전량
// no-op 이 됐다. 자식으로 CLI 를 스폰하면 자식의 process.ppid == 이 테스트 러너 pid 라,
// CLI 종료 후에도 holder.pid 는 살아있어야 한다(= 러너 pid, isAlive true).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { isAlive, lockPath } = require('../scripts/lock.js');
const { lockFile } = require('../scripts/edit-lock.js');

const PACT_BIN = path.join(__dirname, '..', 'bin', 'pact');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-claim-pid-'));
  fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
  return dir;
}

function runCli(args, cwd) {
  // 자식 node 프로세스: 자식의 부모(ppid)는 이 테스트 러너다.
  return spawnSync('node', [PACT_BIN, ...args], { cwd, encoding: 'utf8' });
}

test('pact claim — 락 holder 는 세션 수명 pid(러너)라 CLI 종료 후에도 살아있다', () => {
  const dir = tmpProject();
  try {
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'AUTH-1'), { recursive: true });
    const r = runCli(['claim', 'AUTH-1', '--json'], dir);
    assert.equal(r.status, 0, `claim 실패: ${r.stderr}`);

    const holder = JSON.parse(fs.readFileSync(lockPath(dir, 'AUTH-1'), 'utf8'));
    // 핵심: CLI 자식이 종료됐어도 holder.pid 는 살아있어야 한다(세션 수명 = 러너).
    assert.equal(holder.pid, process.pid, 'holder.pid 는 자식의 ppid(=러너 pid)여야 함');
    assert.ok(isAlive(holder.pid), 'holder.pid 는 CLI 종료 후에도 alive 여야 함(단명 pid 금지)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact edit-lock — 락 holder 는 세션 수명 pid 라 종료 후 alive + findLockForFile 이 발견', () => {
  const dir = tmpProject();
  try {
    const r = runCli(['edit-lock', 'PROGRESS.md', '--json'], dir);
    assert.equal(r.status, 0, `edit-lock 실패: ${r.stderr}`);

    const holder = JSON.parse(fs.readFileSync(lockFile(dir, 'PROGRESS.md'), 'utf8'));
    assert.equal(holder.pid, process.pid, 'holder.pid 는 자식의 ppid(=러너 pid)여야 함');
    assert.ok(isAlive(holder.pid), 'edit-lock holder.pid 는 종료 후에도 alive 여야 함');

    // 배선 검증: alive 해야 findLockForFile 이 잡아 pre-tool-guard 가 다른 세션을 deny 할 수 있다.
    const { findLockForFile } = require('../scripts/edit-lock.js');
    const hit = findLockForFile(path.join(dir, 'PROGRESS.md'), { cwd: dir });
    assert.ok(hit, 'alive 락은 findLockForFile 로 발견돼야 함(deny 도달 가능)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pact claim --owner-pid — 명시적 owner pid 를 존중', () => {
  const dir = tmpProject();
  try {
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'API-2'), { recursive: true });
    const r = runCli(['claim', 'API-2', '--owner-pid', String(process.pid), '--json'], dir);
    assert.equal(r.status, 0, `claim 실패: ${r.stderr}`);
    const holder = JSON.parse(fs.readFileSync(lockPath(dir, 'API-2'), 'utf8'));
    assert.equal(holder.pid, process.pid, '--owner-pid 로 준 값이 holder.pid 여야 함');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
