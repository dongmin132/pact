'use strict';

// worker-guard — 헤드리스 드라이버 canUseTool 의 단일 소스 가드.
//
// pre-tool-guard hook 의 순수 함수(matchesGlob/isInsideWorktree/isBlockedLongSotRel)를
// 그대로 재사용 → 인터랙티브 워커(서브에이전트)와 헤드리스 워커가 "같은 안전 규칙"을 받는다.
// (드라이버가 자체 prefix 매칭을 쓰면 glob 의미가 달라져 패리티가 깨짐 → 이 모듈로 단일화.)

const path = require('path');
const ptg = require('../../hooks/pre-tool-guard.js');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// 워크트리 cwd 격리로도 못 막는 동적 파괴 — 정적 차단 (사후엔 collect git-diff 가 최종 방어선).
const DESTRUCTIVE = /\brm\s+-rf\b|\bgit\s+push\b|\b(sudo|mkfs|dd)\b|>\s*\/(etc|usr|bin|System)\b/;

function relInWorktree(target, workingDir) {
  const abs = path.isAbsolute(target) ? target : path.resolve(workingDir, target);
  const rel = path.relative(path.resolve(workingDir), abs).split(path.sep).join('/');
  return { abs, rel };
}

/**
 * 워커의 단일 도구 호출이 허용되는지 판정 (SDK canUseTool 용).
 * @param {string} toolName
 * @param {object} input  도구 입력 (file_path / command 등)
 * @param {{workingDir?:string, allowedPaths?:string[]}} ctx
 * @returns {{allow:boolean, reason?:string}}
 */
function guardToolUse(toolName, input, ctx = {}) {
  input = input || {};
  const { workingDir, allowedPaths } = ctx;

  // 워커의 서브에이전트 spawn 금지 (dogfood #9) — 워커는 일회용 단일 task 실행자
  // (ARCHITECTURE §14.2 nesting 금지). 서브에이전트는 이 가드·예산 밖에서 도는 비용
  // 폭주 벡터다(라이브 실측: 막힌 워커가 Agent 로 우회 시도). 나머지 미지 도구는
  // 기존대로 fail-open(맨 아래 allow) — 무해 도구(TodoWrite 등)까지 막지 않는다.
  if (toolName === 'Agent' || toolName === 'Task') {
    return { allow: false, reason: 'pact: 워커의 서브에이전트 spawn 금지 — 워커는 일회용 단일 task 실행자(중첩 금지). task 가 너무 크면 blocked 로 보고하세요.' };
  }

  // Read: 긴 SOT 원문 통째 Read 차단 (pre-tool-guard 와 동일 판정)
  if (toolName === 'Read') {
    const target = input.file_path || input.path || input.file;
    if (target && workingDir) {
      const { rel } = relInWorktree(target, workingDir);
      if (ptg.isBlockedLongSotRel(rel)) {
        return { allow: false, reason: `pact: 긴 SOT 원문(${rel}) 통째 Read 금지 — context.md / tasks/*.md / pact slice 사용` };
      }
    }
    return { allow: true };
  }

  // Write/Edit: worktree 경계 + allowed_paths(glob) 강제
  if (WRITE_TOOLS.has(toolName)) {
    const target = input.file_path || input.notebook_path || input.path;
    if (!target) return { allow: true };
    const { abs, rel } = relInWorktree(target, workingDir || process.cwd());
    if (workingDir && !ptg.isInsideWorktree(abs, path.resolve(workingDir))) {
      return { allow: false, reason: `pact: worktree(${workingDir}) 외부 쓰기 금지 — ${abs}` };
    }
    if (allowedPaths && allowedPaths.length) {
      const ok = allowedPaths.some((g) => ptg.matchesGlob(rel, g));
      if (!ok) return { allow: false, reason: `pact: allowed_paths 밖 — ${rel} (허용: ${allowedPaths.join(', ')})` };
    }
    return { allow: true };
  }

  // Bash: 정적 파괴 명령 차단 + allowed_paths 우회(워크트리 내 쓰기) 차단
  if (toolName === 'Bash') {
    const cmd = input.command || '';
    if (DESTRUCTIVE.test(cmd)) {
      return { allow: false, reason: `pact: 위험 명령 차단 — ${cmd}` };
    }
    // Write 툴은 allowed_paths 로 막지만 Bash 리다이렉션(> cat tee touch)이 백도어가 된다 (실측 CLEANUP-029).
    // 단일 소스: pre-tool-guard.checkBashWrite (parallel hook 과 동일 규칙). 워크트리 밖 타겟은 경계 분류
    // (형제 WT·본체 트리·레포 밖 deny / 자기 runs·/dev·임시파일 allow, STAB-4).
    if (workingDir && allowedPaths && allowedPaths.length) {
      const chk = ptg.checkBashWrite(cmd, { worktreeRoot: workingDir, allowedPaths });
      if (!chk.allowed) return { allow: false, reason: chk.reason };
    }
    return { allow: true };
  }

  return { allow: true };
}

module.exports = { guardToolUse };
