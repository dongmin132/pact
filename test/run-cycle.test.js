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

// ─── STAB-1: 멀티세션 owner-pid 게이트 (이중 spawn 차단) ──────────

const ALIVE_PID = process.pid;   // 테스트 러너 = 항상 살아있음
const DEAD_PID = 999999;         // 비현실적으로 큰 pid = 죽음(isAlive false)

function cbOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.pact/current_batch.json'), 'utf8'));
}

test('owner gate — prepare --owner-pid 시 current_batch 에 owner stamp', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'OWN-001', allowed_paths: ['src/a.ts'] }]);
    const r = runPact(['run-cycle', 'prepare', `--owner-pid=${ALIVE_PID}`, '--session=drive'], dir);
    assert.equal(r.status, 0, r.stderr);
    const cb = cbOf(dir);
    assert.ok(cb.owner, 'owner 필드 존재');
    assert.equal(cb.owner.pid, ALIVE_PID);
    assert.equal(cb.owner.session, 'drive');
    assert.ok(cb.owner.stamped_at, 'stamped_at 존재');
  } finally { cleanupProject(dir); }
});

test('owner gate — 살아있는 타 세션 소유면 adopt 거부(cycle-busy, spawn 전 정지)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'OWN-001', allowed_paths: ['src/a.ts'] }]);
    // 세션 A(살아있는 ALIVE_PID)가 소유권 stamp
    const a = runPact(['run-cycle', 'prepare', `--owner-pid=${ALIVE_PID}`, '--session=A'], dir);
    assert.equal(a.status, 0, a.stderr);
    // 세션 B(다른 pid)가 재개 시도 → 기록된 owner(살아있음)와 달라 거부
    const b = runPact(['run-cycle', 'prepare', `--owner-pid=${DEAD_PID}`, '--session=B'], dir);
    assert.equal(b.status, 1, 'cycle-busy 는 exit 1');
    const out = JSON.parse(b.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'cycle-busy');
    assert.match(out.error, /다른 세션/);
    assert.match(out.error, new RegExp(String(ALIVE_PID)));
  } finally { cleanupProject(dir); }
});

test('owner gate — 죽은 owner 는 재개 허용(크래시 resume) + 호출자로 재스탬프', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'OWN-001', allowed_paths: ['src/a.ts'] }]);
    // 크래시한 세션(죽은 DEAD_PID)이 소유권 stamp 하고 사라짐
    const a = runPact(['run-cycle', 'prepare', `--owner-pid=${DEAD_PID}`, '--session=dead'], dir);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(cbOf(dir).owner.pid, DEAD_PID);
    // 새 세션(살아있는 ALIVE_PID)이 재개 → 죽은 owner 이므로 adopt 허용
    const b = runPact(['run-cycle', 'prepare', `--owner-pid=${ALIVE_PID}`, '--session=live'], dir);
    assert.equal(b.status, 0, b.stderr);
    const out = JSON.parse(b.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.already_prepared, true);
    // 소유권이 산 호출자로 이전됨(이후 세션의 이중 채택 방지)
    assert.equal(cbOf(dir).owner.pid, ALIVE_PID);
  } finally { cleanupProject(dir); }
});

test('owner gate — --owner-pid 미제공이면 게이트 skip(하위호환)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'OWN-001', allowed_paths: ['src/a.ts'] }]);
    // 살아있는 owner 가 stamp 돼 있어도
    runPact(['run-cycle', 'prepare', `--owner-pid=${ALIVE_PID}`, '--session=A'], dir);
    // owner-pid 없이 호출하면 게이트 자체를 건너뛴다(구버전 호출자)
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.already_prepared, true, '거부되지 않고 멱등 재개');
  } finally { cleanupProject(dir); }
});

test('owner gate — collect 후 owner clear(current_batch 소비)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'OWN-001', allowed_paths: ['src/a.ts'] }]);
    runPact(['run-cycle', 'prepare', `--owner-pid=${ALIVE_PID}`, '--session=drive'], dir);
    assert.ok(fs.existsSync(path.join(dir, '.pact/current_batch.json')));
    const c = runPact(['run-cycle', 'collect'], dir);
    assert.equal(c.status, 0, c.stderr);
    // collect 는 current_batch.json 을 소비(삭제) → owner 도 함께 clear
    assert.equal(fs.existsSync(path.join(dir, '.pact/current_batch.json')), false);
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

// ─── SPD-5 (P1-4): report.md 결정적 렌더 + 존재 게이트 ──────

test('SPD-5 — report.md 없어도 collect 가 status.json 에서 렌더 → 머지 성공', () => {
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
      summary: '워커 시뮬 — src/a.ts 단일 export.',
      completed_at: new Date().toISOString(),
    }, null, 2));
    // report.md 의도적 미작성 — collect 의 report-gen 이 렌더해야 한다.

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 0, col.stderr);
    const colOut = JSON.parse(col.stdout);
    assert.deepEqual(colOut.merged, ['PROJ-001']);
    // report.md 가 status.json 에서 렌더돼 디스크에 존재해야 한다.
    const md = fs.readFileSync(path.join(dir, tp.report_path), 'utf8');
    assert.match(md, /pact report-gen/);
    assert.match(md, /워커 시뮬 — src\/a\.ts 단일 export/);
    // 관찰용 report_gen 필드에 rendered 로 기록.
    assert.ok(
      colOut.report_gen.some(r => r.task_id === 'PROJ-001' && r.action === 'rendered'),
      `report_gen: ${JSON.stringify(colOut.report_gen)}`,
    );
  } finally { cleanupProject(dir); }
});

test('SPD-5 — 짧은 수기 report.md 존재하면 존중(덮어쓰기 X) + 머지 성공 (10줄 게이트 제거)', () => {
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
    // 비공백 3줄 (예전 10줄 게이트라면 reject 됐을 것) — 이제 존재만 하면 통과.
    const handWritten = ['# 수기 리포트', '', '특수 서사만 3줄.', '끝.', ''].join('\n');
    fs.writeFileSync(path.join(dir, tp.report_path), handWritten);

    const col = runPact(['run-cycle', 'collect'], dir);
    assert.equal(col.status, 0, col.stderr);
    const colOut = JSON.parse(col.stdout);
    assert.deepEqual(colOut.merged, ['PROJ-001']);
    // 수기 report.md 는 그대로 보존(report-gen 이 존중, skip).
    assert.equal(fs.readFileSync(path.join(dir, tp.report_path), 'utf8'), handWritten);
    assert.ok(
      colOut.report_gen.some(r => r.task_id === 'PROJ-001' && r.action === 'skipped'),
      `report_gen: ${JSON.stringify(colOut.report_gen)}`,
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

// ─── P2-1 · SPD-2: prepare --graph 전체 DAG emit + admit 온디맨드 ──────

test('prepare --graph — batch0 밖 pending task + ready-set 를 task_graph 로 emit', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'GRAPH-001', allowed_paths: ['src/a.ts'] },
      { id: 'GRAPH-002', allowed_paths: ['src/b.ts'] },
      { id: 'GRAPH-003', allowed_paths: ['src/c.ts'], dependencies: ['GRAPH-002'] },
    ]);
    const r = runPact(['run-cycle', 'prepare', '--max=1', '--graph'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    // --max=1 → batch0 = [GRAPH-001]
    assert.deepEqual(out.task_prompts.map(t => t.task_id), ['GRAPH-001']);
    assert.ok(out.task_graph, 'task_graph 필드 존재');
    // batch0 task 는 graph 에서 제외, 나머지 pending 만 포함
    assert.ok(!('GRAPH-001' in out.task_graph.tasks), 'batch0 task 는 graph.tasks 에서 제외');
    assert.ok('GRAPH-002' in out.task_graph.tasks, 'overflow ready task 포함');
    assert.ok('GRAPH-003' in out.task_graph.tasks, 'dep-blocked task 포함');
    // GRAPH-002 는 deps 없음 → ready. GRAPH-003 은 GRAPH-002 미완 → not ready.
    assert.deepEqual(out.task_graph.ready, ['GRAPH-002']);
    assert.deepEqual(out.task_graph.tasks['GRAPH-003'].deps, ['GRAPH-002']);
    assert.deepEqual(out.task_graph.tasks['GRAPH-002'].allowed_paths, ['src/b.ts']);
    assert.equal(out.task_graph.tasks['GRAPH-002'].status, 'todo');
    assert.equal(out.task_graph.tasks['GRAPH-003'].title, 'GRAPH-003');
  } finally { cleanupProject(dir); }
});

test('prepare (--graph 없음) — task_graph 미출력 (기존 출력 100% 불변)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'NG-001', allowed_paths: ['src/a.ts'] },
      { id: 'NG-002', allowed_paths: ['src/b.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.task_graph, undefined, '--graph 없으면 task_graph 필드 없음');
    assert.equal(out.task_prompts.length, 2);
  } finally { cleanupProject(dir); }
});

test('admit — 신규 task worktree + payload 생성 + task_prompt 반환 + current_batch 추가', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'ADM-001', allowed_paths: ['src/a.ts'] },
      { id: 'ADM-002', allowed_paths: ['src/b.ts'] },
    ]);
    const prep = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    assert.equal(prep.status, 0, prep.stderr);
    const prepOut = JSON.parse(prep.stdout);
    assert.deepEqual(prepOut.task_prompts.map(t => t.task_id), ['ADM-001']);

    // ADM-002 를 in-flight=ADM-001 과 함께 admit — 경로 안 겹침 → 성공
    const adm = runPact(['run-cycle', 'admit', 'ADM-002', '--in-flight=ADM-001'], dir);
    assert.equal(adm.status, 0, `stderr: ${adm.stderr}\nstdout: ${adm.stdout}`);
    const admOut = JSON.parse(adm.stdout);
    assert.equal(admOut.ok, true);
    // task_prompt 는 prepare 의 task_prompts 원소와 동일 shape
    assert.equal(admOut.task_prompt.task_id, 'ADM-002');
    assert.match(admOut.task_prompt.task_prompt, /ADM-002/);
    assert.ok(admOut.task_prompt.prompt_path && admOut.task_prompt.context_path);
    assert.ok(admOut.task_prompt.status_path && admOut.task_prompt.report_path);

    assert.ok(fs.existsSync(path.join(dir, admOut.task_prompt.working_dir)), 'admit worktree 생성');
    assert.ok(fs.existsSync(path.join(dir, admOut.task_prompt.prompt_path)), 'admit prompt.md 생성');
    assert.ok(fs.existsSync(path.join(dir, '.pact/runs/ADM-002/payload.json')), 'admit payload.json 생성');

    const cb = JSON.parse(fs.readFileSync(path.join(dir, '.pact/current_batch.json'), 'utf8'));
    assert.ok(cb.task_ids.includes('ADM-001'), 'batch0 task 유지');
    assert.ok(cb.task_ids.includes('ADM-002'), 'admit task 가 current_batch 에 추가됨');
  } finally { cleanupProject(dir); }
});

test('admit — in-flight 과 allowed_paths 겹치면 path_overlap 거부 (worktree 미생성)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'OVL-001', allowed_paths: ['src/shared.ts'] },
      { id: 'OVL-002', allowed_paths: ['src/shared.ts'] },
    ]);
    const prep = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    const prepOut = JSON.parse(prep.stdout);
    // 경로 겹쳐 어차피 batch0 는 1개
    assert.equal(prepOut.task_prompts.length, 1);
    const inflight = prepOut.task_prompts[0].task_id;
    const other = inflight === 'OVL-001' ? 'OVL-002' : 'OVL-001';

    const adm = runPact(['run-cycle', 'admit', other, `--in-flight=${inflight}`], dir);
    assert.equal(adm.status, 0, `path_overlap 은 정상 거절(에러 아님): ${adm.stdout}`);
    const admOut = JSON.parse(adm.stdout);
    assert.equal(admOut.ok, false);
    assert.equal(admOut.reason, 'path_overlap');
    assert.ok((admOut.conflicts || []).includes(inflight), 'conflicts 에 in-flight id');
    assert.equal(
      fs.existsSync(path.join(dir, `.pact/worktrees/${other}`)),
      false,
      'path_overlap 거부 시 worktree 미생성',
    );
  } finally { cleanupProject(dir); }
});

test('admit — 멱등: 이미 준비된 task 재admit 은 재생성 없이 기존 payload 반환', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'RADM-001', allowed_paths: ['src/a.ts'] },
      { id: 'RADM-002', allowed_paths: ['src/b.ts'] },
    ]);
    runPact(['run-cycle', 'prepare', '--max=1'], dir); // batch0 = [RADM-001]
    const adm1 = JSON.parse(runPact(['run-cycle', 'admit', 'RADM-002', '--in-flight=RADM-001'], dir).stdout);
    assert.equal(adm1.ok, true);
    assert.notEqual(adm1.already_prepared, true, '첫 admit 은 신규 생성');

    const payloadPath = path.join(dir, '.pact/runs/RADM-002/payload.json');
    const before = fs.readFileSync(payloadPath, 'utf8');

    const adm2 = JSON.parse(runPact(['run-cycle', 'admit', 'RADM-002', '--in-flight=RADM-001'], dir).stdout);
    assert.equal(adm2.ok, true);
    assert.equal(adm2.already_prepared, true, '재admit 은 멱등(already_prepared)');
    assert.equal(adm2.task_prompt.task_id, 'RADM-002');
    assert.equal(fs.readFileSync(payloadPath, 'utf8'), before, 'payload 재생성 안 됨');

    const cb = JSON.parse(fs.readFileSync(path.join(dir, '.pact/current_batch.json'), 'utf8'));
    assert.equal(cb.task_ids.filter(id => id === 'RADM-002').length, 1, 'current_batch 중복 추가 없음');
  } finally { cleanupProject(dir); }
});

test('admit — 존재하지 않는 task_id 는 실패(exit 1)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [{ id: 'REAL-001', allowed_paths: ['src/a.ts'] }]);
    runPact(['run-cycle', 'prepare', '--max=1'], dir);
    const adm = runPact(['run-cycle', 'admit', 'GHOST-999', '--in-flight=REAL-001'], dir);
    assert.equal(adm.status, 1, adm.stdout);
    const admOut = JSON.parse(adm.stdout);
    assert.equal(admOut.ok, false);
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

// ─── P2-2 · SPD-1: prepare 는 allowed_paths 를 task_prompts 로 전달(슬롯 풀 게이팅용) ──
test('prepare — task_prompts 원소에 allowed_paths 포함(추가 필드, 하위호환)', () => {
  const dir = makeProject();
  try {
    writeTasks(dir, [
      { id: 'AP-001', allowed_paths: ['src/a.ts', 'src/b.ts'] },
    ]);
    const r = runPact(['run-cycle', 'prepare', '--max=1'], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const tp = out.task_prompts.find(t => t.task_id === 'AP-001');
    assert.deepEqual(tp.allowed_paths, ['src/a.ts', 'src/b.ts'], 'allowed_paths 전달');
  } finally { cleanupProject(dir); }
});

// ─── P2-2 · SPD-1: collect-one 단건 머지(게이트 경유) ────────────
function simWorker(dir, tp, fname) {
  const wtAbs = path.join(dir, tp.working_dir);
  fs.mkdirSync(path.join(wtAbs, path.dirname(fname)), { recursive: true });
  fs.writeFileSync(path.join(wtAbs, fname), `export const ${tp.task_id.replace(/-/g, '_')} = true;\n`);
  sh(`git add . && git commit -m "${tp.task_id} work"`, { cwd: wtAbs });
  fs.writeFileSync(path.join(dir, tp.status_path), mkStatus(tp.task_id, fname));
  fs.writeFileSync(path.join(dir, tp.report_path), mkReport(tp.task_id));
}

test('collect-one — eligible task 단건 머지 성공 + worktree 정리 + status done + merge-result append', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'ONE-001', allowed_paths: ['src/a.ts'] }]);
    const prep = JSON.parse(runPact(['run-cycle', 'prepare', '--max=1'], dir).stdout);
    const tp = prep.task_prompts[0];
    simWorker(dir, tp, 'src/a.ts');

    const col = runPact(['run-cycle', 'collect-one', 'ONE-001', '--commit-status'], dir);
    assert.equal(col.status, 0, `${col.stdout}\n${col.stderr}`);
    const out = JSON.parse(col.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.merged, ['ONE-001']);
    assert.equal(out.conflicted, null);
    // 게이트 통과 → main 에 반영
    assert.ok(fs.existsSync(path.join(dir, 'src/a.ts')), 'main 에 머지됨');
    // worktree 정리
    assert.equal(fs.existsSync(path.join(dir, tp.working_dir)), false, 'worktree 제거됨');
    // status done + 커밋 → tree clean
    const tasksMd = fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf8');
    assert.match(tasksMd, /## ONE-001[\s\S]*?status: done/);
    const porcelain = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(porcelain, '', '--commit-status 로 tree clean');
    // merge-result.json append 포맷(기존 소비 필드 유지)
    const mr = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.deepEqual(mr.merged, ['ONE-001']);
    assert.equal(mr.single_merge, true);
    assert.deepEqual(mr.verification_summary, { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' });
    assert.ok('decisions_to_record' in mr && Array.isArray(mr.failures));
    // current_batch 에서 ONE-001 제거(비면 파일 삭제)
    assert.equal(fs.existsSync(path.join(dir, '.pact/current_batch.json')), false, 'current_batch 정리');
  } finally { cleanupProject(dir); }
});

test('collect-one — 두 task 순차 collect-one 은 merge-result 에 누적(append)', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [
      { id: 'ACC-001', allowed_paths: ['src/a.ts'] },
      { id: 'ACC-002', allowed_paths: ['src/b.ts'] },
    ]);
    const prep = JSON.parse(runPact(['run-cycle', 'prepare', '--max=2'], dir).stdout);
    for (const tp of prep.task_prompts) simWorker(dir, tp, tp.task_id === 'ACC-001' ? 'src/a.ts' : 'src/b.ts');

    const c1 = JSON.parse(runPact(['run-cycle', 'collect-one', 'ACC-001', '--commit-status'], dir).stdout);
    assert.deepEqual(c1.merged, ['ACC-001']);
    const c2 = JSON.parse(runPact(['run-cycle', 'collect-one', 'ACC-002', '--commit-status'], dir).stdout);
    assert.deepEqual(c2.merged, ['ACC-002']);

    const mr = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.deepEqual(mr.merged.sort(), ['ACC-001', 'ACC-002'], '두 단건 머지가 누적');
    assert.ok(fs.existsSync(path.join(dir, 'src/a.ts')) && fs.existsSync(path.join(dir, 'src/b.ts')));
  } finally { cleanupProject(dir); }
});

test('collect-one — 다음 사이클(prepare 재실행)은 merge-result 를 이월하지 않고 현재 사이클만 (ORCH-1/CI-1)', () => {
  // `pact drive` 를 두 번(또는 --cycles>1) 돌리는 것과 동형: 사이클1 collect-one 후 사이클2 prepare
  // 가 새 prepared_at 을 찍으면, 사이클2 의 collect-one 은 사이클1 산출물 위에 누적하지 않는다.
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [
      { id: 'CYC-001', allowed_paths: ['src/a.ts'] },
      { id: 'CYC-002', allowed_paths: ['src/b.ts'], dependencies: ['CYC-001'] }, // 다음 사이클로 밀림
    ]);

    // ── 사이클 1: CYC-001 만 준비·머지 ──
    const p1 = JSON.parse(runPact(['run-cycle', 'prepare', '--max=5'], dir).stdout);
    assert.deepEqual(p1.task_prompts.map(t => t.task_id), ['CYC-001'], 'CYC-002 는 의존으로 배치0 제외');
    simWorker(dir, p1.task_prompts[0], 'src/a.ts');
    const c1 = JSON.parse(runPact(['run-cycle', 'collect-one', 'CYC-001', '--commit-status'], dir).stdout);
    assert.deepEqual(c1.merged, ['CYC-001']);
    const mr1 = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.deepEqual(mr1.merged, ['CYC-001']);
    const cycle1Id = mr1.cycle_id;
    assert.ok(cycle1Id, 'cycle_id 마커 기록됨');

    // ── 사이클 2: CYC-001 는 이제 done → prepare 가 CYC-002 로 새 사이클(새 prepared_at) 시작 ──
    const p2 = JSON.parse(runPact(['run-cycle', 'prepare', '--max=5'], dir).stdout);
    assert.deepEqual(p2.task_prompts.map(t => t.task_id), ['CYC-002'], '사이클2 배치0 = CYC-002');
    const cb2 = JSON.parse(fs.readFileSync(path.join(dir, '.pact/current_batch.json'), 'utf8'));
    assert.notEqual(cb2.prepared_at, cycle1Id, '사이클2 prepared_at 은 사이클1 과 다름');
    simWorker(dir, p2.task_prompts[0], 'src/b.ts');
    const c2 = JSON.parse(runPact(['run-cycle', 'collect-one', 'CYC-002', '--commit-status'], dir).stdout);
    assert.deepEqual(c2.merged, ['CYC-002']);

    // 핵심: merge-result 는 이번(2번째) 사이클만 — CYC-001 이 이월돼 누적되면 안 됨.
    const mr2 = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.deepEqual(mr2.merged, ['CYC-002'], '이전 사이클(CYC-001) 이월 없이 현재 사이클만');
    assert.equal(mr2.cycle_id, cb2.prepared_at, 'cycle_id 가 현재 사이클로 갱신됨');
    assert.notEqual(mr2.cycle_id, cycle1Id);
  } finally { cleanupProject(dir); }
});

test('collect-one — 사이클 중간에 current_batch 가 비어 삭제됐다 admit 으로 재생성돼도 같은 사이클로 누적 (ORCH-1 admit 상호작용)', () => {
  // K-슬롯 파이프라인(특히 --max=1)은 admit→collect-one 을 인터리브한다. collect-one 이
  // current_batch 를 비워 삭제한 뒤 다음 admit 이 파일을 재생성할 때 새 prepared_at 을 찍으면
  // cycle_id 가 갈려 merge-result 가 사이클 중간에 리셋된다 → /pact:wrap 이 이전 task 들의
  // decisions 를 놓친다. admit 은 진행 중 사이클(merge-result.cycle_id)을 재사용해야 한다.
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [
      { id: 'MIX-001', allowed_paths: ['src/a.ts'] },
      { id: 'MIX-002', allowed_paths: ['src/b.ts'] },
    ]);
    // 사이클1: batch0 = MIX-001 (max=1). collect-one 이 current_batch 를 비워 삭제.
    const prep = JSON.parse(runPact(['run-cycle', 'prepare', '--max=1'], dir).stdout);
    const tp1 = prep.task_prompts[0];
    simWorker(dir, tp1, 'src/a.ts');
    const c1 = JSON.parse(runPact(['run-cycle', 'collect-one', tp1.task_id, '--commit-status'], dir).stdout);
    assert.deepEqual(c1.merged, [tp1.task_id]);
    assert.equal(fs.existsSync(path.join(dir, '.pact/current_batch.json')), false, 'batch 비면 삭제');
    const cycleId = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8')).cycle_id;

    // 슬롯이 비어 MIX-002 를 admit (같은 사이클) → collect-one.
    const adm = JSON.parse(runPact(['run-cycle', 'admit', 'MIX-002', '--in-flight='], dir).stdout);
    assert.notEqual(adm.ok, false, `admit 성공: ${JSON.stringify(adm)}`);
    simWorker(dir, adm.task_prompt, 'src/b.ts');
    const c2 = JSON.parse(runPact(['run-cycle', 'collect-one', 'MIX-002', '--commit-status'], dir).stdout);
    assert.deepEqual(c2.merged, ['MIX-002']);

    const mr = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.deepEqual(mr.merged.sort(), ['MIX-001', 'MIX-002'], 'admit 로 batch 재생성돼도 같은 사이클로 누적');
    assert.equal(mr.cycle_id, cycleId, 'cycle_id 유지(admit 이 새 사이클을 만들지 않음)');
  } finally { cleanupProject(dir); }
});

test('collect-one — status.json 없으면 rejected (머지 안 함, 게이트 유지)', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'REJ-001', allowed_paths: ['src/a.ts'] }]);
    runPact(['run-cycle', 'prepare', '--max=1'], dir);
    // 워커 시뮬 없음 → status.json 미작성

    const col = runPact(['run-cycle', 'collect-one', 'REJ-001'], dir);
    assert.equal(col.status, 0, col.stderr);
    const out = JSON.parse(col.stdout);
    assert.deepEqual(out.merged, []);
    assert.ok(out.rejected.some(r => r.task_id === 'REJ-001' && /status\.json missing/.test(r.reason)));
    assert.equal(out.conflicted, null);
    assert.equal(fs.existsSync(path.join(dir, 'src/a.ts')), false, '머지 안 됨');
  } finally { cleanupProject(dir); }
});

test('collect-one — 실제 충돌이면 conflicted 필드(정지 신호, 자동해결 X)', () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.pact/\n');
    sh('git add .gitignore && git commit -m gitignore', { cwd: dir });
    writeTasks(dir, [{ id: 'CFL-001', allowed_paths: ['src/a.ts'] }]);
    const prep = JSON.parse(runPact(['run-cycle', 'prepare', '--max=1'], dir).stdout);
    const tp = prep.task_prompts[0];
    simWorker(dir, tp, 'src/a.ts');

    // main 에 같은 파일을 다른 내용으로 커밋 → pact/CFL-001 머지 시 add/add 충돌 유발.
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const MAIN_CONFLICT = 1;\n');
    sh('git add src/a.ts && git commit -m "main conflicting a.ts"', { cwd: dir });

    const col = runPact(['run-cycle', 'collect-one', 'CFL-001'], dir);
    assert.equal(col.status, 0, `${col.stdout}\n${col.stderr}`);
    const out = JSON.parse(col.stdout);
    assert.deepEqual(out.merged, []);
    assert.ok(out.conflicted, `conflicted 필드 존재: ${col.stdout}`);
    assert.equal(out.conflicted.task_id, 'CFL-001');
    // 충돌은 자동해결 안 함 → merge-result 에도 conflicted 기록
    const mr = JSON.parse(fs.readFileSync(path.join(dir, '.pact/merge-result.json'), 'utf8'));
    assert.ok(mr.conflicted && mr.conflicted.task_id === 'CFL-001');
  } finally { cleanupProject(dir); }
});
