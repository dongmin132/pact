'use strict';

// pact metrics — git-ro.js
// read-only git 래퍼. 화이트리스트 밖 명령(특히 mutating)은 거부한다.
// 대상 프로젝트(brewdy 등)를 절대 변경하지 않기 위한 1차 방어선.

const { execFileSync } = require('child_process');

// 워킹트리·인덱스·ref 를 건드리지 않는 plumbing/porcelain 만 허용.
const READONLY = new Set([
  'log', 'show', 'diff', 'rev-list', 'cat-file',
  'for-each-ref', 'merge-base', 'name-rev', 'rev-parse', 'shortlog',
]);

/**
 * read-only git 실행. 화이트리스트 밖이면 throw.
 * @param {string} cwd  대상 repo 경로
 * @param {string[]} args  git 인자 (args[0] = 서브커맨드)
 * @param {{allowFail?: boolean}} [opt]  실패 허용(기본 true) — repo 아니거나 빈 히스토리 등
 * @returns {string} stdout (실패+allowFail 시 '')
 */
function git(cwd, args, opt = {}) {
  const { allowFail = true } = opt;
  const sub = args[0];
  if (!READONLY.has(sub)) {
    throw new Error(`git-ro: 비-readonly 또는 미허용 git 명령 거부: '${sub}'`);
  }
  try {
    return execFileSync('git', ['-C', cwd, '--no-pager', ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

module.exports = { git, READONLY };
