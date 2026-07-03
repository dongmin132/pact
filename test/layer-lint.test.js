'use strict';

// STR-5 (P3-A) — 레이어 배치 lint
//
// bin/cmds/*.js 는 얇은 CLI 레이어다. 순수 로직 코어는 scripts/ 가 SOT.
// 형제 bin/cmds 를 라이브러리로 require 하면 레이어 역전(bin↔bin 순환·재사용 곤란)이 생긴다.
// 이 테스트는 bin/cmds/*.js 전수를 정적 스캔해 형제 bin/cmds import 를 차단한다.
//
// 허용 require 대상: node 내장/패키지(bare), ../../scripts/**, 레포 루트 모듈(batch-builder.js 등).
// 형제 bin/cmds import 는 실패 — 단, 아래 KNOWN_SIBLING_IMPORTS 화이트리스트만 예외(기회적 이관).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BIN_CMDS = path.join(REPO_ROOT, 'bin', 'cmds');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');

// 기회적 이관 원칙(전면 이관 금지): claim.js 가 소유한 resolveSessionLabel 세션 라벨 유틸을
// list-locks/edit-lock/edit-release 3파일이 형제 import 한다. claim.js 는 이 트랙(STR-5) 스코프
// 밖이라 지금 옮기지 않고 명시적 화이트리스트로 남긴다.
// TODO(STR-5 follow-up): claim.js 리팩터 시 resolveSessionLabel → scripts/session-label.js 로
//   이관하고 이 화이트리스트 항목 제거(그러면 아래 non-stale 테스트가 이를 강제한다).
const KNOWN_SIBLING_IMPORTS = [
  { from: 'list-locks.js', to: 'claim.js' },
  { from: 'edit-lock.js', to: 'claim.js' },
  { from: 'edit-release.js', to: 'claim.js' },
];

function listBinCmds() {
  return fs.readdirSync(BIN_CMDS).filter(f => f.endsWith('.js'));
}

/** require(path.join(SEGS)) 의 SEGS 문자열을 절대경로로 해석. 동적(변수) 세그먼트면 null. */
function resolveJoin(segStr, baseDir) {
  const tokens = segStr.split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  let base = baseDir;
  let rest = tokens;
  if (tokens[0] === '__dirname') { base = baseDir; rest = tokens.slice(1); }
  else if (tokens[0] === 'PLUGIN_ROOT') { base = REPO_ROOT; rest = tokens.slice(1); }
  const segs = [];
  for (const t of rest) {
    const m = t.match(/^['"](.*)['"]$/);
    if (!m) return null; // 동적 세그먼트 — 정적 해석 불가
    segs.push(m[1]);
  }
  return path.resolve(base, ...segs);
}

/**
 * 파일 텍스트에서 모든 require 타깃을 절대경로로 추출.
 * 두 형태만 지원(코드베이스 관례): require('literal') / require(path.join(...)).
 * bare 스펙(node 내장/패키지)·동적 세그먼트는 null(=레포 내부 아님)로 스킵.
 */
function extractRequireTargets(text, fileDir) {
  const targets = [];
  const joinRe = /require\(\s*path\.join\(([^)]*)\)\s*,?\s*\)/g;
  const litRe = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = joinRe.exec(text)) !== null) {
    const abs = resolveJoin(m[1], fileDir);
    if (abs) targets.push(abs);
  }
  while ((m = litRe.exec(text)) !== null) {
    const spec = m[2];
    if (spec.startsWith('.')) targets.push(path.resolve(fileDir, spec));
    // bare(=node 내장/패키지)는 레포 내부 아님 → 스킵
  }
  return targets;
}

function within(dir, abs) {
  const rel = path.relative(dir, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 레포 내부 require 타깃을 레이어로 분류. */
function classify(abs) {
  if (within(BIN_CMDS, abs)) return 'sibling';
  if (within(SCRIPTS, abs)) return 'scripts';
  if (path.dirname(abs) === REPO_ROOT) return 'repo-root';
  return 'other';
}

/** 전 bin/cmds 스캔 → { siblings:[{from,to}], others:[{from,target}] }. */
function scan() {
  const siblings = [];
  const others = [];
  for (const file of listBinCmds()) {
    const abs = path.join(BIN_CMDS, file);
    const text = fs.readFileSync(abs, 'utf8');
    for (const target of extractRequireTargets(text, BIN_CMDS)) {
      const kind = classify(target);
      if (kind === 'sibling') siblings.push({ from: file, to: path.basename(target) });
      else if (kind === 'other') others.push({ from: file, target: path.relative(REPO_ROOT, target) });
    }
  }
  return { siblings, others };
}

function isWhitelisted(s) {
  return KNOWN_SIBLING_IMPORTS.some(w => w.from === s.from && w.to === s.to);
}

test('layer-lint — bin/cmds 는 형제 bin/cmds 를 require 하지 않는다 (화이트리스트 제외)', () => {
  const { siblings } = scan();
  const offenders = siblings.filter(s => !isWhitelisted(s));
  assert.deepEqual(
    offenders, [],
    `레이어 역전: bin/cmds 가 형제 bin/cmds 를 import.\n` +
    offenders.map(o => `  ${o.from} → ./${o.to}  (순수 코어는 scripts/ 로 이관)`).join('\n'),
  );
});

test('layer-lint — 화이트리스트가 stale 하지 않다 (이관 완료 시 제거 강제)', () => {
  const { siblings } = scan();
  const stale = KNOWN_SIBLING_IMPORTS.filter(
    w => !siblings.some(s => s.from === w.from && s.to === w.to),
  );
  assert.deepEqual(
    stale, [],
    `stale 화이트리스트: 아래 형제 import 는 더 이상 없음 → KNOWN_SIBLING_IMPORTS 에서 제거.\n` +
    stale.map(w => `  ${w.from} → ./${w.to}`).join('\n'),
  );
});

test('layer-lint — 레포 내부 require 는 scripts/**·레포 루트·화이트리스트 형제만 (그 외 없음)', () => {
  const { others } = scan();
  assert.deepEqual(
    others, [],
    `허용되지 않은 레이어의 require:\n` +
    others.map(o => `  ${o.from} → ${o.target}`).join('\n'),
  );
});

test('layer-lint — moved 코어가 scripts 로 이관되어 형제 import 가 사라졌다 (STR-5 회귀)', () => {
  const { siblings } = scan();
  // planMerge(merge.js), collectLongDocs(context-guard.js) 를 run-cycle 이 형제 import 하던
  // 레이어 역전이 STR-5 로 제거됐다 — 다시 생기면 실패.
  const regressions = siblings.filter(s =>
    s.from === 'run-cycle.js' && (s.to === 'merge.js' || s.to === 'context-guard.js'),
  );
  assert.deepEqual(regressions, [], 'run-cycle → merge.js/context-guard.js 형제 import 재발');
});
