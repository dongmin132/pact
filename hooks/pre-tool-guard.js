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

// heredoc 오프너( <<EOF, <<-EOF, << EOF, <<'EOF', <<"END" )를 인식해 델리미터명 캡처.
const HEREDOC_OPENER = /<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|\\?([A-Za-z_][A-Za-z0-9_]*))/g;

// 쉘 명령에서 쓰기 타겟 경로를 heredoc-aware 로 추출.
// 명령줄은 스캔하고 heredoc 본문(델리미터 사이)은 스킵 → 본문 안 > 오탐 금지.
// 한계(best-effort, 정적 파서 밖): cp/mv·sed -i·변수 전개($VAR)·산술 <<·process substitution
// 은 못 잡는다. 최종 백스톱은 merge 게이트 git-diff.
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
  return { allowed: true };
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);  // 페이로드 없음 → 통과
  }

  const tool = payload.tool_name;

  // Bash: allowed_paths 밖(워크트리 내) 쓰기 리다이렉션 차단 — 워커 worktree 컨텍스트에서만.
  // Write/Edit 는 막지만 `cat > docs/x.md` 같은 Bash 우회가 게이트를 통째 reject 시키던 구멍(CLEANUP-029).
  if (tool === 'Bash') {
    const cwdB = payload.cwd || process.cwd();
    const command = (payload.tool_input || {}).command || '';
    const wt = detectWorktreeContext(cwdB);
    if (wt) {
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
  // 환경변수 또는 ppid로 자기 session_label 추정. 정확히 일치 안 하면 차단.
  try {
    const { findLockForFile } = require(path.join(__dirname, '..', 'scripts', 'edit-lock.js'));
    const hit = findLockForFile(absFile, { cwd });
    if (hit) {
      const mySession = process.env.PACT_SESSION || `ppid-${process.ppid}`;
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
  extractWriteTargets, checkBashWrite,
};

if (require.main === module) main();
