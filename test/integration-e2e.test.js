'use strict';

// PACT-025/037/042 통합 — 풀 v1.0 end-to-end 시나리오
// init → plan → batch → 워커 시뮬 → merge → 정리
// LLM 호출 X (메인 Claude·서브에이전트 부분은 manual 시뮬레이션)

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-e2e-'));
  sh('git init -b main', { cwd: dir });
  sh('git config user.email t@t.t && git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# project\n');
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

/** /pact:init 시뮬 — templates 복사 + .pact/ 생성 */
function simulateInit(dir, answers = {}) {
  for (const f of ['CLAUDE.md', 'PROGRESS.md', 'TASKS.md', 'DECISIONS.md']) {
    let content = fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8');
    const replacements = {
      '<project-name>': answers.name || 'testapp',
      '<한 줄로 이 프로젝트가 무엇을 하는지>': answers.desc || '테스트 앱',
      '<예: TypeScript / Next.js / Postgres>': answers.stack || 'Node.js',
      '<예: npm run lint>': 'npm run lint',
      '<예: npm run typecheck>': 'npm run typecheck',
      '<예: npm test>': 'npm test',
      '<예: npm run build>': 'npm run build',
    };
    for (const [k, v] of Object.entries(replacements)) {
      content = content.split(k).join(v);
    }
    fs.writeFileSync(path.join(dir, f), content);
  }
  fs.mkdirSync(path.join(dir, '.pact/runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pact/worktrees'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pact/.gitignore'), '*\n!.gitignore\n');
  fs.writeFileSync(path.join(dir, '.pact/state.json'),
    JSON.stringify({ version: 1, current_cycle: 0, active_workers: [] }, null, 2));
}

/** /pact:plan 시뮬 — TASKS.md 직접 작성 */
function simulatePlan(dir, tasks) {
  const md = ['# TASKS\n', '## frontmatter\n',
    '```yaml', 'educational_mode: false', '```\n', '---\n'];
  for (const t of tasks) {
    md.push(`## ${t.id}  ${t.title}\n`);
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
}

/** 워커 시뮬 — worktree 생성 + 파일 변경 + commit + payload.json + status.json 작성 */
function simulateWorker(dir, taskId, fileName, content, status = 'done', allowedPaths = null) {
  const { createWorktree } = require(path.join(ROOT, 'scripts/worktree-manager.js'));
  const r = createWorktree(taskId, 'main', { cwd: dir });
  if (!r.ok) throw new Error(`worktree fail: ${r.error}`);

  const wtAbs = r.abs_path;
  const filePath = path.join(wtAbs, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  sh(`git add . && git commit -m "${taskId} work"`, { cwd: wtAbs });

  const runDir = path.join(dir, '.pact/runs', taskId);
  fs.mkdirSync(runDir, { recursive: true });

  // payload.json (allowed_paths 검증용 — ADR-012)
  fs.writeFileSync(path.join(runDir, 'payload.json'), JSON.stringify({
    task_id: taskId,
    title: taskId,
    allowed_paths: allowedPaths || [fileName],
    base_branch: 'main',
    branch_name: `pact/${taskId}`,
    working_dir: `.pact/worktrees/${taskId}`,
    done_criteria: ['done'],
    verify_commands: [],
    tdd: false,
  }, null, 2));

  // status.json (schema 호환)
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    task_id: taskId,
    status,
    branch_name: `pact/${taskId}`,
    commits_made: 1,
    clean_for_merge: status === 'done',
    files_changed: [fileName],
    files_attempted_outside_scope: [],
    verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
    tdd_evidence: { red_observed: false, green_observed: false },
    decisions: [],
    blockers: [],
    tokens_used: 1000,
    completed_at: new Date().toISOString(),
  }, null, 2));
}

// ───────────────────────────────────────────────
// 시나리오 테스트
// ───────────────────────────────────────────────

test('E2E — init → plan → batch → 워커 3 → merge 모두 성공', () => {
  const dir = makeProject();
  try {
    simulateInit(dir);
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(dir, '.pact/runs')));

    simulatePlan(dir, [
      { id: 'PROJ-001', title: 'a', allowed_paths: ['src/a.ts'] },
      { id: 'PROJ-002', title: 'b', allowed_paths: ['src/b.ts'] },
      { id: 'PROJ-003', title: 'c', allowed_paths: ['src/c.ts'] },
    ]);

    const batchR = runPact(['batch'], dir);
    assert.equal(batchR.status, 0, batchR.stderr);
    const batch = JSON.parse(fs.readFileSync(path.join(dir, '.pact/batch.json'), 'utf8'));
    assert.equal(batch.total_tasks, 3);

    simulateWorker(dir, 'PROJ-001', 'src/a.ts', 'export const a = 1;\n');
    simulateWorker(dir, 'PROJ-002', 'src/b.ts', 'export const b = 2;\n');
    simulateWorker(dir, 'PROJ-003', 'src/c.ts', 'export const c = 3;\n');

    const mergeR = runPact(['merge'], dir);
    assert.equal(mergeR.status, 0, mergeR.stderr);

    const result = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.equal(result.merged.length, 3);
    assert.equal(result.conflicted, null);
    assert.ok(fs.existsSync(path.join(dir, 'src/a.ts')));
    assert.ok(fs.existsSync(path.join(dir, 'src/b.ts')));
    assert.ok(fs.existsSync(path.join(dir, 'src/c.ts')));
  } finally { cleanupProject(dir); }
});

test('E2E — 충돌 시나리오 (한 워커가 conflict 야기)', () => {
  const dir = makeProject();
  try {
    simulateInit(dir);
    simulatePlan(dir, [
      { id: 'PROJ-001', title: 'a', allowed_paths: ['shared.txt'] },
      { id: 'PROJ-002', title: 'b', allowed_paths: ['shared.txt'] },
    ]);

    simulateWorker(dir, 'PROJ-001', 'shared.txt', 'A version\n');
    // main에 충돌 commit
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'main version\n');
    sh('git add . && git commit -m main', { cwd: dir });
    simulateWorker(dir, 'PROJ-002', 'shared.txt', 'B version\n');

    const mergeR = runPact(['merge'], dir);
    assert.equal(mergeR.status, 6, '충돌이면 exit 6');

    const result = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.ok(result.conflicted, 'conflicted 정보 있어야');

    // abort로 정리
    sh('git merge --abort', { cwd: dir });
  } finally { cleanupProject(dir); }
});

test('E2E [ADR-012] — 실제 diff가 allowed_paths 외이면 거부', () => {
  const dir = makeProject();
  try {
    simulateInit(dir);
    simulatePlan(dir, [
      { id: 'PROJ-001', title: 'a', allowed_paths: ['src/a.ts'] },
    ]);

    // worktree 만들고 allowed_paths 외 파일 commit
    const { createWorktree } = require(path.join(ROOT, 'scripts/worktree-manager.js'));
    const r = createWorktree('PROJ-001', 'main', { cwd: dir });
    fs.writeFileSync(path.join(r.abs_path, 'unauthorized.ts'), 'leak');
    sh('git add . && git commit -m sneaky', { cwd: r.abs_path });

    // payload + status (둘 다 거짓)
    fs.mkdirSync(path.join(dir, '.pact/runs/PROJ-001'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pact/runs/PROJ-001/payload.json'), JSON.stringify({
      task_id: 'PROJ-001',
      title: 'a',
      allowed_paths: ['src/a.ts'],
      base_branch: 'main',
      branch_name: 'pact/PROJ-001',
      done_criteria: ['x'],
      verify_commands: [],
      working_dir: '.pact/worktrees/PROJ-001',
    }, null, 2));
    fs.writeFileSync(path.join(dir, '.pact/runs/PROJ-001/status.json'), JSON.stringify({
      task_id: 'PROJ-001',
      status: 'done',
      branch_name: 'pact/PROJ-001',
      commits_made: 1,
      clean_for_merge: true,
      files_changed: ['src/a.ts'],            // 거짓
      files_attempted_outside_scope: [],       // 거짓
      verify_results: { lint:'pass',typecheck:'pass',test:'pass',build:'pass' },
      tdd_evidence: { red_observed: false, green_observed: false },
      completed_at: new Date().toISOString(),
    }, null, 2));

    runPact(['merge'], dir);
    const result = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    const r1 = result.rejected.find(r => r.task_id === 'PROJ-001');
    assert.ok(r1, 'allowed_paths 외 파일 → rejected');
    assert.match(r1.reason, /allowed_paths 외|files_changed/);
  } finally { cleanupProject(dir); }
});

test('E2E — schema 위반 워커 거부 (merge-result.json rejected에 박힘)', () => {
  const dir = makeProject();
  try {
    simulateInit(dir);
    simulatePlan(dir, [
      { id: 'PROJ-001', title: 'a', allowed_paths: ['src/a.ts'] },
    ]);

    // schema 위반 status.json (status: 'finished'는 enum 외)
    const { createWorktree } = require(path.join(ROOT, 'scripts/worktree-manager.js'));
    const r = createWorktree('PROJ-001', 'main', { cwd: dir });
    fs.mkdirSync(path.join(r.abs_path, 'src'), { recursive: true });
    fs.writeFileSync(path.join(r.abs_path, 'src/a.ts'), 'x');
    sh('git add . && git commit -m work', { cwd: r.abs_path });

    fs.mkdirSync(path.join(dir, '.pact/runs/PROJ-001'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pact/runs/PROJ-001/status.json'), JSON.stringify({
      task_id: 'PROJ-001',
      status: 'finished',  // ← 위반
    }));

    runPact(['merge'], dir);
    const result = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.ok(result.rejected.some(r => r.task_id === 'PROJ-001'),
      'schema 위반 워커는 rejected에 박혀야');
  } finally { cleanupProject(dir); }
});
