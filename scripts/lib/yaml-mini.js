'use strict';

// Minimal YAML parser — js-yaml dep 제거용 (ADR-013).
// 우리 yaml 사용처(TASKS·MODULE_OWNERSHIP·API_CONTRACT 블록)에 한정된 subset.
//
// 지원:
//   - top-level mapping (key: value)
//   - scalars: string, number, bool, null
//   - block array of scalars: `\n  - item`
//   - block array of objects: `\n  - key: val\n    other: val`
//   - nested mapping
//   - inline array `[a, b]` / inline object `{k: v}`
//   - 줄 끝 # 주석
// 미지원: anchors, multi-doc, |·> 블록 스칼라, complex flow

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);

  // inline array
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`unclosed inline array: ${s}`);
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map(parseScalar);
  }
  // inline object
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new Error(`unclosed inline object: ${s}`);
    const obj = {};
    const inner = s.slice(1, -1).trim();
    if (!inner) return obj;
    for (const pair of splitFlow(inner)) {
      const idx = pair.indexOf(':');
      if (idx >= 0) {
        obj[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1));
      }
    }
    return obj;
  }
  return s;
}

/** flow comma split (depth 0 컴마만 분리) */
function splitFlow(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function indent(line) {
  return line.length - line.trimStart().length;
}

/** 주석 제거 + 빈 줄 제거 + 끝 공백 trim */
function preprocess(text) {
  return text.split(/\r?\n/)
    .map(l => l.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter(l => l.length > 0);
}

/** lines[start..]에서 baseIndent 이상인 연속 블록 끝 idx (exclusive) */
function blockEnd(lines, start, baseIndent) {
  let i = start;
  while (i < lines.length && indent(lines[i]) >= baseIndent) i++;
  return i;
}

function parseBlock(lines, baseIndent) {
  if (lines.length === 0) return null;
  const first = lines[0].trim();
  if (first.startsWith('- ') || first === '-') {
    return parseSequence(lines, baseIndent);
  }
  return parseMapping(lines, baseIndent);
}

function parseMapping(lines, baseIndent) {
  const obj = {};
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const ind = indent(ln);
    if (ind !== baseIndent) { i++; continue; }
    const trimmed = ln.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) { i++; continue; }
    const key = trimmed.slice(0, colon).trim();
    const valStr = trimmed.slice(colon + 1).trim();
    if (valStr) {
      obj[key] = parseScalar(valStr);
      i++;
    } else {
      const subStart = i + 1;
      const subEnd = blockEnd(lines, subStart, baseIndent + 1);
      const subLines = lines.slice(subStart, subEnd);
      if (subLines.length === 0) {
        obj[key] = null;
      } else {
        obj[key] = parseBlock(subLines, indent(subLines[0]));
      }
      i = subEnd;
    }
  }
  return obj;
}

function parseSequence(lines, baseIndent) {
  const arr = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const ind = indent(ln);
    if (ind !== baseIndent) { i++; continue; }
    const trimmed = ln.trim();
    if (!trimmed.startsWith('-')) { i++; continue; }
    const after = trimmed.length === 1 ? '' : trimmed.slice(1).trimStart();

    if (!after) {
      // nested block under "-"
      const subStart = i + 1;
      const subEnd = blockEnd(lines, subStart, baseIndent + 1);
      arr.push(parseBlock(lines.slice(subStart, subEnd),
        subStart < subEnd ? indent(lines[subStart]) : baseIndent + 1));
      i = subEnd;
    } else if (after.includes(':') && !after.startsWith('"') && !after.startsWith("'")
               && !after.startsWith('[') && !after.startsWith('{')) {
      const colon = after.indexOf(':');
      const valPart = after.slice(colon + 1).trim();
      // 객체 시작 — "- key: val" + 추가 키들
      const subStart = i + 1;
      const subEnd = blockEnd(lines, subStart, baseIndent + 2);
      // synthesize: indent baseIndent+2 + "key: val", + subLines (unchanged)
      const synth = [' '.repeat(baseIndent + 2) + after, ...lines.slice(subStart, subEnd)];
      // 재귀로 객체 만들기
      arr.push(parseMapping(synth, baseIndent + 2));
      // valPart 안 쓰는 이유: synth에 통째로 넣음
      i = subEnd;
    } else {
      arr.push(parseScalar(after));
      i++;
    }
  }
  return arr;
}

function load(text) {
  if (text === undefined || text === null) return null;
  const lines = preprocess(String(text));
  if (lines.length === 0) return null;
  const base = indent(lines[0]);
  return parseBlock(lines, base);
}

module.exports = { load, parseScalar };
