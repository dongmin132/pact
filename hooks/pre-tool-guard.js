#!/usr/bin/env node
'use strict';

// pact pre-tool-guard hook
// 트리거: PreToolUse (Read/Write/Edit/MultiEdit)
// 동작:
// - worker가 긴 legacy SOT 문서 원문을 Read하려 하면 차단
// - MODULE_OWNERSHIP.md의 owner_paths 외 파일 수정 시 차단
// MODULE_OWNERSHIP.md 없으면 allow (architect 미실행 단계)

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('../scripts/lib/yaml-mini.js');

function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesGlob(filePath, glob) {
  return globToRegex(glob).test(filePath);
}

// ownership 소스(legacy + shard)를 한 번 훑어 owner_paths 와 파싱 진단을 함께 수집.
// readOwnership(소비자 shape 유지)과 countOwnershipParseErrors(STAB-9 진단)의 공용.
function collectOwnership(cwd) {
  // ADR-018: legacy MODULE_OWNERSHIP.md + contracts/modules/*.md shard 합집합.
  const sources = [];
  const legacy = path.join(cwd, 'MODULE_OWNERSHIP.md');
  if (fs.existsSync(legacy)) sources.push(legacy);
  const shardDir = path.join(cwd, 'contracts', 'modules');
  if (fs.existsSync(shardDir) && fs.statSync(shardDir).isDirectory()) {
    for (const f of fs.readdirSync(shardDir)) {
      if (f.endsWith('.md')) sources.push(path.join(shardDir, f));
    }
  }

  const owners = [];
  let blocks = 0;
  let parseErrors = 0;
  for (const src of sources) {
    let content;
    try {
      content = fs.readFileSync(src, 'utf8');
    } catch {
      parseErrors++;  // 소스 읽기 실패도 "정의됐으나 못 읽음"으로 계상
      continue;
    }
    const matched = [...content.matchAll(/```yaml\s*\n([\s\S]*?)\n```/g)];
    for (const m of matched) {
      blocks++;
      try {
        const parsed = yaml.load(m[1]);
        if (parsed && Array.isArray(parsed.owner_paths)) {
          owners.push(...parsed.owner_paths);
        }
      } catch {
        parseErrors++;  // 손상 yaml — 조용히 삼키지 말고 카운트해 표면화
      }
    }
  }
  return { sources, owners, blocks, parseErrors };
}

function readOwnership(cwd) {
  const { sources, owners } = collectOwnership(cwd);
  if (sources.length === 0) return null;  // 소스 없음 → 강제 X (기존 shape 유지)
  return owners;
}

// STAB-9: "소스는 있는데 owner_paths 0건 + yaml 파싱 실패"를 구분하기 위한 진단.
// 손상 ownership 이 readOwnership 을 []로 만들어 조용한 fail-open(전체 허용)이 되는
// 경로를, 소비부(pre-tool-guard main)가 비차단 경고로 표면화할 수 있게 노출.
function countOwnershipParseErrors(cwd) {
  const { sources, owners, blocks, parseErrors } = collectOwnership(cwd);
  return {
    sources: sources.length,
    blocks,
    parseErrors,
    ownerCount: owners.length,
  };
}

// 손상 ownership 경고를 비차단으로 표면화 (stderr + systemMessage). 차단(deny) X.
function emitOwnershipParseWarning(diag) {
  const msg =
    `pact 경고: ownership 정의 소스 ${diag.sources}개를 읽었으나 owner_paths 0건 + ` +
    `yaml 파싱 실패 ${diag.parseErrors}건. 손상된 MODULE_OWNERSHIP 은 조용한 ` +
    `fail-open(전체 파일 허용)을 유발합니다 — 안전을 위해 차단하지 않고 통과시키되 경고합니다. ` +
    `MODULE_OWNERSHIP.md / contracts/modules/*.md 의 yaml 블록을 점검하세요.`;
  try { process.stderr.write(`${msg}\n`); } catch { /* ignore */ }
  // permissionDecision 없이 systemMessage 만 — 강제 allow/deny 아님(정상 권한 흐름 유지).
  process.stdout.write(JSON.stringify({ systemMessage: msg }));
}

function checkPath(filePath, ownerPaths) {
  if (!ownerPaths || ownerPaths.length === 0) return { allowed: true };
  for (const g of ownerPaths) {
    if (matchesGlob(filePath, g)) return { allowed: true };
  }
  return { allowed: false };
}

/** 현재 cwd가 워커 worktree인가 + worktree 루트 추출 */
function detectWorktreeContext(cwd) {
  const m = /\.pact\/worktrees\/([A-Z][A-Z0-9]*-\d+)(\/|$)/.exec(cwd);
  if (!m) return null;
  const idx = cwd.indexOf(`.pact/worktrees/${m[1]}`);
  const worktreeRoot = cwd.slice(0, idx + `.pact/worktrees/${m[1]}`.length);
  return { task_id: m[1], worktreeRoot };
}

/** file_path가 worktree 안인가 (worker는 자기 worktree 외부 못 만짐) */
function isInsideWorktree(absFilePath, worktreeRoot) {
  const rel = path.relative(worktreeRoot, absFilePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function normalizeRel(p) {
  return p.split(path.sep).join('/');
}

function readPathFromPayload(payload) {
  const input = payload.tool_input || {};
  return input.file_path || input.path || input.file || null;
}

function isAllowedReadRel(rel) {
  const p = normalizeRel(rel).replace(/^\.\//, '');
  return p === 'docs/context-map.md'
    || p.startsWith('.pact/runs/')
    || /^tasks\/[^/]+\.md$/.test(p)
    || /^contracts\/(api|db|modules)\/[^/]+\.md$/.test(p);
}

function isBlockedLongSotRel(rel) {
  const p = normalizeRel(rel).replace(/^\.\//, '');
  if (isAllowedReadRel(p)) return false;
  if ([
    'TASKS.md',
    'API_CONTRACT.md',
    'DB_CONTRACT.md',
    'MODULE_OWNERSHIP.md',
    'ARCHITECTURE.md',
    'DECISIONS.md',
  ].includes(p)) {
    return true;
  }
  return /^docs\/.*(prd|spec|requirements|product|dev).*\.md$/i.test(p);
}

function checkWorkerRead(filePath, cwd) {
  const wt = detectWorktreeContext(cwd);
  if (!wt) return { allowed: true };

  const absFile = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const idx = cwd.indexOf(`.pact/worktrees/${wt.task_id}`);
  const repoRoot = cwd.slice(0, idx);
  const relToWorktree = normalizeRel(path.relative(wt.worktreeRoot, absFile));
  const relToRepo = normalizeRel(path.relative(repoRoot, absFile));

  if (isBlockedLongSotRel(relToWorktree) || isBlockedLongSotRel(relToRepo)) {
    return {
      allowed: false,
      task_id: wt.task_id,
      file: normalizeRel(filePath),
      reason:
        `pact: 워커 ${wt.task_id}가 긴 SOT 원문 ${normalizeRel(filePath)} 전체 Read를 시도했습니다. ` +
        `대신 .pact/runs/${wt.task_id}/context.md, docs/context-map.md, tasks/*.md, ` +
        `contracts/api|db|modules/*.md 또는 pact slice / pact slice-prd로 필요한 섹션만 읽으세요. ` +
        `ARCHITECTURE.md / DECISIONS.md 처럼 슬라이서가 없는 SOT는 Bash로 rg/sed를 써서 섹션만 추출하세요. ` +
        `예: rg "^## §9" ARCHITECTURE.md 또는 sed -n '/^## ADR-005/,/^## ADR-006/p' DECISIONS.md`,
    };
  }

  return { allowed: true };
}

// 긴 SOT 를 통째로 읽는 Bash 뷰어(cat/less/more/bat) 차단(M21). rg/grep/sed/head/tail 은 섹션
// 추출 도구라 허용(deny 메시지가 권장하는 우회 경로) — 통독 뷰어만 막는다. worktree·repo 상대 둘 다 검사.
const WHOLE_FILE_VIEWERS = new Set(['cat', 'less', 'more', 'bat', 'batcat', 'view']);
function checkBashSotRead(command, cwd) {
  const wt = detectWorktreeContext(cwd);
  if (!wt) return { allowed: true };
  const idx = cwd.indexOf(`.pact/worktrees/${wt.task_id}`);
  const repoRoot = cwd.slice(0, idx);
  for (const line of String(command || '').split('\n')) {
    for (const seg of splitSegments(line)) {
      const { name, args } = commandOf(seg);
      if (!WHOLE_FILE_VIEWERS.has(name)) continue;
      for (const a of args) {
        if (a.startsWith('-')) continue;
        const abs = path.isAbsolute(a) ? a : path.resolve(cwd, a);
        const relToWt = normalizeRel(path.relative(wt.worktreeRoot, abs));
        const relToRepo = normalizeRel(path.relative(repoRoot, abs));
        if (isBlockedLongSotRel(relToWt) || isBlockedLongSotRel(relToRepo)) {
          return {
            allowed: false,
            reason: `pact: 워커 ${wt.task_id}가 Bash(${name})로 긴 SOT 원문 ${normalizeRel(a)} 통째 읽기 시도. ` +
              `rg/sed 로 섹션만 추출하세요 (예: rg "^## §9" ARCHITECTURE.md 또는 sed -n '/^## ADR-005/,/^## ADR-006/p' DECISIONS.md).`,
          };
        }
      }
    }
  }
  return { allowed: true };
}

// 한 줄에서 "파일을 새로 쓰는" 타겟(> >> tee touch)을 휴리스틱 추출. 따옴표 안 > 무시.
function scanLineWriteTargets(line) {
  const targets = [];
  const n = line.length;
  let i = 0;
  let q = null; // 현재 따옴표 상태
  while (i < n) {
    const c = line[i];
    if (q) { if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (c === '>') {
      i++;
      if (line[i] === '>') i++;                 // >> append
      while (i < n && /\s/.test(line[i])) i++;  // 공백 skip
      let t = '';
      let tq = null;
      while (i < n) {                            // 타겟 토큰 (따옴표 존중)
        const d = line[i];
        if (tq) { if (d === tq) { tq = null; i++; continue; } t += d; i++; continue; }
        if (d === '"' || d === "'") { tq = d; i++; continue; }
        if (/[\s|&;<>]/.test(d)) break;
        t += d; i++;
      }
      if (t) targets.push(t);
      continue;
    }
    i++;
  }
  let m;
  const teeTouch = /\b(?:tee(?:\s+-\S+)*|touch)\s+("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  while ((m = teeTouch.exec(line))) targets.push(m[1].replace(/^['"]|['"]$/g, ''));
  return targets;
}

// 한 세그먼트를 쉘 토큰으로 분해 (따옴표 존중, 리다이렉션 오퍼레이터/타겟은 제외).
// 리다이렉션 타겟은 scanLineWriteTargets 가 따로 잡으므로 여기선 명령 인자만 남긴다.
function tokenizeSegment(seg) {
  const toks = [];
  const n = seg.length;
  let i = 0;
  while (i < n) {
    const c = seg[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '>' || c === '<') {                 // 리다이렉션: 오퍼레이터 + 타겟 스킵
      i++;
      if (seg[i] === c) i++;                       // >> or <<
      while (i < n && /\s/.test(seg[i])) i++;
      let tq = null;
      while (i < n) {                              // 타겟 토큰 소비 (따옴표 존중)
        const d = seg[i];
        if (tq) { if (d === tq) tq = null; i++; continue; }
        if (d === '"' || d === "'") { tq = d; i++; continue; }
        if (/\s/.test(d)) break;
        i++;
      }
      continue;
    }
    let t = '';
    let tq = null;
    let sawRedir = false;
    while (i < n) {                                // 일반 토큰 (따옴표 존중)
      const d = seg[i];
      if (tq) { if (d === tq) { tq = null; i++; continue; } t += d; i++; continue; }
      if (d === '"' || d === "'") { tq = d; i++; continue; }
      if (/\s/.test(d)) break;
      if (d === '>' || d === '<') { sawRedir = true; break; }  // fd 접두(2>) 등 → 다음 반복서 처리
      t += d; i++;
    }
    if (t) toks.push(t);
    if (sawRedir) continue;
  }
  return toks;
}

// 한 줄을 쉘 명령 세그먼트(| & ; && ||)로 분해 (따옴표 존중). > 리다이렉션은 세그먼트 내부에 남긴다.
function splitSegments(line) {
  const segs = [];
  const n = line.length;
  let i = 0;
  let start = 0;
  let q = null;
  while (i < n) {
    const c = line[i];
    if (q) { if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (c === '|' || c === '&' || c === ';') {
      segs.push(line.slice(start, i));
      i++;
      while (i < n && line[i] === c) i++;          // || && ;; 축약
      start = i;
      continue;
    }
    i++;
  }
  segs.push(line.slice(start));
  return segs;
}

// cp/mv/install/ln 목적지 추출: -t DIR / --target-directory=DIR / 번들 -ft 우선, 없으면 마지막 non-flag 인자 = dest.
// 값을 취하는 플래그(-m/-o/-g/-S 등)의 인자만 dest 후보에서 제외.
// 주의: coreutils 의 --backup·-Z·--context 는 별도 인자를 받지 않는다(값은 =attached 형).
//       값-플래그로 취급하면 다음 소스 토큰을 삼켜 positionals<2 → dest 미검사 우회를 낳으므로 제외.
//       =attached 형(--backup=numbered 등)은 아래 flag-skip(continue)로 충분히 건너뛴다.
const CPMV_VALUE_FLAGS = new Set(['-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix', '-t', '--target-directory']);
function collectDestArg(args, targets) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '-t' || a === '--target-directory') { if (args[j + 1]) targets.push(args[j + 1]); return; }
    const mt = /^--target-directory=(.+)$/.exec(a);
    if (mt) { targets.push(mt[1]); return; }
    // 번들 short 플래그 끝이 t(예: -ft = -f -t)면 다음 토큰이 target-directory → dest 로 검사.
    if (!a.startsWith('--') && /^-[A-Za-z]*t$/.test(a)) { if (args[j + 1]) targets.push(args[j + 1]); return; }
    // 부착형 short target-dir(-t<DIR>, -ft<DIR>, -avt<DIR>): getopt 는 arg-요구 옵션 t 뒤
    // 클러스터 나머지를 값으로 붙여 취급 → target-directory. lazy 로 첫 t 뒤 전체를 dest 로 캡처.
    // 분리형(위 두 갈래)과 배타적: `-t`/`...t` 로 끝나면 여기 (.+) 매칭 실패해 아래로 안 샌다.
    if (!a.startsWith('--')) {
      const at = /^-[A-Za-z]*?t(.+)$/.exec(a);
      if (at) { targets.push(at[1]); return; }
    }
  }
  const positionals = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '--') { positionals.push(...args.slice(j + 1)); break; }
    if (a.startsWith('-') && a.length > 1) {
      if (CPMV_VALUE_FLAGS.has(a)) j++;            // 다음 토큰은 플래그 값 → 스킵
      continue;
    }
    positionals.push(a);
  }
  if (positionals.length >= 2) targets.push(positionals[positionals.length - 1]);  // 마지막 = dest
}

// sed -i / --in-place 편집 대상 파일들 추출. -i 없으면 stdout 출력이라 파일 쓰기 아님.
function collectSedInPlace(args, targets) {
  let inPlace = false;
  let haveScript = false;                          // -e/-f 로 스크립트가 이미 주어졌나
  const positionals = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '--') { positionals.push(...args.slice(j + 1)); break; }
    if (a.startsWith('--')) {
      if (a === '--in-place' || a.startsWith('--in-place=')) inPlace = true;
      else if (a === '--expression' || a === '--file') { haveScript = true; j++; }
      else if (a.startsWith('--expression=') || a.startsWith('--file=')) haveScript = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {        // short 클러스터 (-i, -i.bak, -ni, -e ...)
      if (/i/.test(a)) inPlace = true;
      // BSD/macOS sed: 클러스터가 i 로 끝나(attached suffix 없음) 다음 토큰이 분리형 백업 suffix면 소비.
      // 확실한 suffix 신호(.으로 시작·/ 없음, 예 .bak/.orig)만 삼켜 sed script(s///·주소)로는 오소비 X.
      // 미봉 시 GNU 가정으로 script 토큰까지 파일 오인 → darwin 정상 in-scope 편집 과차단.
      if (/i$/.test(a) && args[j + 1] && args[j + 1].startsWith('.') && !args[j + 1].includes('/')) j++;
      if (/[ef]/.test(a)) { haveScript = true; if (/[ef]$/.test(a)) j++; }  // -e/-f 값 소비
      continue;
    }
    positionals.push(a);
  }
  if (!inPlace) return;
  const files = haveScript ? positionals : positionals.slice(1);  // -e/-f 없으면 첫 위치인자=스크립트
  for (const f of files) targets.push(f);
}

// dd of=PATH 출력 대상 추출.
function collectDd(args, targets) {
  for (const a of args) {
    const m = /^of=(.+)$/.exec(a);
    if (m) targets.push(m[1]);
  }
}

// 명령 이름 앞에 올 수 있는 래퍼/환경 접두 — 실제 명령 이름을 찾을 때 건너뛴다.
const PREFIX_CMDS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec']);

// 명령 토큰을 basename 정규화(H5-2): '/bin/rm'→'rm', '\rm'(alias 우회)→'rm', './rm'→'rm'.
// 정확일치(cmd==='rm')만 보던 정적차단·삭제경계 추출이 경로/백슬래시 접두 rm 을 통째로
// 우회하던 구멍을 닫는다. find 의 -exec 판정과 동일한 basename 정규화 원칙.
function normalizeCmdName(tok) {
  if (!tok) return tok;
  const stripped = String(tok).replace(/^\\+/, '');   // alias 우회 백슬래시 제거
  const base = stripped.split('/').pop();
  return base || stripped;
}

// $(...) 및 백틱 명령치환 본문을 재귀 수집 — 서브셸 안의 rm 도 스캔 대상에 넣는다(H5-2).
// 깊이 상한(R3): 병적으로 깊은 중첩에서 스택오버플로→가드 fail-open 을 막는다.
const SUBSHELL_MAX_DEPTH = 40;
function collectSubshellBodies(str, depth = 0) {
  if (depth >= SUBSHELL_MAX_DEPTH) return [];
  const bodies = [];
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '(') {
      let d = 1; let j = i + 2; const start = j;
      for (; j < s.length && d > 0; j++) {
        if (s[j] === '(') d++;
        else if (s[j] === ')') { d--; if (d === 0) break; }
      }
      const body = s.slice(start, j);
      bodies.push(body, ...collectSubshellBodies(body, depth + 1));
      i = j;
    }
  }
  const bt = s.split('`');
  for (let k = 1; k < bt.length; k += 2) bodies.push(bt[k], ...collectSubshellBodies(bt[k], depth + 1));
  return bodies;
}

// 라인을 statement(;/&&/||/&)로 분리 — 파이프(|)는 statement 내부에 유지(따옴표 존중). R3:
// xargs rm 파이프 연결을 statement 범위로 국한해, 별개 명령(;)의 무관한 find 경로를 삭제 타겟으로
// 오승격하던 거짓 deny 회귀를 막는다.
function splitStatements(line) {
  const stmts = [];
  const n = line.length; let i = 0, start = 0, q = null;
  while (i < n) {
    const c = line[i];
    if (q) { if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (c === ';') { stmts.push(line.slice(start, i)); i++; while (i < n && line[i] === ';') i++; start = i; continue; }
    if (c === '&') { stmts.push(line.slice(start, i)); i++; while (i < n && line[i] === '&') i++; start = i; continue; }
    if (c === '|' && line[i + 1] === '|') { stmts.push(line.slice(start, i)); i += 2; start = i; continue; }
    i++;
  }
  stmts.push(line.slice(start));
  return stmts;
}

// 세그먼트에서 (env 대입/래퍼 접두 제거 후) 실제 명령 이름과 인자를 분리. name = basename 정규화.
function commandOf(seg) {
  const toks = tokenizeSegment(seg);
  if (!toks.length) return { cmd: null, name: null, args: [] };
  let k = 0;
  while (k < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[k]) || PREFIX_CMDS.has(normalizeCmdName(toks[k])))) k++;
  const cmd = toks[k];
  return { cmd, name: normalizeCmdName(cmd), args: toks.slice(k + 1) };
}

// xargs 인자에서 실제 실행 명령(name, args)을 추출 — `find | xargs rm` 우회 차단용.
function xargsInner(args) {
  const valFlags = new Set(['-n', '-P', '-I', '-L', '-s', '-d', '-a', '-E',
    '--max-args', '--max-procs', '--replace', '--max-lines', '--delimiter', '--arg-file', '--eof']);
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    // 부착형 값 플래그(-I{}, -n1)는 다음 토큰 안 먹음; 분리형(-I {}, -n 1)만 스킵.
    k += (valFlags.has(args[k]) ? 2 : 1);
  }
  if (k >= args.length) return null;
  return { name: normalizeCmdName(args[k]), args: args.slice(k + 1) };
}

// find 가 파일을 삭제하는가: -delete 또는 -exec/-execdir rm.
function findDeletes(args) {
  if (args.includes('-delete')) return true;
  return args.some((a, i) => (a === '-exec' || a === '-execdir')
    && /(^|\/)rm$/.test(String(args[i + 1] || '').replace(/^\\+/, '')));
}

// 리다이렉션이 아닌 "인자로 파일을 쓰는" 명령(cp/mv/install/sed -i/dd/ln)의 목적지를 추출.
// 세그먼트 단위로 나눠 각 명령의 실제 이름을 보고 분기 → `npm install`·`git mv` 같은 서브커맨드 오탐 회피.
function scanLineCommandWriteTargets(line) {
  const targets = [];
  for (const seg of splitSegments(line)) {
    const { name, args } = commandOf(seg);
    if (!name) continue;
    if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') collectDestArg(args, targets);
    else if (name === 'sed') collectSedInPlace(args, targets);
    else if (name === 'dd') collectDd(args, targets);
  }
  return targets;
}

// rm/find/xargs 의 삭제 대상 경로를 추출(H5). 경계 분류(자기 worktree 밖 삭제 차단)용.
// name 은 basename 정규화라 /bin/rm·\rm 도 잡힌다. `find … | xargs rm` 파이프는 find 의 경로
// 피연산자를 삭제 타겟으로 본다. 서브셸($()/백틱) 본문도 재귀 스캔.
function scanLineDeleteTargets(line) {
  const targets = [];
  const chunks = [String(line || ''), ...collectSubshellBodies(line)];
  for (const chunk of chunks) {
    for (const stmt of splitStatements(chunk)) {   // statement 범위(파이프만 내부) — 무관한 ; 명령 격리
      const segs = splitSegments(stmt).map((s) => commandOf(s));
      // xargs rm 파이프는 같은 statement 안에서만 find 경로를 삭제타겟으로 승격(R3 거짓 deny 방지).
      const xargsRmInPipe = segs.some((s) => s.name === 'xargs' && (xargsInner(s.args) || {}).name === 'rm');
      for (const { name, args } of segs) {
        if (name === 'rm') {
          let afterDD = false;
          for (const a of args) {
            if (a === '--') { afterDD = true; continue; }
            if (!afterDD && a.startsWith('-')) continue;
            targets.push(a);
          }
        } else if (name === 'xargs') {
          const inner = xargsInner(args);
          if (inner && inner.name === 'rm') for (const a of inner.args) if (!a.startsWith('-')) targets.push(a);
        } else if (name === 'find') {
          if (findDeletes(args) || xargsRmInPipe) {
            for (const a of args) {
              if (a.startsWith('-') || a === '(' || a === '!') break;  // predicate 시작 = 경로 끝
              targets.push(a);
            }
          }
        }
      }
    }
  }
  return targets;
}

// rm 인자가 재귀(-r/-R/--recursive)+강제(-f/--force) 조합인지 — 플래그 순서·철자·클러스터 무관.
function isRecursiveForceRm(args) {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (a === '--') break;
    if (a === '--recursive') recursive = true;
    else if (a === '--force') force = true;
    else if (/^-[A-Za-z]+$/.test(a)) {   // short 클러스터 (-rf, -fr, -Rf, -r ...)
      if (/[rR]/.test(a)) recursive = true;
      if (/f/.test(a)) force = true;
    }
  }
  return recursive && force;
}

// 워크트리 cwd 격리로도 못 막는 파괴적 삭제(재귀-강제 rm · find -delete/-exec[dir] rm · xargs rm)를
// 정적 감지. basename 정규화(/bin/rm·\rm)·서브셸($()/백틱)·파이프까지 커버(H5-2). 헤드리스
// worker-guard·인터랙티브 hook 공용 단일 소스.
function hasDestructiveDelete(command) {
  const chunks = [String(command || ''), ...collectSubshellBodies(command)];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {   // R3: splitSegments 는 개행을 안 뜯음 — 줄 단위로 먼저 분리
      for (const seg of splitSegments(line)) {
        const { name, args } = commandOf(seg);
        if (name === 'rm' && isRecursiveForceRm(args)) return true;
        if (name === 'find' && findDeletes(args)) return true;
        if (name === 'xargs') {
          const inner = xargsInner(args);
          if (inner && inner.name === 'rm' && isRecursiveForceRm(inner.args)) return true;
        }
      }
    }
  }
  return false;
}

// heredoc 오프너( <<EOF, <<-EOF, << EOF, <<'EOF', <<"END" )를 인식해 델리미터명 캡처.
// (?<!<)…(?!<): here-string(<<<)의 일부인 `<<` 를 heredoc 오프너로 오탐하지 않는다(LG-2).
//   `grep x <<< "EOF"` 의 `<<` 를 오프너로 잡으면 다음 줄이 본문으로 스킵돼 경계 밖 쓰기가
//   fail-open 된다. here-string 은 본문이 없으므로 오프너에서 배제해야 한다.
const HEREDOC_OPENER = /(?<!<)<<(?!<)-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|\\?([A-Za-z_][A-Za-z0-9_]*))/g;

// 쉘 명령에서 쓰기 타겟 경로를 heredoc-aware 로 추출.
// 명령줄은 스캔하고 heredoc 본문(델리미터 사이)은 스킵 → 본문 안 > 오탐 금지.
// 커버: 리다이렉션(> >> tee touch) + 인자로 파일을 쓰는 명령(cp/mv/install/sed -i/dd of=/ln).
// 한계(best-effort, 정적 파서 밖): 변수 전개($VAR)·eval·산술 <<·process substitution·미지 도구
// 는 못 잡는다. 최종 백스톱은 merge 게이트 git-diff.
function extractWriteTargets(cmd) {
  const lines = String(cmd || '').split('\n');
  const targets = [];
  const pending = []; // 대기 중 heredoc 델리미터 큐 (본문 스킵용)
  for (const raw of lines) {
    if (pending.length) {
      const cur = pending[0];
      const probe = cur.stripTabs ? raw.replace(/^\t+/, '') : raw;
      if (probe === cur.delim) pending.shift();
      continue; // heredoc 본문/종료줄 — 쓰기 타겟 아님 (본문 안 > 무시)
    }
    for (const t of scanLineWriteTargets(raw)) targets.push(t);
    for (const t of scanLineCommandWriteTargets(raw)) targets.push(t);
    let m;
    HEREDOC_OPENER.lastIndex = 0;
    while ((m = HEREDOC_OPENER.exec(raw))) {
      pending.push({ delim: m[2] || m[3], stripTabs: raw[m.index + 2] === '-' });
    }
  }
  return targets.filter((t) => t && !t.startsWith('/dev/'));
}

// 삭제 타겟을 heredoc-aware 로 추출(H5). extractWriteTargets 와 같은 본문 스킵 규율.
function extractDeleteTargets(cmd) {
  const lines = String(cmd || '').split('\n');
  const targets = [];
  const pending = [];
  for (const raw of lines) {
    if (pending.length) {
      const cur = pending[0];
      const probe = cur.stripTabs ? raw.replace(/^\t+/, '') : raw;
      if (probe === cur.delim) pending.shift();
      continue;
    }
    for (const t of scanLineDeleteTargets(raw)) targets.push(t);
    let m;
    HEREDOC_OPENER.lastIndex = 0;
    while ((m = HEREDOC_OPENER.exec(raw))) {
      pending.push({ delim: m[2] || m[3], stripTabs: raw[m.index + 2] === '-' });
    }
  }
  return targets.filter((t) => t && !t.startsWith('/dev/'));
}

// 타겟 토큰을 절대경로로. ~ 는 홈으로 전개(레포 밖 판정용). $VAR 전개는 미지원(best-effort).
function resolveWriteTarget(tgt, base) {
  if (tgt === '~' || tgt.startsWith('~/')) return path.join(os.homedir(), tgt.slice(1));
  return path.isAbsolute(tgt) ? tgt : path.resolve(base, tgt);
}

// worktreeRoot(.pact/worktrees/<id>) 에서 repoRoot·taskId 도출. 비표준이면 null.
function worktreeBoundary(worktreeRoot) {
  const s = String(worktreeRoot);
  const wt = detectWorktreeContext(s);
  if (!wt) return { repoRoot: null, taskId: null };
  const idx = s.indexOf(`.pact/worktrees/${wt.task_id}`);
  const repoRoot = idx >= 0 ? path.resolve(s.slice(0, idx)) : null;
  return { repoRoot, taskId: wt.task_id };
}

// /tmp·os.tmpdir() 하위인가 (워커 임시파일 — 명시 allow).
function isTempPath(abs) {
  if (isInsideWorktree(abs, path.resolve(os.tmpdir()))) return true;
  return /^\/(private\/)?(tmp|var\/tmp)(\/|$)/.test(abs);
}

// 워크트리 밖 타겟의 경계 분류:
//  (a) repoRoot/.pact/worktrees/<다른-id>/ → deny(형제 WT 오염)
//  (b) repoRoot 아래, 자기 worktree·자기 runs 밖 → deny(본체 트리 오염)
//  (c) 자기 .pact/runs/<id>/**, /dev/**, os.tmpdir()/tmp → allow(보고·임시파일 회귀 방지)
//  (d) 레포 밖(홈 등) → deny
function classifyOutsideTarget(abs, bnd) {
  const { repoRoot, taskId } = bnd;
  if (abs.startsWith('/dev/')) return { deny: false };
  if (repoRoot && taskId
      && isInsideWorktree(abs, path.join(repoRoot, '.pact', 'runs', taskId))) {
    return { deny: false }; // 자기 보고 디렉터리
  }
  if (!repoRoot) return { deny: false }; // 비표준 worktreeRoot — 경계 판정 불가, 기존 동작 유지
  if (isInsideWorktree(abs, repoRoot)) {
    if (isInsideWorktree(abs, path.join(repoRoot, '.pact', 'worktrees'))) {
      return { deny: true, reason: `pact: Bash가 형제 worktree(다른 태스크) 오염 시도 — ${abs}` };
    }
    return { deny: true, reason: `pact: Bash가 본체 트리(자기 worktree 밖) 쓰기 — ${abs}` };
  }
  if (isTempPath(abs)) return { deny: false };
  return { deny: true, reason: `pact: Bash가 레포 밖(홈 등) 쓰기 — ${abs}` };
}

// Bash 명령의 쓰기 타겟을 경계별로 판정:
//  - 워크트리 안: allowed_paths(glob) 강제
//  - 워크트리 밖: classifyOutsideTarget 로 형제 WT·본체 트리·레포 밖 오염 deny,
//    자기 runs·/dev·임시파일은 명시 allow.
// drive(worker-guard)·parallel(hook) 단일 소스.
function checkBashWrite(command, opts = {}) {
  const { worktreeRoot, allowedPaths } = opts;
  if (!worktreeRoot || !Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return { allowed: true };
  }
  const root = path.resolve(worktreeRoot);
  const base = opts.resolveBase ? path.resolve(opts.resolveBase) : root;
  const bnd = worktreeBoundary(worktreeRoot);
  for (const tgt of extractWriteTargets(command)) {
    const abs = resolveWriteTarget(tgt, base);
    if (isInsideWorktree(abs, root)) {
      const rel = normalizeRel(path.relative(root, abs));
      if (!allowedPaths.some((g) => matchesGlob(rel, g))) {
        return {
          allowed: false,
          rel,
          reason: `pact: Bash가 allowed_paths 밖(워크트리 내) 쓰기 — ${rel} (허용: ${allowedPaths.join(', ')})`,
        };
      }
      continue;
    }
    const cls = classifyOutsideTarget(abs, bnd);
    if (cls.deny) {
      return { allowed: false, rel: normalizeRel(abs), reason: cls.reason };
    }
  }
  // 삭제 타겟(H5): 워크트리 내 삭제는 격리돼 diff 로 드러나므로 allowed_paths 강제 없이 허용하되,
  // 워크트리 밖(형제 WT·본체 트리·홈) 삭제는 경계 분류로 차단 — rm 이 checkBashWrite 밖이던 구멍.
  for (const tgt of extractDeleteTargets(command)) {
    const abs = resolveWriteTarget(tgt, base);
    if (isInsideWorktree(abs, root)) continue;
    const cls = classifyOutsideTarget(abs, bnd);
    if (cls.deny) {
      return { allowed: false, rel: normalizeRel(abs), reason: cls.reason.replace('쓰기', '삭제') };
    }
  }
  return { allowed: true };
}

// PreToolUse 페이로드의 permission_mode 를 .pact/state.json 에 스탬프(H1). SessionStart 페이로드엔
// 이 필드가 없어 런타임 yolo 가 감지 안 됐다 — PreToolUse 는 도구 컨텍스트라 실제로 값이 온다.
// 메인 세션(cwd=repo 루트)에서만 갱신하고, 워커 worktree cwd 나 비-pact 리포는 skip.
// H1-2: (a) 워커 worktree cwd 명시 skip(메인 state 오염 방지), (b) 손상/torn state 를 만나면
// 덮어쓰지 않고 skip(다른 필드 wipe 방지), (c) 원자적 쓰기(writeJsonAtomic — torn read 창 제거).
// 값이 바뀔 때만 write(무의미 churn 방지). 실패해도 fail-open(가드 흐름 방해 금지).
function stampPermissionMode(payload) {
  const mode = payload.permission_mode
    || payload.permissionMode
    || (payload.metadata && payload.metadata.permission_mode);
  if (!mode) return;
  const cwd = payload.cwd || process.cwd();
  if (detectWorktreeContext(cwd)) return;   // 워커 worktree → 메인 state 오염 금지
  const stateDir = path.join(cwd, '.pact');
  if (!fs.existsSync(stateDir)) return;      // 비-pact 리포 → 무해 skip
  const statePath = path.join(stateDir, 'state.json');
  let state;
  if (fs.existsSync(statePath)) {
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { return; }   // 손상/torn read — 덮어써서 다른 필드 wipe 하지 말고 skip
  }
  if (state == null) state = {};
  if (typeof state !== 'object' || Array.isArray(state)) return;
  const isYolo = mode === 'bypassPermissions';
  if (state.permission_mode === mode && state.is_yolo === isYolo) return;  // 변화 없음
  state.permission_mode = mode;
  state.is_yolo = isYolo;
  try {
    const { writeJsonAtomic } = require('../scripts/lib/atomic-write.js');
    writeJsonAtomic(statePath, state);
  } catch { /* fail-open */ }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);  // 페이로드 없음 → 통과
  }

  try { stampPermissionMode(payload); } catch { /* fail-open */ }

  const tool = payload.tool_name;

  // Bash: allowed_paths 밖(워크트리 내) 쓰기 리다이렉션 차단 — 워커 worktree 컨텍스트에서만.
  // Write/Edit 는 막지만 `cat > docs/x.md` 같은 Bash 우회가 게이트를 통째 reject 시키던 구멍(CLEANUP-029).
  if (tool === 'Bash') {
    const cwdB = payload.cwd || process.cwd();
    const command = (payload.tool_input || {}).command || '';
    const wt = detectWorktreeContext(cwdB);
    if (wt) {
      // M21: cat/less 등으로 긴 SOT 통째 읽기 우회 차단(Read 가드와 대칭). rg/sed 섹션추출은 허용.
      const sot = checkBashSotRead(command, cwdB);
      if (!sot.allowed) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: sot.reason },
        }));
        process.exit(0);
      }
      const idx = cwdB.indexOf(`.pact/worktrees/${wt.task_id}`);
      const repoRoot = cwdB.slice(0, idx);
      const payloadPath = path.join(repoRoot, '.pact', 'runs', wt.task_id, 'payload.json');
      if (fs.existsSync(payloadPath)) {
        try {
          const wp = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
          const allowed = Array.isArray(wp.allowed_paths) ? wp.allowed_paths : null;
          if (allowed && allowed.length > 0) {
            const chk = checkBashWrite(command, { worktreeRoot: wt.worktreeRoot, allowedPaths: allowed, resolveBase: cwdB });
            if (!chk.allowed) {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: `pact: 워커 ${wt.task_id} — ${chk.reason}`,
                },
              }));
              process.exit(0);
            }
          }
        } catch { /* payload 깨짐 — skip */ }
      }
    }
    process.exit(0);
  }

  if (!['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool)) {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();
  const filePath = readPathFromPayload(payload);
  if (!filePath) process.exit(0);

  if (tool === 'Read') {
    const r = checkWorkerRead(filePath, cwd);
    if (!r.allowed) {
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: r.reason,
        },
      };
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }
    process.exit(0);
  }

  const absFile = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  // 0) edit-lock 검사 (v0.7.0) — 다른 세션이 이 파일을 잡고 있나
  // 자기 session_label = 세션 UUID(payload.session_id, CLI 의 CLAUDE_CODE_SESSION_ID 와 동일 값).
  // H3-2: 과거 ppid-${process.ppid} 로만 추정해 CLI 가 건 자기 락(session UUID)과 불일치 → 소유
  // 세션 자신의 Edit 를 deny 하던 자기 락아웃 회귀를 봉쇄. UUID 부재 시에만 ppid 폴백.
  try {
    const { findLockForFile } = require(path.join(__dirname, '..', 'scripts', 'edit-lock.js'));
    const hit = findLockForFile(absFile, { cwd });
    if (hit) {
      const mySession = process.env.PACT_SESSION
        || payload.session_id
        || process.env.CLAUDE_CODE_SESSION_ID
        || `ppid-${process.ppid}`;
      if (hit.session_label !== mySession) {
        const out = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `pact edit-lock: ${path.relative(cwd, absFile)}은(는) 다른 세션이 점유 중 ` +
              `(target=${hit.target}, kind=${hit.kind}, session=${hit.session_label || 'unknown'}, pid=${hit.pid}). ` +
              `해당 세션의 pact edit-release 대기 또는 --session 라벨 일치 확인.`,
          },
        };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      }
    }
  } catch { /* edit-lock.js 없거나 .pact 미초기화 — skip */ }

  const wt = detectWorktreeContext(cwd);

  // 1) 워커 worktree 경계 검사 (spec §3.4 post-hoc → pre-block 강화)
  if (wt && !isInsideWorktree(absFile, wt.worktreeRoot)) {
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `pact: 워커 ${wt.task_id}가 자기 worktree(${wt.worktreeRoot}) 외부 파일 ${absFile} 수정 시도. ` +
          `worktree 안에서만 작업해야 함.`,
      },
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  // 2) [ADR-012] 워커 컨텍스트 — payload.allowed_paths 강제 (per-task)
  if (wt) {
    const idx = cwd.indexOf(`.pact/worktrees/${wt.task_id}`);
    const repoRoot = cwd.slice(0, idx);
    const payloadPath = path.join(repoRoot, '.pact', 'runs', wt.task_id, 'payload.json');
    if (fs.existsSync(payloadPath)) {
      try {
        const wp = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
        const allowed = Array.isArray(wp.allowed_paths) ? wp.allowed_paths : null;
        if (allowed && allowed.length > 0) {
          const relInWt = path.relative(wt.worktreeRoot, absFile);
          const matched = allowed.some(g => matchesGlob(relInWt, g));
          if (!matched) {
            const out = {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  `pact: 워커 ${wt.task_id}의 allowed_paths에 ${relInWt} 미포함. ` +
                  `허용: ${allowed.join(', ')}`,
              },
            };
            process.stdout.write(JSON.stringify(out));
            process.exit(0);
          }
          // allowed_paths가 더 정확하니 ownership 검사 스킵하고 통과
          process.exit(0);
        }
      } catch { /* payload 깨짐 — fallback to ownership */ }
    }
  }

  // 3) MODULE_OWNERSHIP 검사 (메인 또는 payload 미존재 시 fallback)
  const rel = path.relative(cwd, absFile);
  // 프로젝트 루트 밖이면 ownership 검사 대상 X (메인이 /tmp, ~/.claude/plugins 등 만질 때)
  if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);
  const owners = readOwnership(cwd);
  if (!owners) process.exit(0);  // ownership 미정의(소스 없음) → 통과

  // STAB-9: 소스는 있는데 owner_paths 0건이고 yaml 파싱 실패가 있으면,
  // checkPath 가 빈 목록을 전체 허용으로 처리해 조용한 fail-open 이 된다.
  // fail-closed 는 데드락·회귀 위험이라 채택 X — 대신 비차단 경고만 표면화하고 allow 유지.
  if (owners.length === 0) {
    const diag = countOwnershipParseErrors(cwd);
    if (diag.parseErrors > 0) emitOwnershipParseWarning(diag);
    process.exit(0);  // allow 유지
  }

  // M11: pact 관리 문서(루트 *.md·tasks/·contracts/·docs/·.pact/)는 모듈 '코드'가 아니라 ownership
  // 검사 대상이 아니다 — ownership 이 정의되면 메인 세션의 PROGRESS.md·DECISIONS.md 편집이 일괄
  // deny 돼 /pact:wrap 단계 1(PROGRESS.md 갱신)과 정면 충돌하던 문제 해소.
  const relN = normalizeRel(rel).replace(/^\.\//, '');
  const isPactDoc = /^[^/]+\.md$/.test(relN)
    || relN.startsWith('.pact/') || relN.startsWith('tasks/')
    || relN.startsWith('contracts/') || relN.startsWith('docs/');
  if (isPactDoc) process.exit(0);

  const r = checkPath(rel, owners);
  if (r.allowed) process.exit(0);

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `pact: 파일 ${rel}이 MODULE_OWNERSHIP.md 어느 모듈에도 속하지 않습니다. ` +
        `architect가 ownership을 갱신하거나 task의 allowed_paths 확인 필요.`,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

module.exports = {
  matchesGlob, checkPath, readOwnership, countOwnershipParseErrors, globToRegex,
  detectWorktreeContext, isInsideWorktree,
  isBlockedLongSotRel, isAllowedReadRel, checkWorkerRead,
  extractWriteTargets, extractDeleteTargets, checkBashWrite,
  hasDestructiveDelete, isRecursiveForceRm, checkBashSotRead,
};

if (require.main === module) main();
