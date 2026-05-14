'use strict';

// pact run-cycle — prepare/collect 통합 CLI 테스트.
// 실제 git repo + spawn으로 end-to-end 검증.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACT_BIN = path.join(ROOT, 'bin', 'pact');

function sh(cmd, opts) {
  return execSync(cmd, { stdio: 'ignore', shell: true, ...opts });
}

function runPact(args, cwd) {
  return spawnSync('node', [PACT_BIN, ...args], { cwd, encoding: 'utf8' });
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-rc-'));
  sh('git init -b main', { cwd: dir });
  sh('git config user.email t@t.t && git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE\nname: testapp\n');
  sh('git add . && git commit -m init', { cwd: dir });
  return dir;
}

function cleanupProject(dir) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: dir, encoding: 'utf8' });
    out.split('\n').filter(l => l.startsWith('worktree ')).forEach(l => {
      const wt = l.replace('worktree ', '').trim();
      if (wt !== dir) {
        try { sh(`git worktree remove --force "${wt}"`, { cwd: dir }); } catch {}
      }
    });
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeTasks(dir, tasks) {
  const md = ['# TASKS\n', '## frontmatter\n',
    '```yaml', 'educational_mode: false', '```\n', '---\n'];
  for (const t of tasks) {
    md.push(`## ${t.id}  ${t.title || t.id}\n`);
    md.push('```yaml');
    md.push(`priority: ${t.priority || 'P0'}`);
    md.push(`dependencies: ${JSON.stringify(t.dependencies || [])}`);
    md.push(`allowed_paths: ${JSON.stringify(t.allowed_paths)}`);
    md.push(`files: ${JSON.stringify(t.files || t.allowed_paths)}`);
    md.push(`work: [${t.work || 'do'}]`);
    md.push(`done_criteria: [${t.done_criteria || 'exists'}]`);
    md.push(`tdd: ${t.tdd ?? false}`);
    md.push('```\n');
  }
  fs.writeFileSync(path.join(dir, 'TASKS.md'), md.join('\n'));
  // checkEnvironment는 clean tree 요구 — 실제 /pact:plan 흐름도 commit 후 /pact:parallel
  sh('git add TASKS.md && git commit -m "tasks"', { cwd: dir });
}

// ─── prepare ────────────────────────────────────────────

test('run-cycle prepare — CLAUDE.md 없으면 preflight 실패', () => {
  const dir = makeProject();
  try {
    fs.unlinkSync(path.join(dir, 'CLAUDE.md'));
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'preflight');
    assert.ok(out.errors.some(e => /CLAUDE\.md/.test(e.message)));
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — task source 없으면 preflight 실패', () => {
  const dir = makeProject();
  try {
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 'preflight');
    assert.ok(out.errors.some(e => /task source/.test(e.message)));
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — happy path: task_prompts·worktree·payload 생성', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
      { id: 'PROJ-002', allowed_paths: ['src/b.ts'] },
    ]);

    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);

    assert.equal(out.ok, true);
    assert.equal(out.task_prompts.length, 2);
    assert.equal(out.coordinator_review_needed, false, '2개 batch는 review 스킵 게이트');

    for (const tp of out.task_prompts) {
      assert.ok(fs.existsSync(path.join(dir, tp.prompt_path)), `prompt.md 생성: ${tp.prompt_path}`);
      assert.ok(fs.existsSync(path.join(dir, tp.context_path)), `context.md 생성: ${tp.context_path}`);
      assert.ok(fs.existsSync(path.join(dir, tp.working_dir)), `worktree 생성: ${tp.working_dir}`);
      assert.match(tp.task_prompt, new RegExp(tp.task_id));
    }

    assert.ok(fs.existsSync(path.join(dir, '.pact/current_batch.json')));
    const cb = JSON.parse(fs.readFileSync(path.join(dir, '.pact/current_batch.json'), 'utf8'));
    assert.deepEqual(cb.task_ids.sort(), ['PROJ-001', 'PROJ-002']);
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — 3개 batch는 coordinator_review_needed=true', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
      { id: 'PROJ-002', allowed_paths: ['src/b.ts'] },
      { id: 'PROJ-003', allowed_paths: ['src/c.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.coordinator_review_needed, true);
    assert.equal(out.task_prompts.length, 3);
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — --max=1로 batch 크기 제한', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
      { id: 'PROJ-002', allowed_paths: ['src/b.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.task_prompts.length, 1, '--max=1이면 batch[0]에 1개만');
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — 빈 batch면 empty: true', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, []);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.empty, true);
  } finally { cleanupProject(dir); }
});

// ─── collect ────────────────────────────────────────────

test('run-cycle collect — current_batch 없으면 already_collected (v0.6.1 멱등)', () => {
  const dir = makeProject();
  try {
    fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
    const r = runPact(['run-cycle', 'collect'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.already_collected, true);
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — 두 번째 호출은 already_prepared (v0.6.1 멱등)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'IDEM-001', allowed_paths: ['src/a.ts'] }]);
    const r1 = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r1.status, 0, `1st: ${r1.stderr}`);
    const out1 = JSON.parse(r1.stdout);
    assert.equal(out1.ok, true);
    assert.equal(out1.already_prepared, undefined, '첫 호출은 정상 진행');

    const r2 = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r2.status, 0, `2nd: ${r2.stderr}`);
    const out2 = JSON.parse(r2.stdout);
    assert.equal(out2.ok, true);
    assert.equal(out2.already_prepared, true, '두 번째는 멱등 skip');
  } finally { cleanupProject(dir); }
});

// ─── prepare → 워커 시뮬 → collect end-to-end ──────────

test('run-cycle E2E — prepare → 워커 시뮬 commit → collect 모두 머지 성공', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
      { id: 'PROJ-002', allowed_paths: ['src/b.ts'] },
    ]);

    const prep = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(prep.status, 0, prep.stderr);
    const prepOut = JSON.parse(prep.stdout);

    // 워커 시뮬: worktree 안에서 파일 작성 + commit + status.json 작성
    for (const tp of prepOut.task_prompts) {
      const wtAbs = path.join(dir, tp.working_dir);
      const fname = tp.task_id === 'PROJ-001' ? 'src/a.ts' : 'src/b.ts';
      fs.mkdirSync(path.join(wtAbs, 'src'), { recursive: true });
      fs.writeFileSync(path.join(wtAbs, fname), `export const ${tp.task_id} = true;\n`);
      sh(`git add . && git commit -m "${tp.task_id} work"`, { cwd: wtAbs });

      // status.json (schema 준수)
      const status = {
        task_id: tp.task_id,
        status: 'done',
        branch_name: `pact/${tp.task_id}`,
        commits_made: 1,
        clean_for_merge: true,
        files_changed: [fname],
        files_attempted_outside_scope: [],
        verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
        tdd_evidence: { red_observed: false, green_observed: false },
        decisions: [],
        blockers: [],
        tokens_used: 1000,
        completed_at: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(dir, tp.status_path), JSON.stringify(status, null, 2));
    }

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 0, col.stderr);
    const colOut = JSON.parse(col.stdout);

    assert.equal(colOut.ok, true);
    assert.deepEqual(colOut.merged.sort(), ['PROJ-001', 'PROJ-002']);
    assert.equal(colOut.conflicted, null);
    assert.equal(colOut.failures.length, 0);
    assert.deepEqual(colOut.verification_summary, {
      lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass',
    });

    // 머지 성공한 worktree 정리됨
    for (const tp of prepOut.task_prompts) {
      assert.equal(
        fs.existsSync(path.join(dir, tp.working_dir)),
        false,
        `cleanup: ${tp.working_dir} 제거됨`,
      );
    }

    // current_batch 소비됨
    assert.equal(fs.existsSync(path.join(dir, '.pact/current_batch.json')), false);

    // main repo에 변경 머지됨
    assert.ok(fs.existsSync(path.join(dir, 'src/a.ts')));
    assert.ok(fs.existsSync(path.join(dir, 'src/b.ts')));
  } finally { cleanupProject(dir); }
});

test('run-cycle E2E — 워커 1명 status missing이면 실패만 collect 보고, 정상 1명은 머지', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
      { id: 'PROJ-002', allowed_paths: ['src/b.ts'] },
    ]);

    const prep = runPact(['run-cycle', 'prepare'], dir);
    const prepOut = JSON.parse(prep.stdout);

    // PROJ-001만 정상 시뮬, PROJ-002는 status.json 미작성
    const tp = prepOut.task_prompts.find(t => t.task_id === 'PROJ-001');
    const wtAbs = path.join(dir, tp.working_dir);
    fs.mkdirSync(path.join(wtAbs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wtAbs, 'src/a.ts'), 'x\n');
    sh('git add . && git commit -m work', { cwd: wtAbs });
    fs.writeFileSync(path.join(dir, tp.status_path), JSON.stringify({
      task_id: 'PROJ-001',
      status: 'done',
      branch_name: 'pact/PROJ-001',
      commits_made: 1,
      clean_for_merge: true,
      files_changed: ['src/a.ts'],
      files_attempted_outside_scope: [],
      verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
      tdd_evidence: { red_observed: false, green_observed: false },
      decisions: [],
      blockers: [],
      tokens_used: 100,
      completed_at: new Date().toISOString(),
    }, null, 2));

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 0, col.stderr);
    const colOut = JSON.parse(col.stdout);

    assert.deepEqual(colOut.merged, ['PROJ-001']);
    assert.ok(colOut.rejected.some(r => r.task_id === 'PROJ-002' && /status\.json missing/.test(r.reason)));
  } finally { cleanupProject(dir); }
});
