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
//   - 줄 끝 # 주석 (따옴표/flow 안 # 은 값의 일부로 보존)
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

/**
 * 한 줄에서 # 주석을 제거 — quote/flow 인지형 문자 스캔.
 * (pre-tool-guard.js extractWriteTargets 의 따옴표 추적 방식 재사용)
 *
 * 규칙:
 *   - # 은 "줄 시작이거나 바로 앞이 공백"일 때만 주석 시작 (YAML 선행공백 규칙).
 *     → "a: C#" 처럼 값에 붙은 # 은 주석이 아니라 값의 일부로 보존.
 *   - 홑/쌍따옴표 안, flow([...] {...}) 안의 # 은 언제나 값의 일부로 보존.
 *   - **절대 throw 하지 않는다.** unterminated quote 등 애매한 입력은 원문을 그대로
 *     돌려준다(관대). readOwnership 등이 파싱 예외를 catch → allow-all(fail-open)로
 *     삼키는 경로가 있어, 여기서 던지면 조용한 전체 허용이 되기 때문.
 */
function stripComment(line) {
  const n = line.length;
  let q = null;   // 현재 따옴표 문자 (" 또는 ') 또는 null
  let depth = 0;  // flow 깊이 — [ { 안이면 > 0
  for (let i = 0; i < n; i++) {
    const c = line[i];
    if (q) {                                // 따옴표 안: 닫는 따옴표만 감지, # 은 값
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '[' || c === '{') { depth++; continue; }
    if (c === ']' || c === '}') { if (depth > 0) depth--; continue; }
    if (c === '#' && depth === 0 && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;  // 주석 없음 (닫히지 않은 따옴표 포함 — 원문 유지, throw X)
}

/** 주석 제거 + 빈 줄 제거 + 끝 공백 trim */
function preprocess(text) {
  return text.split(/\r?\n/)
    .map(l => stripComment(l).trimEnd())
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
    // 중복 키는 조용히 마지막 값을 채택하지 않고 에러로 표면화 (버그 B).
    // parse-tasks.js 가 이 예외를 task-parse 에러로 잡아 prepare 를 멈춘다.
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`duplicate key: ${key}`);
    }
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
