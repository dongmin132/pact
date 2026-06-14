'use strict';

// 원자적 파일 쓰기 — temp 파일에 쓰고 fsync 후 rename.
// rename 은 같은 파일시스템에서 원자적이므로 reader 가 절단된(부분쓰기) 파일을 절대 보지 않는다.
// 크래시가 "쓰기 도중"에 나도 원본은 손상되지 않는다 → .pact/ SOT·source .md 무결성 보장.

const fs = require('fs');
const path = require('path');

/**
 * 파일을 원자적으로 쓴다. temp suffix(pid+ts)로 동시 쓰기 충돌도 회피.
 * @param {string} file 최종 경로
 * @param {string|Buffer} content
 * @returns {string} file
 */
function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 이미 없음 */ }
    throw e;
  }
  // 부모 디렉터리 메타데이터 flush (best-effort — 일부 플랫폼은 EISDIR/EPERM)
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best-effort */ }
  return file;
}

/** 객체를 pretty JSON + 개행으로 원자적으로 쓴다. */
function writeJsonAtomic(file, obj) {
  return writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

module.exports = { writeFileAtomic, writeJsonAtomic };
