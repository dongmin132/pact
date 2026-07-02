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
    if (t.status) md.push(`status: ${t.status}`);
    if (t.loop_until) {
      md.push('loop_until:');
      for (const [k, v] of Object.entries(t.loop_until)) {
        md.push(`  ${k}: ${v}`);
      }
    }
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
    // coordinator_review_needed 는 pre-spawn 검토 제거(P1-3)로 deprecated — 항상 false.
    assert.equal(out.coordinator_review_needed, false, 'pre-spawn 검토 제거 → 항상 false');

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

test('run-cycle prepare — 3개 batch여도 coordinator_review_needed=false (P1-3: pre-spawn 검토 제거)', () => {
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
    // 배치 크기 무관 — pre-spawn coordinator 검토는 결정적 게이트가 커버하므로 삭제됨.
    assert.equal(out.coordinator_review_needed, false, 'batch 크기 무관 deprecated false');
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

// ─── 슬로우니스 레버 배선 (P1-1 · SPD-4): prepare emit 에 non-blocking 경고 fold ──

test('prepare — oversized task 는 size_warnings 로 플래그 (비차단, prepare ok 유지)', () => {
  const dir = makeProject();
  try {
    // allowed_paths 6개 concrete (> maxFiles 5) → sizecheck oversized
    writeTasks(dir, [
      { id: 'BIG-001', allowed_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, '경고가 있어도 prepare 는 성공(non-blocking)');
    assert.ok(Array.isArray(out.size_warnings), 'size_warnings 필드 존재');
    assert.ok(
      out.size_warnings.some(w => w.task === 'BIG-001' && w.risk === 'oversized'),
      `size_warnings 에 BIG-001 oversized: ${JSON.stringify(out.size_warnings)}`,
    );
    // 정상 task_prompts·worktree 는 그대로 (경고는 부가 필드일 뿐)
    assert.equal(out.task_prompts.length, 1);
  } finally { cleanupProject(dir); }
});

test('prepare — 이미 done 인 oversized task 는 size_warnings 에서 제외 (노이즈 방어)', () => {
  const dir = makeProject();
  try {
    // DONE-001 은 oversized 지만 status:done → batch0 미포함 → 재플래그 금지.
    writeTasks(dir, [
      { id: 'DONE-001', status: 'done', allowed_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'] },
      { id: 'TODO-001', allowed_paths: ['src/z.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.task_prompts.map(t => t.task_id), ['TODO-001'], 'batch0 는 미완 task 만');
    assert.ok(
      !(out.size_warnings || []).some(w => w.task === 'DONE-001'),
      `done task 는 재플래그 금지: ${JSON.stringify(out.size_warnings)}`,
    );
  } finally { cleanupProject(dir); }
});

test('prepare — done_criteria 가 allowed_paths 밖 생성 요구하면 scope_warnings (비차단)', () => {
  const dir = makeProject();
  try {
    // allowed_paths=src/x.ts 인데 done_criteria 가 docs/out.md 생성 의무 → 계약모순
    writeTasks(dir, [
      { id: 'SCOPE-001', allowed_paths: ['src/x.ts'], done_criteria: '"docs/out.md 생성"' },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, '계약모순 경고가 있어도 prepare 성공');
    assert.ok(Array.isArray(out.scope_warnings), 'scope_warnings 필드 존재');
    assert.ok(
      out.scope_warnings.some(w => w.task === 'SCOPE-001' && w.risk === 'scope_contradiction'),
      `scope_warnings 에 SCOPE-001: ${JSON.stringify(out.scope_warnings)}`,
    );
  } finally { cleanupProject(dir); }
});

test('prepare — 경고 없는 정상 batch 는 size/scope/bundle/ownership_warnings 모두 빈 배열', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'OK-001', allowed_paths: ['src/a.ts'] },
      { id: 'OK-002', allowed_paths: ['src/b.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.size_warnings, [], 'size_warnings 빈 배열');
    assert.deepEqual(out.scope_warnings, [], 'scope_warnings 빈 배열');
    assert.deepEqual(out.bundle_warnings, [], 'bundle_warnings 빈 배열');
    assert.deepEqual(out.ownership_warnings, [], 'ownership_warnings 빈 배열');
  } finally { cleanupProject(dir); }
});

test('prepare — allowed_paths 가 MODULE_OWNERSHIP 밖이면 ownership_warnings (비차단)', () => {
  const dir = makeProject();
  try {
    // auth 모듈이 src/auth/** 소유. PAY-001 은 src/payments/** 를 요구 → 오너 영역 침범.
    fs.writeFileSync(
      path.join(dir, 'MODULE_OWNERSHIP.md'),
      '# ownership\n\n## auth\n\n```yaml\nmodule: auth\nowner_paths:\n  - src/auth/**\nshared_with: []\n```\n',
    );
    sh('git add MODULE_OWNERSHIP.md && git commit -m ownership', { cwd: dir });
    writeTasks(dir, [
      { id: 'PAY-001', allowed_paths: ['src/payments/api.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, '오너십 경고가 있어도 prepare 성공(non-blocking)');
    assert.ok(Array.isArray(out.ownership_warnings), 'ownership_warnings 필드 존재');
    assert.ok(
      out.ownership_warnings.some(w => w.task === 'PAY-001' && w.risk === 'ownership_conflict'),
      `ownership_warnings 에 PAY-001: ${JSON.stringify(out.ownership_warnings)}`,
    );
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

      // ADR-049 — report.md 필수 (비공백 10줄 이상)
      const report = [
        `# ${tp.task_id} report`,
        '## what',
        `${tp.task_id} 워커 시뮬 — ${fname} 단일 export 추가.`,
        '## why',
        'E2E 시뮬용 최소 산출물.',
        '## decisions',
        '- 없음 (시뮬)',
        '## verify',
        '- lint: pass',
        '- typecheck: pass',
        '- test: pass',
        '- build: pass',
      ].join('\n\n');
      fs.writeFileSync(path.join(dir, tp.report_path), report);
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

    // merge-result.json 파일 = 사이클 deterministic SOT (drive 후 /pact:wrap 입력).
    // decisions_to_record/verification_summary/failures 까지 persist 돼야 LLM 없이도 문서 rollup 가능.
    const mr = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.deepEqual(mr.merged.sort(), ['PROJ-001', 'PROJ-002']);
    assert.ok(Array.isArray(mr.failures), 'merge-result.json failures persist');
    assert.ok('decisions_to_record' in mr, 'merge-result.json decisions_to_record persist');
    assert.deepEqual(mr.verification_summary, { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' });

    // ADR-048 — 머지된 task는 source frontmatter에 status:done 박혀야 한다.
    assert.ok(Array.isArray(colOut.status_updates), 'status_updates 필드 존재');
    assert.equal(colOut.status_updates.length, 2);
    for (const su of colOut.status_updates) {
      assert.equal(su.ok, true, `${su.task_id} setTaskStatus: ${su.error || ''}`);
    }
    const tasksMd = fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf8');
    assert.match(tasksMd, /## PROJ-001[\s\S]*?status: done/);
    assert.match(tasksMd, /## PROJ-002[\s\S]*?status: done/);

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
    fs.writeFileSync(path.join(dir, tp.report_path),
      ['# PROJ-001', '## what', 'sim', '## why', 'sim', '## decisions', '- none',
       '## verify', '- lint pass', '- typecheck pass', '- test pass', '- build pass'].join('\n\n'));

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 0, col.stderr);
    const colOut = JSON.parse(col.stdout);

    assert.deepEqual(colOut.merged, ['PROJ-001']);
    assert.ok(colOut.rejected.some(r => r.task_id === 'PROJ-002' && /status\.json missing/.test(r.reason)));
  } finally { cleanupProject(dir); }
});

// ─── ADR-049: report.md gate ──────────────────────────────

test('ADR-049 — report.md missing이면 reject (status.json 정상이어도)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
    ]);
    const prep = runPact(['run-cycle', 'prepare'], dir);
    const prepOut = JSON.parse(prep.stdout);
    const tp = prepOut.task_prompts[0];

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
      completed_at: new Date().toISOString(),
    }, null, 2));
    // report.md 의도적 미작성

    const col = runPact(['run-cycle', 'collect'], dir);
    const colOut = JSON.parse(col.stdout);
    assert.deepEqual(colOut.merged, []);
    assert.ok(
      colOut.rejected.some(r => r.task_id === 'PROJ-001' && /report\.md missing/.test(r.reason)),
      `rejected: ${JSON.stringify(colOut.rejected)}`,
    );
  } finally { cleanupProject(dir); }
});

test('ADR-049 — report.md가 10줄 미만이면 reject', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'PROJ-001', allowed_paths: ['src/a.ts'] },
    ]);
    const prep = runPact(['run-cycle', 'prepare'], dir);
    const prepOut = JSON.parse(prep.stdout);
    const tp = prepOut.task_prompts[0];

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
      completed_at: new Date().toISOString(),
    }, null, 2));
    // 비공백 8줄 (10줄 미만)
    fs.writeFileSync(path.join(dir, tp.report_path),
      ['# t', '', '1', '2', '3', '4', '5', '6', '7', '8', ''].join('\n'));

    const col = runPact(['run-cycle', 'collect'], dir);
    const colOut = JSON.parse(col.stdout);
    assert.deepEqual(colOut.merged, []);
    assert.ok(
      colOut.rejected.some(r => r.task_id === 'PROJ-001' && /report\.md too short/.test(r.reason)),
      `rejected: ${JSON.stringify(colOut.rejected)}`,
    );
  } finally { cleanupProject(dir); }
});

// ─── cycle.lock 누수 (finally 보장) ──────────────────────
test('run-cycle prepare — pactStage 실패해도 cycle.lock 누수 없음 (finally 보장)', () => {
  const dir = makeProject();
  try {
    // preflight는 통과시키되 doPrepare의 task-parse 단계에서 실패하게:
    // 중복 키(priority 2회) → yaml-mini throw → parse-tasks가 task-parse 에러로 기록
    const md = [
      '# TASKS', '',
      '## BAD-001  bad task', '',
      '```yaml',
      'priority: P0',
      'priority: P1',
      'allowed_paths: [src/a.ts]',
      '```', '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'TASKS.md'), md);
    sh('git add TASKS.md && git commit -m bad', { cwd: dir });

    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 1, `stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'task-parse', `stage가 task-parse 여야 (lock 획득 후 실패): ${JSON.stringify(out)}`);

    // 핵심: cycle.lock이 finally로 해제됐어야 함 (process.exit가 finally를 건너뛰면 누수)
    assert.equal(
      fs.existsSync(path.join(dir, '.pact/cycle.lock')),
      false,
      'pactStage 실패 후 cycle.lock 누수됨',
    );
  } finally { cleanupProject(dir); }
});

// ─── worktree 자가치유 (재진입 stale cruft) ──────────────
test('run-cycle prepare — stale worktree(미머지 없음) 있어도 reconcile 후 성공', () => {
  const dir = makeProject();
  try {
    // 실제 pact 처럼 .pact/ gitignore (stale worktree가 tree를 dirty하게 안 만들게)
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }]);

    // 과거 cycle 잔재: PROJ-001 worktree가 이미 존재 (커밋 없음=미머지 없음)
    fs.mkdirSync(path.join(dir, '.pact/worktrees'), { recursive: true });
    sh('git worktree add -b pact/PROJ-001 .pact/worktrees/PROJ-001 main', { cwd: dir });
    assert.ok(fs.existsSync(path.join(dir, '.pact/worktrees/PROJ-001')), '사전조건: stale worktree 존재');

    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `reconcile 후 성공해야: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.task_prompts.length, 1);
    assert.equal(out.task_prompts[0].task_id, 'PROJ-001');
    assert.ok(fs.existsSync(path.join(dir, out.task_prompts[0].working_dir)), '재생성된 worktree 존재');
  } finally { cleanupProject(dir); }
});

// ─── collect --commit-status (무인 멀티사이클 전제: status 변경 자동커밋) ──
test('run-cycle collect --commit-status — status 변경 커밋 → tree clean → 다음 prepare 통과', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }]);

    const prep = runPact(['run-cycle', 'prepare'], dir);
    const tp = JSON.parse(prep.stdout).task_prompts[0];
    const wtAbs = path.join(dir, tp.working_dir);
    fs.mkdirSync(path.join(wtAbs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wtAbs, 'src/a.ts'), 'export const x=1;\n');
    sh('git add . && git commit -m work', { cwd: wtAbs });
    fs.writeFileSync(path.join(dir, tp.status_path), JSON.stringify({
      task_id: 'PROJ-001', status: 'done', branch_name: 'pact/PROJ-001', commits_made: 1,
      clean_for_merge: true, files_changed: ['src/a.ts'], files_attempted_outside_scope: [],
      verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
      tdd_evidence: { red_observed: false, green_observed: false }, decisions: [], blockers: [],
      tokens_used: 100, completed_at: new Date().toISOString(),
    }, null, 2));
    fs.writeFileSync(path.join(dir, tp.report_path),
      ['# r', '## what', 'x', '## why', 'y', '## decisions', '- none',
       '## verify', '- lint pass', '- tc pass', '- test pass', '- build pass'].join('\n\n'));

    const col = runPact(['run-cycle', 'collect', '--commit-status'], dir);
    assert.equal(col.status, 0, col.stderr);
    const colOut = JSON.parse(col.stdout);
    assert.deepEqual(colOut.merged, ['PROJ-001']);
    assert.ok(colOut.status_commit && colOut.status_commit.committed === true,
      `status_commit.committed=true 여야: ${JSON.stringify(colOut.status_commit)}`);

    // 핵심: tree가 clean → 다음 cycle preflight(isClean) 통과
    const porcelain = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(porcelain, '', `collect 후 tree clean 이어야: "${porcelain}"`);
  } finally { cleanupProject(dir); }
});

test('run-cycle collect (플래그 없음) — 자동커밋 안 함 (인터랙티브 동작 불변)', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }]);
    const prep = runPact(['run-cycle', 'prepare'], dir);
    const tp = JSON.parse(prep.stdout).task_prompts[0];
    const wtAbs = path.join(dir, tp.working_dir);
    fs.mkdirSync(path.join(wtAbs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wtAbs, 'src/a.ts'), 'export const x=1;\n');
    sh('git add . && git commit -m work', { cwd: wtAbs });
    fs.writeFileSync(path.join(dir, tp.status_path), JSON.stringify({
      task_id: 'PROJ-001', status: 'done', branch_name: 'pact/PROJ-001', commits_made: 1,
      clean_for_merge: true, files_changed: ['src/a.ts'], files_attempted_outside_scope: [],
      verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
      tdd_evidence: { red_observed: false, green_observed: false }, decisions: [], blockers: [],
      tokens_used: 100, completed_at: new Date().toISOString(),
    }, null, 2));
    fs.writeFileSync(path.join(dir, tp.report_path),
      ['# r', '## what', 'x', '## why', 'y', '## decisions', '- none',
       '## verify', '- lint pass', '- tc pass', '- test pass', '- build pass'].join('\n\n'));
    const col = runPact(['run-cycle', 'collect'], dir);
    const colOut = JSON.parse(col.stdout);
    assert.equal(colOut.status_commit, undefined, '플래그 없으면 status_commit 없음');
    // TASKS.md status:done 변경이 커밋 안 돼 tree dirty (현행 동작)
    const porcelain = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim();
    assert.notEqual(porcelain, '', '플래그 없으면 status 변경이 미커밋(dirty)');
  } finally { cleanupProject(dir); }
});

// ─── collect 재진입: dangling 머지(크래시) 복구 ──────────────
function mkStatus(id, file) {
  return JSON.stringify({
    task_id: id, status: 'done', branch_name: `pact/${id}`, commits_made: 1,
    clean_for_merge: true, files_changed: [file], files_attempted_outside_scope: [],
    verify_results: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
    tdd_evidence: { red_observed: false, green_observed: false }, decisions: [], blockers: [],
    tokens_used: 100, completed_at: new Date().toISOString(),
  }, null, 2);
}
function mkReport(id) {
  return ['# ' + id, '## what', 'x', '## why', 'y', '## decisions', '- none',
    '## verify', '- lint pass', '- tc pass', '- test pass', '- build pass'].join('\n\n');
}
function hasMergeHead(dir) {
  return execSync('git rev-parse -q --verify MERGE_HEAD || true', { cwd: dir, encoding: 'utf8' }).trim() !== '';
}

test('run-cycle collect — 크래시 dangling 머지 + journal 있으면 abort 후 재개 성공', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }, { id: 'PROJ-002', allowed_paths: ['src/b.ts'] }]);
    const prepOut = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    for (const tp of prepOut.task_prompts) {
      const wtAbs = path.join(dir, tp.working_dir);
      const fname = tp.task_id === 'PROJ-001' ? 'src/a.ts' : 'src/b.ts';
      fs.mkdirSync(path.join(wtAbs, 'src'), { recursive: true });
      fs.writeFileSync(path.join(wtAbs, fname), `export const ${tp.task_id.replace('-', '_')}=1;\n`);
      sh(`git add . && git commit -m "${tp.task_id}"`, { cwd: wtAbs });
      fs.writeFileSync(path.join(dir, tp.status_path), mkStatus(tp.task_id, fname));
      fs.writeFileSync(path.join(dir, tp.report_path), mkReport(tp.task_id));
    }
    // 크래시 시뮬: PROJ-001 머지를 미커밋 상태로 남김(dangling) + journal
    sh('git merge --no-commit --no-ff pact/PROJ-001', { cwd: dir });
    assert.equal(hasMergeHead(dir), true, '사전: dangling MERGE_HEAD 존재');
    fs.writeFileSync(path.join(dir, '.pact/collect-journal.json'), JSON.stringify({ phase: 'merging' }));

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 0, `${col.stdout}\n${col.stderr}`);
    const out = JSON.parse(col.stdout);
    assert.equal(out.conflicted, null, 'dangling abort 후 정상 머지');
    assert.deepEqual(out.merged.sort(), ['PROJ-001', 'PROJ-002']);
    assert.equal(hasMergeHead(dir), false, 'MERGE_HEAD 정리됨');
    assert.equal(fs.existsSync(path.join(dir, '.pact/collect-journal.json')), false, 'journal 정리됨');
  } finally { cleanupProject(dir); }
});

test('run-cycle collect — journal 없는 외부 머지(MERGE_HEAD)는 건드리지 않고 정지', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }]);
    const prepOut = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    const tp = prepOut.task_prompts[0];
    const wtAbs = path.join(dir, tp.working_dir);
    fs.mkdirSync(path.join(wtAbs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wtAbs, 'src/a.ts'), 'export const x=1;\n');
    sh('git add . && git commit -m w', { cwd: wtAbs });
    // 외부 dangling 머지 (journal 없음)
    sh('git merge --no-commit --no-ff pact/PROJ-001', { cwd: dir });
    assert.equal(hasMergeHead(dir), true);

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 1, `${col.stdout}`);
    const out = JSON.parse(col.stdout);
    assert.equal(out.stage, 'merge-in-progress');
    assert.equal(hasMergeHead(dir), true, '외부 머지는 abort 안 하고 보존');
  } finally { cleanupProject(dir); }
});

// ─── P2 마무리: already_prepared 도 task_prompts 반환 + ready_to_collect ──
test('run-cycle prepare — already_prepared 도 task_prompts 반환 (drift 제거)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }]);
    const r1 = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    assert.equal(r1.already_prepared, undefined, '첫 호출은 정상');
    const r2 = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    assert.equal(r2.already_prepared, true);
    assert.ok(Array.isArray(r2.task_prompts), 'already_prepared 에도 task_prompts 있어야');
    assert.equal(r2.task_prompts.length, 1);
    // makeTaskPrompt 단일 소스 → "legacy SOT" 차단 줄 포함, 첫 호출과 동일(drift 없음)
    assert.match(r2.task_prompts[0].task_prompt, /legacy SOT/i);
    assert.equal(r2.task_prompts[0].task_prompt, r1.task_prompts[0].task_prompt);
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — already_prepared + 모든 워커 done이면 ready_to_collect:true', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }]);
    const r1 = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    fs.writeFileSync(path.join(dir, r1.task_prompts[0].status_path), mkStatus('PROJ-001', 'src/a.ts'));
    const r2 = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    assert.equal(r2.already_prepared, true);
    assert.equal(r2.ready_to_collect, true, '모두 done이면 spawn 스킵 신호');
  } finally { cleanupProject(dir); }
});

test('run-cycle prepare — already_prepared + 일부만 done이면 ready_to_collect:false', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'PROJ-001', allowed_paths: ['src/a.ts'] }, { id: 'PROJ-002', allowed_paths: ['src/b.ts'] }]);
    const r1 = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    const tp = r1.task_prompts.find(t => t.task_id === 'PROJ-001');
    fs.writeFileSync(path.join(dir, tp.status_path), mkStatus('PROJ-001', 'src/a.ts'));
    const r2 = JSON.parse(runPact(['run-cycle', 'prepare'], dir).stdout);
    assert.equal(r2.ready_to_collect, false);
  } finally { cleanupProject(dir); }
});

// ─── loop_until passthrough (fresh emit path) ────────────
// writeTasks가 multi-line nested YAML을 emit하면 yaml-mini가 올바른 객체로 파싱한다.
// 이 테스트는 FRESH prepare (cycle 1) 경로에서 loop_until이 task_prompts로 전달됨을 검증한다.
test('prepare — task의 loop_until을 task_prompts로 전달 (fresh path)', () => {
  const dir = makeProject();
  try {
    const loopUntil = { count: 'echo 0', max_iterations: 4 };
    writeTasks(dir, [{ id: 'LOOP-002', allowed_paths: ['src/**'], loop_until: loopUntil }]);

    const r = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    const tp = (out.task_prompts || []).find(t => t.task_id === 'LOOP-002');
    assert.ok(tp, `LOOP-002 task_prompt 존재: ${r.stdout}`);
    assert.deepEqual(tp.loop_until, loopUntil);
  } finally { cleanupProject(dir); }
});

// ─── loop_until passthrough (rebuild emit path) ──────────
// rebuildTaskPrompts 는 payload.json(plain JSON)을 그대로 읽어 task_prompts로 전달하므로
// YAML 파서를 거치지 않는다. 이 경로가 loop_until 전달을 검증하는 별도 단위다.
test('prepare — task의 loop_until을 task_prompts로 전달 (rebuild path)', () => {
  const dir = makeProject();
  try {
    const id = 'LOOP-001';
    const loopUntil = { count: 'echo 0', max_iterations: 4 };

    // rebuildTaskPrompts 가 읽는 파일들을 픽스처로 직접 생성:
    // 1. .pact/current_batch.json
    fs.mkdirSync(path.join(dir, '.pact'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.pact/current_batch.json'),
      JSON.stringify({ task_ids: [id], prepared_at: new Date().toISOString(), coordinator_review_needed: false }),
    );

    // 2. .pact/runs/<id>/payload.json — loop_until 포함
    const runsDir = path.join(dir, '.pact/runs', id);
    fs.mkdirSync(runsDir, { recursive: true });
    const payload = {
      task_id: id,
      title: 'loop test',
      allowed_paths: ['src/**'],
      forbidden_paths: [],
      done_criteria: [],
      verify_commands: [],
      contracts: {},
      context_refs: [],
      tdd: false,
      educational_mode: false,
      prd_reference: null,
      working_dir: `.pact/worktrees/${id}`,
      branch_name: `pact/${id}`,
      base_branch: 'main',
      context_budget_tokens: 20000,
      loop_until: loopUntil,
    };
    fs.writeFileSync(path.join(runsDir, 'payload.json'), JSON.stringify(payload, null, 2));

    // 3. prompt.md, context.md (isAlreadyPrepared + rebuildTaskPrompts 가 경로 참조)
    fs.writeFileSync(path.join(runsDir, 'prompt.md'), `# Task ${id}\n`);
    fs.writeFileSync(path.join(runsDir, 'context.md'), `# Context ${id}\n`);

    // 4. .pact/worktrees/<id> — isAlreadyPrepared 체크용
    const wtDir = path.join(dir, `.pact/worktrees/${id}`);
    fs.mkdirSync(wtDir, { recursive: true });

    // TASKS.md가 없으면 preflight가 실패하므로 빈 task list로 작성
    writeTasks(dir, []);

    const r = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    const j = JSON.parse(r.stdout);
    // already_prepared 경로 → rebuildTaskPrompts 호출
    assert.ok(j.already_prepared, `already_prepared 여야: ${r.stdout}`);
    const tp = (j.task_prompts || []).find(t => t.task_id === id);
    assert.ok(tp, `LOOP-001 task_prompt 존재: ${r.stdout}`);
    assert.deepEqual(tp.loop_until, loopUntil);
  } finally { cleanupProject(dir); }
});
