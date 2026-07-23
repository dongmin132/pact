'use strict';

// 훅 스모크 테스트 — 커버리지 없던 훅 4종(teammate-idle / progress-check / post-edit-doc-sync /
// subagent-stop-review)을 spawnSync + JSON stdin 픽스처로 검증한다. 목표: 유효 payload 에서
// crash 없이 exit 0 + 출력 shape({systemMessage} 또는 무출력). 훅은 읽기만(수정 X).
// ※ session-start.js / pre-tool-guard.js 는 다른 트랙이 수정 중이라 여기서 제외.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');

function runHook(hookFile, payload, opts = {}) {
  return spawnSync('node', [path.join(HOOKS, hookFile)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    ...opts,
  });
}

// stdout 이 있으면 {systemMessage:string} 형태여야 한다(hook 출력 계약).
function assertSystemMessage(r, re) {
  assert.equal(r.status, 0, `exit 0 이어야 함: ${r.stdout}\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.equal(typeof j.systemMessage, 'string');
  if (re) assert.match(j.systemMessage, re);
}
function assertNoOutput(r) {
  assert.equal(r.status, 0, `exit 0 이어야 함: ${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout.trim(), '', `무출력이어야 함, got: ${r.stdout}`);
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function backdate(p, secsAgo) {
  const t = Math.floor(Date.now() / 1000) - secsAgo;
  fs.utimesSync(p, t, t);
}

// ─── teammate-idle.js ───────────────────────────────────────────────
test('teammate-idle — 잘못된 stdin 이어도 crash 없이 exit 0', () => {
  const r = runHook('teammate-idle.js', 'not-json{{');
  assertNoOutput(r);
});

test('teammate-idle — .pact/runs 없으면 조용히 exit 0', () => {
  const dir = tmp('pact-tmi-none-');
  try {
    assertNoOutput(runHook('teammate-idle.js', { cwd: dir }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('teammate-idle — 5분 넘게 stuck 인 워커면 systemMessage 알림', () => {
  const dir = tmp('pact-tmi-stuck-');
  try {
    const taskDir = path.join(dir, '.pact', 'runs', 'TASK-1');
    fs.mkdirSync(taskDir, { recursive: true });
    const p = path.join(taskDir, 'payload.json');
    fs.writeFileSync(p, JSON.stringify({ task_id: 'TASK-1' }));
    backdate(p, 400); // 400s > 300s 임계
    assertSystemMessage(runHook('teammate-idle.js', { cwd: dir }), /대기|5분|TASK-1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── progress-check.js ──────────────────────────────────────────────
test('progress-check — PROGRESS.md 없으면 조용히 exit 0', () => {
  const dir = tmp('pact-pc-none-');
  try {
    assertNoOutput(runHook('progress-check.js', { cwd: dir }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('progress-check — PROGRESS.md 가 코드보다 오래되면 갱신 알림', () => {
  const dir = tmp('pact-pc-stale-');
  try {
    const pf = path.join(dir, 'PROGRESS.md');
    fs.writeFileSync(pf, '# progress\n');
    backdate(pf, 2 * 60 * 60); // 2h 전 → oneHourAgo 보다 오래됨
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); // src mtime = now(최신)
    assertSystemMessage(runHook('progress-check.js', { cwd: dir }), /PROGRESS\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── post-edit-doc-sync.js ──────────────────────────────────────────
test('post-edit-doc-sync — 코드 Write + PROGRESS.md 존재 시 doc-sync 알림', () => {
  const dir = tmp('pact-pes-code-');
  try {
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '# p\n');
    const payload = { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'foo.js') }, cwd: dir };
    assertSystemMessage(runHook('post-edit-doc-sync.js', payload), /코드 변경 감지|PROGRESS/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('post-edit-doc-sync — 비-코드 파일(.md)은 무출력', () => {
  const dir = tmp('pact-pes-doc-');
  try {
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '# p\n');
    const payload = { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'notes.md') }, cwd: dir };
    assertNoOutput(runHook('post-edit-doc-sync.js', payload));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('post-edit-doc-sync — Write/Edit 아닌 도구는 무출력', () => {
  const r = runHook('post-edit-doc-sync.js', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assertNoOutput(r);
});

// ─── subagent-stop-review.js ────────────────────────────────────────
// ※ 실제 SubagentStop 페이로드 필드는 agent_type(플러그인 스코프면 'pact:worker'). M0 수리 회귀.
test('subagent-stop-review — worker 아닌 서브에이전트는 무출력', () => {
  const r = runHook('subagent-stop-review.js', { agent_type: 'reviewer', cwd: os.tmpdir() });
  assertNoOutput(r);
});

test('subagent-stop-review — agent_type=worker 가 status.json 없이 종료하면 경고 (M0)', () => {
  const dir = tmp('pact-ssr-nostatus-');
  try {
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-1'), { recursive: true });
    assertSystemMessage(runHook('subagent-stop-review.js', { agent_type: 'worker', cwd: dir }), /status\.json 없이|blocked/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('subagent-stop-review — 플러그인 스코프 agent_type=pact:worker 도 매치 (M0)', () => {
  const dir = tmp('pact-ssr-scoped-');
  try {
    fs.mkdirSync(path.join(dir, '.pact', 'runs', 'TASK-1'), { recursive: true });
    assertSystemMessage(runHook('subagent-stop-review.js', { agent_type: 'pact:worker', cwd: dir }), /status\.json 없이|blocked/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('subagent-stop-review — 정상 status.json 이면 무출력(회귀)', () => {
  const dir = tmp('pact-ssr-ok-');
  try {
    const taskDir = path.join(dir, '.pact', 'runs', 'TASK-1');
    fs.mkdirSync(taskDir, { recursive: true });
    const status = {
      task_id: 'TASK-1', status: 'done', summary: 'ok',
      files_changed: ['src/a.js'], commits_made: 1,
      files_attempted_outside_scope: [],
    };
    fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(status));
    assertNoOutput(runHook('subagent-stop-review.js', { agent_type: 'worker', cwd: dir }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
