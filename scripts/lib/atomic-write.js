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

/**
 * 파일을 "배타적으로 공개(publish)"한다 — 락 획득용 (STAB-2).
 *
 * 왜 이게 필요한가: 기존 락 획득부는 존재검사(existsSync) 후 write 하는
 * check-then-write TOCTOU 라, 동시 획득자 둘 다 존재검사를 통과해 둘 다
 * write 에 성공할 수 있었다(락이 락 역할 못 함).
 *
 * 어떻게 고치나: 완성된 내용을 유니크 tmp 에 먼저 다 쓴 뒤 fs.linkSync(tmp, file)
 * 로 "이미 있으면 실패(EEXIST)"인 원자 연산으로 공개한다. link 성공 = 획득,
 * EEXIST = 원자적 패배. 직접 'wx' open+write 와 달리 내용은 link 이전에
 * 이미 완성돼 있어 reader 가 절단된(부분쓰기) 락을 보는 torn-read 창이 없다.
 *
 * @param {string} file 최종 락 경로
 * @param {string|Buffer} content 완성된 락 내용
 * @returns {boolean} true=획득 성공 / false=이미 존재(EEXIST). 그 외 에러는 전파.
 */
function writeFileExclusive(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.xtmp`,
  );
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, file); // 원자적 공개 — file 이 이미 있으면 EEXIST
    } catch (e) {
      if (e.code === 'EEXIST') return false; // 원자적 패배
      throw e;
    }
    return true;
  } finally {
    // tmp 는 성공 시 두 번째 하드링크일 뿐 — 지워도 공개된 file 은 그대로 남는다.
    try { fs.unlinkSync(tmp); } catch { /* 이미 없음 */ }
  }
}

module.exports = { writeFileAtomic, writeJsonAtomic, writeFileExclusive };
