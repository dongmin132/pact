'use strict';

// verify-scope — 이번 pact 사이클이 코드 파일을 건드렸는지 결정적으로 판정(C-4/H7).
//
// 문제: /pact:verify 의 docs-only 스킵이 `git diff HEAD~1` 단일 커밋만 봤다. 표준 사이클은
//   코드 머지(--no-ff) 뒤에 항상 md-only bookkeeping/status 커밋이 붙어(‘pact: cycle bookkeeping’,
//   ‘pact: cycle status updates’) HEAD 가 늘 마크다운 전용이 된다 → 코드 대량 머지 사이클도
//   docs-only 로 오판돼 Code 축(lint/typecheck/test/build)이 항상 skip 됐다(검증 없이 병합 방지의
//   사후 검증 축 무력화).
//
// 해법(결정적 = CLI): 트레일링 bookkeeping 커밋을 건너뛰고, 이전 사이클 경계(직전 bookkeeping)까지를
//   이번 사이클 범위로 잡아 그 범위의 non-md/docs 파일 변경을 본다. 판단은 LLM(verify.md)이 아니라
//   여기서 결정론적으로 내린다. false-skip 위험이 크므로 불확실하면 code_changed=true 로 기운다.

const { spawnSync } = require('child_process');

const BOOKKEEPING_SUBJECTS = new Set([
  'pact: cycle bookkeeping',
  'pact: cycle status updates',
]);

function isBookkeeping(subject) {
  return BOOKKEEPING_SUBJECTS.has((subject || '').trim());
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * 이번 사이클의 코드 파일 변경을 결정적으로 산출.
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.window] — 훑을 최근 커밋 수(기본 80)
 * @returns {{ok:boolean, code_changed:boolean, files:string[], from?:string, base?:string, error?:string, reason?:string}}
 */
function cycleCodeChanges(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const window = opts.window || 80;

  const log = git(cwd, ['log', '--format=%H%x09%s', '-n', String(window)]);
  if (log.status !== 0) {
    return { ok: false, error: (log.stderr || '').trim() || 'git log 실패 (git 저장소 아님?)', code_changed: true, files: [] };
  }
  const commits = (log.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    return { hash: l.slice(0, tab), subject: l.slice(tab + 1) };
  });
  if (!commits.length) return { ok: true, code_changed: false, files: [], reason: 'no commits' };

  // 1) 트레일링 bookkeeping/status(md-only) 건너뛰기 → 이번 사이클 마지막 작업 커밋.
  let i = 0;
  while (i < commits.length && isBookkeeping(commits[i].subject)) i++;
  if (i >= commits.length) {
    // 창 전체가 bookkeeping — 코드 작업 없음.
    return { ok: true, code_changed: false, files: [], reason: 'all-bookkeeping' };
  }

  // 2) 이전 bookkeeping 경계까지 = 이번 사이클 첫 작업 커밋(base).
  let j = i;
  while (j + 1 < commits.length && !isBookkeeping(commits[j + 1].subject)) j++;
  const base = commits[j].hash;

  // 3) base 의 부모(있으면)부터 HEAD 까지 non-md/docs 파일 변경. 부모 없으면(루트) base 자신부터.
  const hasParent = git(cwd, ['rev-parse', '--verify', '-q', `${base}^`]).status === 0;
  const from = hasParent ? `${base}^` : base;
  const diff = git(cwd, ['diff', '--name-only', from, 'HEAD', '--', '.', ':!*.md', ':!docs/']);
  if (diff.status !== 0) {
    // diff 실패 시 안전하게 code_changed=true (false-skip 금지).
    return { ok: true, code_changed: true, files: [], from, base, reason: 'diff-failed-fail-safe' };
  }
  const files = (diff.stdout || '').trim().split('\n').filter(Boolean);
  return { ok: true, code_changed: files.length > 0, files, from, base };
}

// CLI: pact verify-scope [--project <path>] [--json]
function runCli(argv = []) {
  let cwd = process.cwd();
  let json = false;
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--project') cwd = argv[++k] || cwd;
    else if (argv[k] === '--json') json = true;
  }
  const r = cycleCodeChanges({ cwd });
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else if (!r.ok) {
    console.error(`verify-scope 실패: ${r.error}`);
  } else if (r.code_changed) {
    console.log(`code_changed=true (${r.files.length}개 코드 파일) — Code 축 실행 필요`);
  } else {
    console.log(`code_changed=false (docs-only) — Code 축 skip 가능`);
  }
  process.exit(r.ok ? 0 : 1);
}

module.exports = { cycleCodeChanges, isBookkeeping, runCli };

if (require.main === module) runCli(process.argv.slice(2));
