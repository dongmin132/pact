'use strict';

// PACT-028 — Merge coordinator 단위 테스트
// 실제 git 명령 호출. 임시 repo 사용.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { createWorktree, removeWorktree } = require('../scripts/worktree-manager.js');
const {
  mergeWorktree,
  mergeAll,
  abortMerge,
  planMerge,
} = require('../scripts/merge-coordinator.js');

function sh(cmd, opts) {
  return execSync(cmd, { stdio: 'ignore', shell: true, ...opts });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-merge-'));
  sh('git init -b main', { cwd: dir });
  sh('git config user.email t@t.t && git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
  sh('git add . && git commit -m init', { cwd: dir });
  return dir;
}

function cleanupRepo(dir) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: dir, encoding: 'utf8' });
    const wts = out.split('\n').filter(l => l.startsWith('worktree '));
    for (const l of wts) {
      const wt = l.replace('worktree ', '').trim();
      if (wt !== dir) {
        try { sh(`git worktree remove --force "${wt}"`, { cwd: dir }); } catch {}
      }
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

/** worktree 만들고 거기서 파일 변경·commit */
function workInWorktree(repo, taskId, file, content, msg = 'work') {
  const r = createWorktree(taskId, 'main', { cwd: repo });
  if (!r.ok) throw new Error(`createWorktree failed: ${r.error}`);
  const wtAbs = r.abs_path;
  fs.writeFileSync(path.join(wtAbs, file), content);
  sh(`git add . && git commit -m "${msg}"`, { cwd: wtAbs });
  return r;
}

test('mergeWorktree — 충돌 없는 변경 머지 성공', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A content\n');
    const r = mergeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
  } finally { cleanupRepo(repo); }
});

test('mergeWorktree — 충돌 발생 시 ok:false + 충돌 파일 보고', () => {
  const repo = makeRepo();
  try {
    // main에 conflict.txt 만들고 commit
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'main version\n');
    sh('git add . && git commit -m "main change"', { cwd: repo });

    // worktree에서 같은 파일 다른 내용으로 변경 (base가 main이지만 main 이후 또 변경됨)
    // → 단순히 같은 파일 변경만으론 충돌 안 남. main이 worker 분기 후 변경되어야 함.
    // 그래서 worker 먼저 만들고, main에서 추가 commit, 머지 시도
    workInWorktree(repo, 'TEST-001', 'shared.txt', 'worker line\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main line\n');
    sh('git add . && git commit -m "main shared"', { cwd: repo });

    const r = mergeWorktree('TEST-001', { cwd: repo });
    assert.equal(r.ok, false);
    assert.ok(r.conflicted_files && r.conflicted_files.length > 0);

    // 머지 abort로 정리
    abortMerge({ cwd: repo });
  } finally { cleanupRepo(repo); }
});

test('mergeWorktree — 존재하지 않는 task_id 거부', () => {
  const repo = makeRepo();
  try {
    const r = mergeWorktree('NONE-001', { cwd: repo });
    assert.equal(r.ok, false);
  } finally { cleanupRepo(repo); }
});

test('mergeAll — 충돌 없는 다수 worktree 모두 머지', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A\n');
    workInWorktree(repo, 'TEST-002', 'b.txt', 'B\n');
    workInWorktree(repo, 'TEST-003', 'c.txt', 'C\n');

    const r = mergeAll(['TEST-001', 'TEST-002', 'TEST-003'], { cwd: repo });
    assert.equal(r.merged.length, 3);
    assert.equal(r.conflicted, null);
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'c.txt')));
  } finally { cleanupRepo(repo); }
});

test('mergeAll — 충돌 시 즉시 stop, 이후 task는 untouched', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A\n');
    // TEST-002는 main과 충돌하도록
    workInWorktree(repo, 'TEST-002', 'shared.txt', 'worker\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n');
    sh('git add . && git commit -m "main"', { cwd: repo });

    workInWorktree(repo, 'TEST-003', 'c.txt', 'C\n');

    const r = mergeAll(['TEST-001', 'TEST-002', 'TEST-003'], { cwd: repo });
    assert.equal(r.merged.length, 1, 'TEST-001만 성공');
    assert.equal(r.merged[0], 'TEST-001');
    assert.ok(r.conflicted, '충돌 정보 있어야 함');
    assert.equal(r.conflicted.task_id, 'TEST-002');
    assert.deepEqual(r.skipped, ['TEST-003']);

    abortMerge({ cwd: repo });
  } finally { cleanupRepo(repo); }
});

test('abortMerge — 충돌 상태 정리', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'shared.txt', 'worker\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n');
    sh('git add . && git commit -m "main"', { cwd: repo });

    mergeWorktree('TEST-001', { cwd: repo });  // 충돌
    const r = abortMerge({ cwd: repo });
    assert.equal(r.ok, true);

    // 정리됨 — git status는 clean이어야 함
    const status = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
    assert.equal(status.trim(), '');
  } finally { cleanupRepo(repo); }
});

// ─── 버그 #6: branch 없음을 충돌로 오분류 X (재진입 안전) ──────────
test('mergeAll — branch 없는 task(이미 머지+정리됨)는 충돌 아니라 already_merged, 진행 계속', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TEST-001', 'a.txt', 'A\n');   // 정상 브랜치
    // TEST-002: 브랜치 없음 (이전 cycle 머지 후 branch -D 된 상황). createWorktree 안 함.
    workInWorktree(repo, 'TEST-003', 'c.txt', 'C\n');   // 정상 브랜치

    const r = mergeAll(['TEST-001', 'TEST-002', 'TEST-003'], { cwd: repo });
    assert.equal(r.conflicted, null, 'branch 없음을 충돌로 오분류하면 안 됨');
    assert.deepEqual(r.merged.sort(), ['TEST-001', 'TEST-003'], '나머지는 정상 머지');
    assert.deepEqual(r.already_merged, ['TEST-002'], 'branch 없는 건 already_merged');
    assert.deepEqual(r.skipped, [], 'stop 안 했으니 skipped 없음');
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'c.txt')));
  } finally { cleanupRepo(repo); }
});

test('mergeWorktree — branch 없으면 ok:false + branch_missing 플래그 (계약 유지)', () => {
  const repo = makeRepo();
  try {
    const r = mergeWorktree('NONE-001', { cwd: repo });
    assert.equal(r.ok, false);
    assert.equal(r.branch_missing, true, 'branch 없음 구분 플래그');
  } finally { cleanupRepo(repo); }
});

// ─── STR-5 (P3-A): planMerge co-located here (was bin/cmds/merge.js) ──────────
// 순수 검증 코어를 새 home(scripts) 에서 직접 커버. 동작 불변 회귀 안전망.

/** .pact/runs/<id> 에 valid status.json + payload.json + report.md 작성(스키마 준수). */
function writeRun(repo, taskId, { file, allowedPaths, filesChanged, statusOverride = {}, payloadOverride = {} }) {
  const runDir = path.join(repo, '.pact', 'runs', taskId);
  fs.mkdirSync(runDir, { recursive: true });
  const status = {
    task_id: taskId,
    status: 'done',
    branch_name: `pact/${taskId}`,
    commits_made: 1,
    clean_for_merge: true,
    files_changed: filesChanged !== undefined ? filesChanged : [file],
    files_attempted_outside_scope: [],
    verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
    tdd_evidence: { red_observed: false, green_observed: false },
    decisions: [],
    blockers: [],
    tokens_used: 100,
    completed_at: new Date().toISOString(),
    ...statusOverride,
  };
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(status, null, 2));
  fs.writeFileSync(path.join(runDir, 'payload.json'), JSON.stringify({
    task_id: taskId,
    allowed_paths: allowedPaths !== undefined ? allowedPaths : [file],
    base_branch: 'main',
    ...payloadOverride,
  }, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.md'), `# ${taskId} report\n\nsim\n`);
  return runDir;
}

test('planMerge — 완전한 done task 는 eligible (git diff = files_changed ⊆ allowed_paths)', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'PM-001', 'a.txt', 'A\n');
    writeRun(repo, 'PM-001', { file: 'a.txt', allowedPaths: ['a.txt'] });
    const plan = planMerge({ cwd: repo, taskIds: ['PM-001'] });
    assert.deepEqual(plan.eligible, ['PM-001'], JSON.stringify(plan));
    assert.deepEqual(plan.rejected, []);
  } finally { cleanupRepo(repo); }
});

test('planMerge — runs_dir 없으면 missing:runs_dir', () => {
  const repo = makeRepo();
  try {
    const plan = planMerge({ cwd: repo });
    assert.equal(plan.missing, 'runs_dir');
    assert.deepEqual(plan.eligible, []);
  } finally { cleanupRepo(repo); }
});

test('planMerge — status.json 없으면 reject', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.pact', 'runs', 'PM-002'), { recursive: true });
    const plan = planMerge({ cwd: repo, taskIds: ['PM-002'] });
    assert.deepEqual(plan.eligible, []);
    assert.equal(plan.rejected.length, 1);
    assert.match(plan.rejected[0].reason, /status\.json missing/);
  } finally { cleanupRepo(repo); }
});

test('planMerge — files_changed 보고 ≠ 실제 diff 면 reject (워커 거짓 보고)', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'PM-003', 'a.txt', 'A\n');
    // 실제 diff 는 a.txt 인데 files_changed 를 b.txt 로 거짓 보고 + allowed_paths 는 둘 다 허용.
    writeRun(repo, 'PM-003', { file: 'a.txt', allowedPaths: ['*.txt'], filesChanged: ['b.txt'] });
    const plan = planMerge({ cwd: repo, taskIds: ['PM-003'] });
    assert.deepEqual(plan.eligible, []);
    assert.match(plan.rejected[0].reason, /files_changed 보고.*≠ 실제 diff/);
  } finally { cleanupRepo(repo); }
});

// H8-2: 수동 충돌해결·커밋 후 branch 가 이미 base 에 머지된 경우 — 3-dot diff 가 비어 files_changed
// 와 어긋나 거짓 rejected 를 내던 문제. 이미 머지됨(=base 조상)이면 already_merged 로 통과해야 한다.
test('planMerge — 이미 base 에 머지된 branch(수동 해결 후)는 rejected 아니라 eligible (H8-2)', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'PM-901', 'a.txt', 'A\n');
    writeRun(repo, 'PM-901', { file: 'a.txt', allowedPaths: ['a.txt'] });
    // 수동 해결 시뮬: branch 를 main 에 머지(충돌 없이)하고 branch 는 남겨둠.
    sh('git merge --no-ff -m "pact: resolve merge conflict for PM-901" pact/PM-901', { cwd: repo });
    const plan = planMerge({ cwd: repo, taskIds: ['PM-901'] });
    assert.deepEqual(plan.rejected, [], `이미 머지된 branch 를 거부하면 안 됨 — ${JSON.stringify(plan.rejected)}`);
    assert.deepEqual(plan.eligible, ['PM-901']);
  } finally { cleanupRepo(repo); }
});

test('mergeWorktree — 이미 머지된 branch 는 already_merged (재머지 no-op, H8-2)', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'PM-902', 'a.txt', 'A\n');
    sh('git merge --no-ff -m "manual" pact/PM-902', { cwd: repo });
    const r = mergeWorktree('PM-902', { cwd: repo });
    assert.equal(r.ok, false);
    assert.equal(r.already_merged, true, '이미 머지된 branch 는 already_merged 신호를 내야 함');
    // mergeAll 도 already_merged 로 분류
    const all = mergeAll(['PM-902'], { cwd: repo });
    assert.deepEqual(all.already_merged, ['PM-902']);
    assert.equal(all.conflicted, null);
  } finally { cleanupRepo(repo); }
});

test('planMerge — diff 가 allowed_paths 밖이면 reject (ownership 위반)', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'PM-004', 'a.txt', 'A\n');
    // 실제로 a.txt 변경했지만 allowed_paths 는 src/** 만 → 스코프 밖.
    writeRun(repo, 'PM-004', { file: 'a.txt', allowedPaths: ['src/**'], filesChanged: ['a.txt'] });
    const plan = planMerge({ cwd: repo, taskIds: ['PM-004'] });
    assert.deepEqual(plan.eligible, []);
    assert.match(plan.rejected[0].reason, /allowed_paths 외 파일/);
  } finally { cleanupRepo(repo); }
});

test('planMerge — status!=done 이면 reject', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'PM-005', 'a.txt', 'A\n');
    writeRun(repo, 'PM-005', { file: 'a.txt', allowedPaths: ['a.txt'], statusOverride: { status: 'blocked' } });
    const plan = planMerge({ cwd: repo, taskIds: ['PM-005'] });
    assert.deepEqual(plan.eligible, []);
    assert.match(plan.rejected[0].reason, /status=blocked/);
  } finally { cleanupRepo(repo); }
});

// ─── ADR-058: red_observed soft 경고 게이트 (옵션 B — 경고만, reject 아님) ──────
// red_observed 는 순수 자기보고라 git 교차검증 corroboration 이 없다 → hard 게이트는
// theater. 철학 #5(자동 반영 X, 제안까지) 정합의 soft 경고: tdd:true 인데 RED 관측
// 증거가 없으면 tdd_warnings 로 가시화하되 머지는 진행한다.

test('planMerge — tdd:true + red_observed:false → eligible 유지 + tdd_warnings 경고', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TW-001', 'a.txt', 'A\n');
    writeRun(repo, 'TW-001', {
      file: 'a.txt', allowedPaths: ['a.txt'],
      statusOverride: { tdd_evidence: { red_observed: false, green_observed: true } },
      payloadOverride: { tdd: true },
    });
    const plan = planMerge({ cwd: repo, taskIds: ['TW-001'] });
    assert.deepEqual(plan.eligible, ['TW-001'], 'soft 경고 — 머지는 진행: ' + JSON.stringify(plan));
    assert.deepEqual(plan.rejected, []);
    assert.equal((plan.tdd_warnings || []).length, 1, 'RED 미관측 경고 1건');
    assert.equal(plan.tdd_warnings[0].task_id, 'TW-001');
    assert.match(plan.tdd_warnings[0].warning, /red_observed/);
  } finally { cleanupRepo(repo); }
});

test('planMerge — tdd:true + red_observed:true → 경고 없음', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TW-002', 'b.txt', 'B\n');
    writeRun(repo, 'TW-002', {
      file: 'b.txt', allowedPaths: ['b.txt'],
      statusOverride: { tdd_evidence: { red_observed: true, green_observed: true } },
      payloadOverride: { tdd: true },
    });
    const plan = planMerge({ cwd: repo, taskIds: ['TW-002'] });
    assert.deepEqual(plan.eligible, ['TW-002']);
    assert.deepEqual(plan.tdd_warnings || [], []);
  } finally { cleanupRepo(repo); }
});

test('planMerge — tdd:false (opt-out task) → red_observed 무관 경고 없음', () => {
  const repo = makeRepo();
  try {
    workInWorktree(repo, 'TW-003', 'c.txt', 'C\n');
    writeRun(repo, 'TW-003', {
      file: 'c.txt', allowedPaths: ['c.txt'],
      statusOverride: { tdd_evidence: { red_observed: false, green_observed: false } },
      payloadOverride: { tdd: false },
    });
    const plan = planMerge({ cwd: repo, taskIds: ['TW-003'] });
    assert.deepEqual(plan.eligible, ['TW-003']);
    assert.deepEqual(plan.tdd_warnings || [], []);
  } finally { cleanupRepo(repo); }
});
