#!/usr/bin/env node
'use strict';

// pact pre-tool-guard hook
// 트리거: PreToolUse (Write/Edit/MultiEdit)
// 동작: MODULE_OWNERSHIP.md의 owner_paths 외 파일 수정 시 차단
// MODULE_OWNERSHIP.md 없으면 allow (architect 미실행 단계)

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

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
  const f = path.join(cwd, 'MODULE_OWNERSHIP.md');
  if (!fs.existsSync(f)) return null;

  const content = fs.readFileSync(f, 'utf8');
  const blocks = [...content.matchAll(/```yaml\s*\n([\s\S]*?)\n```/g)];

  const owners = [];
  for (const m of blocks) {
    try {
      const parsed = yaml.load(m[1]);
      if (parsed && Array.isArray(parsed.owner_paths)) {
        owners.push(...parsed.owner_paths);
      }
    } catch { /* skip bad yaml */ }
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

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);  // 페이로드 없음 → 통과
  }

  const tool = payload.tool_name;
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) {
    process.exit(0);
  }

  const filePath = payload.tool_input && payload.tool_input.file_path;
  if (!filePath) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const owners = readOwnership(cwd);
  if (!owners) process.exit(0);  // ownership 미정의 → 통과

  const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
  const r = checkPath(rel, owners);
  if (r.allowed) process.exit(0);

  // 차단
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

module.exports = { matchesGlob, checkPath, readOwnership, globToRegex };

if (require.main === module) main();
