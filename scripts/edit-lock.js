'use strict';

// pact edit-lock — 멀티세션 자유 수정 안전망 (v0.7.0)
//
// 사이클 끝난 후 사용자가 직접 수정할 때, 두 세션이 같은 영역 만져
// race가 나는 걸 방지. target은 두 종류:
//   1. 모듈 이름 (예: "auth") → contracts/modules/auth.md의 owner_paths +
//      contracts/api|db/auth.md + tasks/auth.md 일괄 lock
//   2. 파일 경로 (예: "PROGRESS.md") → 단일 파일 lock
//
// pre-tool-guard hook이 Write/Edit/MultiEdit 시 lock 검사 후 다른 세션 차단.
// 자기 session_label 잡은 lock이면 통과.

const fs = require('fs');
const path = require('path');
const { isAlive } = require('./lock.js');
const yaml = require('./lib/yaml-mini.js');

function editLocksDir(cwd) {
  return path.join(cwd, '.pact', 'edit-locks');
}

function lockFile(cwd, target) {
  // 슬래시·경로 구분자를 안전한 이름으로 변환
  const safe = target.replace(/[/\\]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(editLocksDir(cwd), `${safe}.lock`);
}

function readLockFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const p = JSON.parse(raw);
    if (!p || typeof p.pid !== 'number') return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * 모듈 이름에서 그 도메인의 모든 파일 glob을 추출.
 * contracts/modules/<module>.md의 owner_paths + 자동 매핑 shard들.
 */
function expandModuleFiles(moduleName, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const paths = [];

  // contracts/modules/<module>.md의 yaml에서 owner_paths
  const modShard = path.join(cwd, 'contracts', 'modules', `${moduleName}.md`);
  if (fs.existsSync(modShard)) {
    const content = fs.readFileSync(modShard, 'utf8');
    const blocks = [...content.matchAll(/```yaml\s*\n([\s\S]*?)\n```/g)];
    for (const m of blocks) {
      try {
        const parsed = yaml.load(m[1]);
        if (parsed && Array.isArray(parsed.owner_paths)) {
          paths.push(...parsed.owner_paths);
        }
      } catch { /* skip */ }
    }
  }

  // legacy MODULE_OWNERSHIP.md의 같은 모듈 헤더 안 yaml
  const legacy = path.join(cwd, 'MODULE_OWNERSHIP.md');
  if (fs.existsSync(legacy)) {
    const content = fs.readFileSync(legacy, 'utf8');
    const re = new RegExp(`^##+\\s+${moduleName}\\s*(?:모듈)?\\s*$([\\s\\S]*?)(?=^##+\\s|$)`, 'm');
    const m = content.match(re);
    if (m) {
      const blocks = [...m[1].matchAll(/```yaml\s*\n([\s\S]*?)\n```/g)];
      for (const b of blocks) {
        try {
          const parsed = yaml.load(b[1]);
          if (parsed && Array.isArray(parsed.owner_paths)) {
            paths.push(...parsed.owner_paths);
          }
        } catch { /* skip */ }
      }
    }
  }

  // 자동 shard 매핑 — 존재하는 것만 포함
  const shardCandidates = [
    `contracts/api/${moduleName}.md`,
    `contracts/db/${moduleName}.md`,
    `contracts/modules/${moduleName}.md`,
    `tasks/${moduleName}.md`,
  ];
  for (const s of shardCandidates) {
    if (fs.existsSync(path.join(cwd, s))) paths.push(s);
  }

  return paths;
}

/**
 * target이 모듈 이름인지 파일 경로인지 자동 인식.
 * - 파일 경로 패턴(슬래시·.md·.ts 등 포함)이면 file
 * - 그렇지 않으면 module
 */
function detectTargetKind(target) {
  if (target.includes('/') || target.includes('.')) return 'file';
  return 'module';
}

/**
 * edit-lock 획득. target은 모듈 또는 파일 경로.
 * @returns {{ok, file, action, kind, paths, holder?, error?}}
 */
function acquireEditLock(target, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const pid = opts.pid || process.pid;
  const sessionLabel = opts.sessionLabel || null;
  const kind = opts.kind || detectTargetKind(target);

  const dir = editLocksDir(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const file = lockFile(cwd, target);
  let action = 'fresh';

  if (fs.existsSync(file)) {
    const holder = readLockFile(file);
    if (holder && isAlive(holder.pid) && holder.session_label !== sessionLabel) {
      return {
        ok: false,
        error: `이미 점유 중 (pid=${holder.pid}, session=${holder.session_label || 'unknown'})`,
        holder,
      };
    }
    action = holder && holder.session_label === sessionLabel ? 're-acquire' : 'takeover';
  }

  // kind에 따라 파일 경로 결정
  let paths;
  if (kind === 'module') {
    paths = expandModuleFiles(target, { cwd });
    if (paths.length === 0) {
      // 모듈인데 shard나 ownership 정의 없음 — fallback 시도
      paths = [
        `contracts/api/${target}.md`,
        `contracts/db/${target}.md`,
        `contracts/modules/${target}.md`,
        `tasks/${target}.md`,
      ];
    }
  } else {
    paths = [target];
  }

  const payload = {
    target,
    kind,
    paths,
    pid,
    session_label: sessionLabel,
    acquired_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return { ok: true, file, action, kind, paths };
}

/**
 * edit-lock 해제. 자기 session_label과 일치할 때만 (force 옵션 있음).
 */
function releaseEditLock(target, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const sessionLabel = opts.sessionLabel || null;
  const file = lockFile(cwd, target);

  if (!fs.existsSync(file)) return { ok: true, removed: false };

  const holder = readLockFile(file);
  if (!opts.force && holder && holder.session_label !== sessionLabel) {
    return {
      ok: false,
      error: `다른 session(${holder.session_label || 'unknown'})이 점유 중. force 필요.`,
    };
  }

  fs.unlinkSync(file);
  return { ok: true, removed: true, paths: holder ? holder.paths : [] };
}

/**
 * 잡혀 있는 모든 edit-lock 목록.
 */
function listEditLocks(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const dir = editLocksDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.lock')) continue;
    const full = path.join(dir, f);
    const holder = readLockFile(full);
    if (!holder) continue;
    out.push({
      target: holder.target,
      kind: holder.kind,
      paths: holder.paths || [],
      pid: holder.pid,
      session_label: holder.session_label,
      acquired_at: holder.acquired_at,
      alive: isAlive(holder.pid),
    });
  }
  return out;
}

/**
 * 주어진 파일 경로가 어떤 edit-lock에 매칭되는지 검사.
 * @returns holder 또는 null
 */
function findLockForFile(filePath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
  const normalized = rel.split(path.sep).join('/');

  for (const lock of listEditLocks({ cwd })) {
    if (!lock.alive) continue;
    for (const pattern of lock.paths) {
      if (globMatches(normalized, pattern)) return lock;
    }
  }
  return null;
}

/**
 * stale (죽은 PID) edit-lock 일괄 정리.
 */
function cleanStaleEditLocks(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const dir = editLocksDir(cwd);
  if (!fs.existsSync(dir)) return { cleaned: [] };

  const cleaned = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.lock')) continue;
    const full = path.join(dir, f);
    const holder = readLockFile(full);
    if (!holder || !isAlive(holder.pid)) {
      try { fs.unlinkSync(full); cleaned.push(holder ? holder.target : f); } catch {}
    }
  }
  return { cleaned };
}

/** 간단한 glob 매칭 (pre-tool-guard의 패턴과 같은 의도). */
function globMatches(filePath, glob) {
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
  return new RegExp('^' + re + '$').test(filePath);
}

module.exports = {
  acquireEditLock,
  releaseEditLock,
  listEditLocks,
  findLockForFile,
  cleanStaleEditLocks,
  expandModuleFiles,
  detectTargetKind,
  editLocksDir,
  lockFile,
};
