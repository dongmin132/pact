'use strict';

// yolo 모드 감지 헬퍼.
// 우선순위:
// 1. hook payload (stdin) 의 permission_mode (가장 정확, 런타임)
// 2. .pact/state.json — SessionStart hook이 기록한 값
// 3. .claude/settings.json·~/.claude/settings.json 의 defaultMode (정적)
// 4. unknown

const fs = require('fs');
const path = require('path');
const os = require('os');

function fromPayload(stdin) {
  if (!stdin) return null;
  try {
    const p = JSON.parse(stdin);
    const m = p.permission_mode || p.permissionMode
      || (p.metadata && p.metadata.permission_mode);
    if (m) return { mode: m, source: 'payload' };
  } catch { /* */ }
  return null;
}

function fromState(cwd) {
  const f = path.join(cwd, '.pact', 'state.json');
  if (!fs.existsSync(f)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (s.permission_mode) return { mode: s.permission_mode, source: 'state.json' };
  } catch { /* */ }
  return null;
}

function fromSettings(cwd) {
  const candidates = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      const m = (s.permissions && s.permissions.defaultMode)
        || s.defaultMode;
      if (m) return { mode: m, source: f };
    } catch { /* */ }
  }
  return null;
}

/**
 * 현재 yolo 모드인지 감지.
 * @param {object} [opts]
 * @param {string} [opts.stdin] — hook payload (있으면 우선)
 * @param {string} [opts.cwd]
 * @returns {{is_yolo: boolean, mode: string, source: string}}
 */
function detectYolo(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const r = fromPayload(opts.stdin) || fromState(cwd) || fromSettings(cwd);
  if (!r) return { is_yolo: false, mode: 'unknown', source: 'none' };
  return {
    is_yolo: r.mode === 'bypassPermissions',
    mode: r.mode,
    source: r.source,
  };
}

module.exports = { detectYolo };

// CLI
if (require.main === module) {
  let stdin = '';
  if (!process.stdin.isTTY) {
    try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* */ }
  }
  const r = detectYolo({ stdin });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}
