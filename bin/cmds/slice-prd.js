'use strict';

// pact slice-prd — PRD 마크다운에서 섹션 추출
//
// 사용:
//   pact slice-prd docs/PRD.md --section "12.1"
//   pact slice-prd docs/PRD.md --sections "3.2,4.1,12"
//   pact slice-prd docs/PRD.md --headers      → 모든 섹션 헤더 (TOC)
//   pact slice-prd docs/PRD.md --refs-from TASKS.md
//        → TASKS.md의 prd_reference 박힌 섹션만 union

const fs = require('fs');
const path = require('path');

function parseArgs(args) {
  const opts = { sections: null, headers: false, refsFrom: null, file: null };
  // M16: 옵션 값 누락 시 raw TypeError 방지 — actionable 에러(exit 2).
  const need = (i, flag) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`pact slice-prd: ${flag} 에 값이 필요합니다`);
      process.exit(2);
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--') && !opts.file) { opts.file = a; continue; }
    if (a === '--section') { opts.sections = [need(i, a)]; i++; }
    else if (a === '--sections') { opts.sections = need(i, a).split(',').map(s => s.trim()); i++; }
    else if (a === '--headers') opts.headers = true;
    else if (a === '--refs-from') { opts.refsFrom = need(i, a); i++; }
  }
  return opts;
}

/** 마크다운에서 섹션 추출. section은 "1.2"·"3"·"12.1" 같은 번호. */
function extractSection(md, sectionNum) {
  const lines = md.split('\n');
  // 섹션 헤더: "## <num>. <title>" 또는 "### <num>.<sub> <title>"
  // 번호 매칭 — "12.1"이면 "12.1"로 시작하는 헤더 찾기
  const startRe = new RegExp(`^#{1,6}\\s+${sectionNum.replace(/\./g, '\\.')}[\\s.]`);
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  // 다음 섹션 경계 찾기. M15: 과거엔 번호 있는 헤더(^#+\s+[\d.]+)만 경계로 봐서 'Appendix' 같은
  // 무번호 동급/상위 헤더를 못 끝내 무관한 내용이 누출됐다. 모든 헤더를 보고 레벨·번호로 판정한다.
  const startLevel = lines[start].match(/^(#+)/)[1].length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+(.*)/);
    if (!m) continue;
    const level = m[1].length;
    if (level > startLevel) continue;                 // 하위 섹션 → 이 섹션에 포함
    if (level < startLevel) { end = i; break; }        // 상위 레벨 → 확실히 끝
    // 같은 레벨: 이 섹션의 번호 하위(sectionNum.*)·같은 번호면 계속(sub), 그 외(다른 번호·무번호
    // Appendix 등)면 sibling 이라 끝.
    const numM = m[2].trim().match(/^([\d.]+)/);
    const num = numM ? numM[1].replace(/\.$/, '') : null;
    if (num && (num.startsWith(sectionNum + '.') || num === sectionNum)) continue;
    end = i;
    break;
  }

  return lines.slice(start, end).join('\n');
}

function extractRefsFromTasks(tasksFile) {
  if (!fs.existsSync(tasksFile)) return [];
  const { parseTasks } = require(path.join(__dirname, '..', '..', 'scripts', 'parse-tasks.js'));
  const md = fs.readFileSync(tasksFile, 'utf8');
  const parsed = parseTasks(md);
  const refs = new Set();
  for (const t of parsed.tasks) {
    if (t.prd_reference) {
      // "docs/PRD.md §3.2" 같은 형식에서 §<num> 부분 추출
      const m = String(t.prd_reference).match(/§\s*([\d.]+)/);
      if (m) refs.add(m[1]);
    }
  }
  return [...refs].sort();
}

module.exports = function slicePrd(args) {
  const opts = parseArgs(args);

  if (!opts.file) {
    console.error('Usage: pact slice-prd <prd.md> --section <num> | --sections <a,b> | --headers | --refs-from <tasks.md>');
    process.exit(1);
  }
  if (!fs.existsSync(opts.file)) {
    console.error(`${opts.file} not found`);
    process.exit(2);
  }

  const md = fs.readFileSync(opts.file, 'utf8');

  // headers 모드
  if (opts.headers) {
    const lines = md.split('\n');
    for (const l of lines) {
      if (/^#{1,3}\s/.test(l)) console.log(l);
    }
    return;
  }

  // refs-from 모드
  if (opts.refsFrom) {
    const refs = extractRefsFromTasks(opts.refsFrom);
    if (refs.length === 0) {
      console.error('TASKS.md의 task에 prd_reference §<num> 박힌 게 없음');
      process.exit(3);
    }
    opts.sections = refs;
    console.error(`✓ ${refs.length} sections from refs: ${refs.join(', ')}`);
  }

  if (!opts.sections || opts.sections.length === 0) {
    console.error('--section, --sections, --headers, --refs-from 중 하나 필요');
    process.exit(1);
  }

  // 각 섹션 추출
  const out = [];
  const missing = [];
  for (const s of opts.sections) {
    const slice = extractSection(md, s);
    if (slice) {
      out.push(`<!-- §${s} -->`);
      out.push(slice);
      out.push('');
    } else {
      missing.push(s);
    }
  }

  if (missing.length > 0) {
    console.error(`⚠ 못 찾은 섹션: ${missing.join(', ')}`);
  }
  console.log(out.join('\n'));
  console.error(`✓ ${opts.sections.length - missing.length}/${opts.sections.length} sections`);
};
