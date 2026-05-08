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

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);  // 페이로드 없음 → 통과
  }

  const tool = payload.tool_name;
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
};

if (require.main === module) main();
