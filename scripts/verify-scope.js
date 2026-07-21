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

// 사이클당 한 번, 사이클 끝에만 찍히는 마커 — 이전 사이클 경계 판정용(H7-2).
// ※ 'pact: cycle status updates' 는 인터랙티브 파이프라인에서 collect-one 머지마다 찍혀
//   사이클 중간에 나타나므로 경계로 쓰면 안 된다. 트레일링 스킵 대상일 뿐(아래 분리).
const CYCLE_BOUNDARY = 'pact: cycle bookkeeping';
// 트레일링(사이클 끝) md-only 커밋 — 스킵 대상(경계 판정과 무관).
const TRAILING_MD_SUBJECTS = new Set([
  'pact: cycle bookkeeping',
  'pact: cycle status updates',
]);

function isCycleBoundary(subject) {
  return (subject || '').trim() === CYCLE_BOUNDARY;
}
function isTrailingMd(subject) {
  return TRAILING_MD_SUBJECTS.has((subject || '').trim());
}
// 하위호환 export 유지(테스트·소비자용) — 트레일링 md 판정.
function isBookkeeping(subject) {
  return isTrailingMd(subject);
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

  // --first-parent: 메인라인만 본다. pact 는 --no-ff 로 머지하므로, 이걸 빼면 머지된 브랜치의 내부
  // 커밋이 로그에 뒤섞여 no-boundary 폴백의 '가장 오래된 커밋'이 사이클 base 가 아닌 브랜치 work
  // 커밋으로 잘못 잡혀 코드 머지를 놓친다(도그푸드 실측). 경계(bookkeeping)·status 커밋은 모두
  // 메인라인 커밋이라 --first-parent 로도 그대로 보인다.
  const log = git(cwd, ['log', '--first-parent', '--format=%H%x09%s', '-n', String(window)]);
  if (log.status !== 0) {
    return { ok: false, error: (log.stderr || '').trim() || 'git log 실패 (git 저장소 아님?)', code_changed: true, files: [] };
  }
  const commits = (log.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    return { hash: l.slice(0, tab), subject: l.slice(tab + 1) };
  });
  if (!commits.length) return { ok: true, code_changed: false, files: [], reason: 'no commits' };

  // 1) 트레일링 md-only(bookkeeping/status updates) 건너뛰기 → 이번 사이클 마지막 작업 커밋.
  let i = 0;
  while (i < commits.length && isTrailingMd(commits[i].subject)) i++;
  if (i >= commits.length) {
    // 창 전체가 md-only — 코드 작업 없음.
    return { ok: true, code_changed: false, files: [], reason: 'all-bookkeeping' };
  }

  // 2) 이전 사이클 경계(bookkeeping 단독)를 찾는다 — 그 커밋의 트리 = 이번 사이클 시작 직전 상태.
  //    사이클 중간의 'status updates' 커밋은 경계가 아니라 건너뛴다(H7-2: 인터랙티브 오경계 방지).
  let k = i;
  while (k < commits.length && !isCycleBoundary(commits[k].subject)) k++;

  let from;
  if (k < commits.length) {
    from = commits[k].hash;               // 이전 사이클 bookkeeping — 그 트리부터 HEAD 까지가 이번 사이클
  } else {
    // 창 안에 이전 경계 없음. 창이 가득 찼으면 경계가 창 밖일 수 있어 판정 불확실 → fail-safe true.
    if (commits.length >= window) {
      return { ok: true, code_changed: true, files: [], reason: 'boundary-not-found-fail-safe' };
    }
    // 히스토리가 창보다 짧다 = 전 이력을 봤고 이전 사이클 없음 → 가장 오래된 커밋 트리부터 diff.
    from = commits[commits.length - 1].hash;
  }

  // 3) from 트리부터 HEAD 까지 non-md/docs 파일 변경.
  const diff = git(cwd, ['diff', '--name-only', from, 'HEAD', '--', '.', ':!*.md', ':!docs/']);
  if (diff.status !== 0) {
    // diff 실패 시 안전하게 code_changed=true (false-skip 금지).
    return { ok: true, code_changed: true, files: [], from, reason: 'diff-failed-fail-safe' };
  }
  const files = (diff.stdout || '').trim().split('\n').filter(Boolean);
  return { ok: true, code_changed: files.length > 0, files, from };
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
