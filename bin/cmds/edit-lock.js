'use strict';

// pact edit-lock <target> — 자유 수정 단계 멀티세션 안전망 (v0.7.0).
// target = 모듈 이름(auth) 또는 파일 경로(PROGRESS.md).
// session_label 우선순위: --session > $PACT_SESSION > ppid.

const { acquireEditLock } = require('../../scripts/edit-lock.js');
const { resolveSessionLabel } = require('./claim.js');

function parseArgs(args) {
  let target = null;
  let explicit = null;
  let kind = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session' || a === '--label') explicit = args[++i];
    else if (a === '--kind') kind = args[++i];
    else if (a === '--json') json = true;
    else if (!target && !a.startsWith('-')) target = a;
  }
  return { target, explicit, kind, json };
}

module.exports = function editLockCli(args) {
  const { target, explicit, kind, json } = parseArgs(args);
  if (!target) {
    console.error('Usage: pact edit-lock <target> [--kind module|file] [--session <label>] [--json]');
    console.error('  target: 모듈 이름(auth) 또는 파일 경로(PROGRESS.md)');
    process.exit(2);
  }

  const cwd = process.cwd();
  const sessionLabel = resolveSessionLabel(explicit);
  const r = acquireEditLock(target, { cwd, sessionLabel, kind });

  if (json) {
    process.stdout.write(JSON.stringify({ ...r, session_label: sessionLabel }, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  }

  if (!r.ok) {
    console.error(`✗ ${target} edit-lock 실패: ${r.error}`);
    process.exit(1);
  }

  console.log(`✓ ${target} edit-lock (${r.action}) — session=${sessionLabel}, kind=${r.kind}`);
  if (r.paths.length > 0) {
    console.log(`  보호 경로 (${r.paths.length}):`);
    r.paths.forEach(p => console.log(`    - ${p}`));
  }
  console.log('\n다른 세션이 이 경로에 Write/Edit 시도 시 pre-tool-guard가 차단합니다.');
  console.log(`해제: pact edit-release ${target}`);
};
