'use strict';

// pact edit-release <target> — edit-lock 해제 + 간단 drift 알림.
// 자기 session_label과 일치할 때만 해제 (force 옵션).

const { spawnSync } = require('child_process');
const path = require('path');
const { releaseEditLock, listEditLocks } = require('../../scripts/edit-lock.js');
const { resolveSessionLabel } = require('./claim.js');

function parseArgs(args) {
  let target = null;
  let explicit = null;
  let force = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session' || a === '--label') explicit = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--json') json = true;
    else if (!target && !a.startsWith('-')) target = a;
  }
  return { target, explicit, force, json };
}

/** lock 보호 경로에서 코드/contracts 변경 분리 (drift 힌트). */
function analyzeDrift(paths, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  // 최근 git status로 unstaged 변경 추출
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;

  const lines = r.stdout.split('\n').filter(Boolean);
  const changed = lines
    .map(l => {
      const m = l.match(/^.{2,3}\s+(.+?)(?:\s->\s(.+))?$/);
      return m ? (m[2] || m[1]) : null;
    })
    .filter(Boolean);

  const codeRe = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb)$/;
  const contractRe = /^contracts\//;

  const codeChanges = changed.filter(p => codeRe.test(p));
  const contractChanges = changed.filter(p => contractRe.test(p));

  return { code: codeChanges, contract: contractChanges, all: changed };
}

module.exports = function editReleaseCli(args) {
  const { target, explicit, force, json } = parseArgs(args);
  if (!target) {
    console.error('Usage: pact edit-release <target> [--session <label>] [--force] [--json]');
    process.exit(2);
  }

  const cwd = process.cwd();
  const sessionLabel = resolveSessionLabel(explicit);

  // release 전에 lock 정보 캡처 (drift 분석용)
  const before = listEditLocks({ cwd }).find(l => l.target === target);

  const r = releaseEditLock(target, { cwd, sessionLabel, force });
  if (!r.ok) {
    if (json) process.stdout.write(JSON.stringify(r) + '\n');
    else console.error(`✗ ${target} edit-release 실패: ${r.error}`);
    process.exit(1);
  }

  // drift 알림
  const drift = before ? analyzeDrift(before.paths, { cwd }) : null;

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, removed: r.removed, drift }, null, 2) + '\n');
    return;
  }

  if (!r.removed) {
    console.log(`${target}: 잡혀있던 lock 없음`);
    return;
  }

  console.log(`✓ ${target} edit-release`);
  if (drift && drift.all.length > 0) {
    console.log(`\n📝 마지막 acquire 이후 변경 (${drift.all.length}):`);
    drift.all.slice(0, 10).forEach(p => console.log(`  - ${p}`));
    if (drift.all.length > 10) console.log(`  (${drift.all.length - 10}개 더)`);

    if (drift.code.length > 0 && drift.contract.length === 0) {
      console.log('\n⚠️ 코드만 변경 + contracts 갱신 0 → 문서 표류 가능.');
      console.log('   /pact:verify 또는 /pact:reflect로 점검 권장.');
    }
  }
};
