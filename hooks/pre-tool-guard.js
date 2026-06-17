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

function readOwnership(cwd) {
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
  if (sources.length === 0) return null;

  const owners = [];
  for (const src of sources) {
    const content = fs.readFileSync(src, 'utf8');
    const blocks = [...content.matchAll(/```yaml\s*\n([\s\S]*?)\n```/g)];
    for (const m of blocks) {
      try {
        const parsed = yaml.load(m[1]);
        if (parsed && Array.isArray(parsed.owner_paths)) {
          owners.push(...parsed.owner_paths);
        }
      } catch { /* skip bad yaml */ }
    }
  }
  return owners;
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

// 쉘 명령에서 "파일을 새로 쓰는" 타겟 경로를 휴리스틱 추출.
// 첫 줄만 검사 → heredoc 본문(=>·> 多)·멀티라인 코드 오탐 방지. 따옴표 안 > 무시.
// 완벽 X (cp/mv·둘째 줄 redirection 누락) — 최종 백스톱은 merge 게이트 git-diff.
function extractWriteTargets(cmd) {
  const line = String(cmd || '').split('\n', 1)[0];
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
  return targets.filter((t) => t && !t.startsWith('/dev/'));
}

// Bash 명령이 allowed_paths 밖(워크트리 *안*) 파일을 쓰면 deny.
// 워크트리 밖(.pact/runs 보고영역·/dev/null)은 미검사 → status.json 쓰기 안 깨짐.
// drive(worker-guard)·parallel(hook) 단일 소스.
function checkBashWrite(command, opts = {}) {
  const { worktreeRoot, allowedPaths } = opts;
  if (!worktreeRoot || !Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return { allowed: true };
  }
  const root = path.resolve(worktreeRoot);
  const base = opts.resolveBase ? path.resolve(opts.resolveBase) : root;
  for (const tgt of extractWriteTargets(command)) {
    const abs = path.isAbsolute(tgt) ? tgt : path.resolve(base, tgt);
    if (!isInsideWorktree(abs, root)) continue; // 워크트리 밖 — 보고영역·임시파일, 미검사
    const rel = normalizeRel(path.relative(root, abs));
    if (!allowedPaths.some((g) => matchesGlob(rel, g))) {
      return {
        allowed: false,
        rel,
        reason: `pact: Bash가 allowed_paths 밖(워크트리 내) 쓰기 — ${rel} (허용: ${allowedPaths.join(', ')})`,
      };
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
  if (!owners) process.exit(0);  // ownership 미정의 → 통과

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
  matchesGlob, checkPath, readOwnership, globToRegex,
  detectWorktreeContext, isInsideWorktree,
  isBlockedLongSotRel, isAllowedReadRel, checkWorkerRead,
  extractWriteTargets, checkBashWrite,
};

if (require.main === module) main();
