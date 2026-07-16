'use strict';

// H3-2 — 락 소유자 정체성 재설계(적대검증 확인).
// 결함: (A) 폴백 process.ppid 가 Claude Code Bash 도구에서 호출별 즉사 zsh 라 락이 즉시 stale,
//   (B) 자동 session_label(ppid-즉사셸)이 훅의 mySession 과 불일치해 소유 세션 자신의 Edit 를 deny.
// 해법: 세션 UUID(CLI=env CLAUDE_CODE_SESSION_ID, 훅=payload.session_id)를 라벨로 통일 —
//   CLI 가 건 락을 훅이 자기 것으로 인식(자기 락아웃 방지), 다른 세션(다른 UUID)과 구분.
//   liveness pid 는 조부모(세션 프로세스)로 잡아 명령 종료 후에도 살아있게 한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { sessionPid, sessionId } = require('../scripts/lib/session-pid.js');
const { lockPath, isAlive, acquireLock } = require('../scripts/lock.js');
const { acquireEditLock, lockFile } = require('../scripts/edit-lock.js');

const PACT_BIN = path.join(__dirname, '..', 'bin', 'pact');
const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-guard.js');

function tmpProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-lock-id-'));
  fs.mkdirSync(path.join(d, '.pact'), { recursive: true });
  return d;
}

// --- session-pid 헬퍼 ---

test('sessionId — explicit > PACT_SESSION > CLAUDE_CODE_SESSION_ID', () => {
  const save = { p: process.env.PACT_SESSION, c: process.env.CLAUDE_CODE_SESSION_ID };
  try {
    delete process.env.PACT_SESSION; delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.equal(sessionId('EXPLICIT'), 'EXPLICIT');
    process.env.CLAUDE_CODE_SESSION_ID = 'CC-UUID';
    assert.equal(sessionId(null), 'CC-UUID');
    process.env.PACT_SESSION = 'PS';
    assert.equal(sessionId(null), 'PS');
  } finally {
    if (save.p == null) delete process.env.PACT_SESSION; else process.env.PACT_SESSION = save.p;
    if (save.c == null) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = save.c;
  }
});

test('sessionPid — node 의 조부모(세션 프로세스)를 반환, 양의 정수', () => {
  const sp = sessionPid();
  assert.ok(Number.isInteger(sp) && sp > 0, `sessionPid 는 양의 정수여야 함 — ${sp}`);
  // 이 테스트 러너가 살아있는 동안 조부모(러너를 띄운 셸)도 살아있다.
  assert.ok(isAlive(sp), 'sessionPid 는 종료 즉시 죽는 pid 가 아니어야 함(조부모=세션 수명)');
});

// --- claim CLI: 락 holder 는 살아있고 session_label 은 세션 UUID ---

test('pact claim — 락 holder pid 는 CLI 종료 후에도 alive(조부모), 라벨은 세션 UUID', () => {
  const d = tmpProject();
  try {
    fs.mkdirSync(path.join(d, '.pact', 'runs', 'AUTH-1'), { recursive: true });
    const r = spawnSync('node', [PACT_BIN, 'claim', 'AUTH-1', '--json'], {
      cwd: d, encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'SESS-XYZ', PACT_SESSION: '', PACT_OWNER_PID: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    const holder = JSON.parse(fs.readFileSync(lockPath(d, 'AUTH-1'), 'utf8'));
    assert.ok(isAlive(holder.pid), 'holder.pid 는 CLI 종료 후에도 alive 여야 함(조부모 세션 pid)');
    assert.equal(holder.session_label, 'SESS-XYZ', 'session_label 은 세션 UUID 여야 함');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// --- 자기 락아웃 회귀 방지: 훅이 자기 세션 UUID 의 edit-lock 을 통과시킨다 ---

function runHook(payload, cwd, extraEnv) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd,
    env: { ...process.env, ...extraEnv },
  });
}

test('pre-tool-guard — 자기 세션(payload.session_id 일치) edit-lock 은 Edit 통과 (자기 락아웃 방지)', () => {
  const d = tmpProject();
  try {
    // 세션 SESS-1 이 PROGRESS.md 를 edit-lock (pid=alive)
    const r = acquireEditLock('PROGRESS.md', { cwd: d, sessionLabel: 'SESS-1', pid: process.pid });
    assert.equal(r.ok, true);
    // 같은 세션(payload.session_id=SESS-1)이 그 파일을 Edit → deny 안 됨
    const out = runHook({ tool_name: 'Edit', tool_input: { file_path: 'PROGRESS.md' }, cwd: d, session_id: 'SESS-1' },
      d, { PACT_SESSION: '', CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /deny/, '자기 세션의 락은 자기 Edit 를 막으면 안 됨');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('acquireLock — 같은 세션(live pid) 재획득은 멱등 허용 (자기 재claim 24h TTL 차단 회귀 방지)', () => {
  const d = tmpProject();
  try {
    fs.mkdirSync(path.join(d, '.pact', 'runs', 'API-1'), { recursive: true });
    const a = acquireLock('API-1', { cwd: d, sessionLabel: 'SESS-1', pid: process.pid });
    assert.equal(a.ok, true);
    assert.equal(a.action, 'fresh');
    // 같은 세션이 살아있는 락을 재획득 — 거부 아니라 re-acquire
    const b = acquireLock('API-1', { cwd: d, sessionLabel: 'SESS-1', pid: process.pid });
    assert.equal(b.ok, true, '자기 세션 재획득은 허용돼야 함');
    assert.equal(b.action, 're-acquire');
    // 다른 세션은 여전히 거부
    const c = acquireLock('API-1', { cwd: d, sessionLabel: 'SESS-2', pid: process.pid });
    assert.equal(c.ok, false, '다른 세션은 live 락에 거부');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pre-tool-guard — 다른 세션(payload.session_id 불일치) edit-lock 은 Edit deny (상호배제 유지)', () => {
  const d = tmpProject();
  try {
    const r = acquireEditLock('PROGRESS.md', { cwd: d, sessionLabel: 'SESS-1', pid: process.pid });
    assert.equal(r.ok, true);
    const out = runHook({ tool_name: 'Edit', tool_input: { file_path: 'PROGRESS.md' }, cwd: d, session_id: 'SESS-2' },
      d, { PACT_SESSION: '', CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /deny/, '다른 세션의 락은 Edit 를 차단해야 함');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
