'use strict';

// pact scopecheck — done_criteria ⊄ allowed_paths 계약모순 정적 검출 (propose-only)
//
// task 의 done_criteria 가 allowed_paths **밖**의 파일 생성을 의무화하면, 워커는 task 를
// 충실히 이행하지만 merge 게이트가 files_attempted_outside_scope 로 통째 거부한다.
// (brewdy CLEANUP-029: allowed_paths=components/meetup/** 인데 done_criteria 가
//  docs/ui/cleanup-011-review.md 생성을 의무화 → 16분·$3.91 낭비.)
// 이 계약모순을 fan-out 전에 정적으로 잡아 분해·수정을 제안한다.
//
// 휴리스틱(완벽X) — 최종 백스톱은 merge 게이트 git-diff. 목표는 plan-time 조기경보.
//  판별 신호 = "생성 동사" + "allowed_paths 밖 path 토큰"이 같은 criterion 에 공존.
//  검증-only path 언급(eslint 실행 등)은 생성 동사가 없어 자동 제외 → 오탐 최소화.

const { pathsOverlap } = require('../batch-builder.js');

// 파일 생성/산출 의무를 뜻하는 동사. 검증(exit 0, 반환, 통과)과 구분하는 핵심 필터.
const CREATION_VERB_RE = /생성|산출|작성|만들|출력|저장|create|produce|generate|scaffold|author|\bwrite\b/i;

// path 토큰: `/` 구분 세그먼트. 명령 플래그(--max-warnings=0)·자연어와 구분.
const PATH_TOKEN_RE = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+/g;

// 파일 또는 글롭처럼 보이는가 (확장자 있음 OR 글롭 포함). 디렉토리-only 명사 배제.
function looksLikePath(tok) {
  if (tok.includes('://')) return false; // URL 배제
  const last = tok.split('/').pop();
  return /\.[A-Za-z0-9]{1,6}$/.test(last) || tok.includes('*');
}

// 한 criterion 문자열에서 생성 의무 대상 path 토큰만 추출.
function extractCreationPaths(criterion) {
  if (typeof criterion !== 'string') return [];
  if (!CREATION_VERB_RE.test(criterion)) return [];
  const out = [];
  for (const m of criterion.match(PATH_TOKEN_RE) || []) {
    const tok = m.replace(/\.+$/, ''); // 문장 끝 마침표 제거
    if (looksLikePath(tok)) out.push(tok);
  }
  return out;
}

// 한 task 평가: done_criteria 의 생성 path 중 allowed_paths 밖이면 위반.
function assessTask(t) {
  const allowed = Array.isArray(t.allowed_paths) ? t.allowed_paths : [];
  const criteria = Array.isArray(t.done_criteria) ? t.done_criteria : [];
  const violations = [];
  if (allowed.length && criteria.length) {
    for (const c of criteria) {
      for (const p of extractCreationPaths(c)) {
        if (!pathsOverlap([p], allowed)) {
          violations.push({ path: p, criterion: String(c).trim() });
        }
      }
    }
  }
  return {
    task: t.id,
    risk: violations.length ? 'scope_contradiction' : 'ok',
    violations,
  };
}

function assessTasks(tasks = []) {
  return tasks
    .map(assessTask)
    .filter((r) => r.risk !== 'ok')
    .sort((a, b) => String(a.task).localeCompare(String(b.task)));
}

// 밖-디렉토리별 롤업: 여러 task 가 같은 allowed_paths 밖 디렉토리를 생성 의무화하면
// (educational-mode docs/learning/** 처럼) 개별 나열 대신 "1개 시스템 이슈"로 드러낸다.
function summarizeByDir(rows) {
  const by = new Map();
  for (const r of rows) {
    for (const v of r.violations) {
      const slash = v.path.lastIndexOf('/');
      const dir = slash >= 0 ? v.path.slice(0, slash) : '.';
      if (!by.has(dir)) by.set(dir, new Set());
      by.get(dir).add(r.task);
    }
  }
  return [...by.entries()]
    .map(([dir, tasks]) => ({ dir, count: tasks.size }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

function formatJson(rows) {
  return JSON.stringify({ flagged: rows }, null, 2);
}

function formatHuman(rows, project) {
  const L = [];
  L.push(`pact scopecheck — ${project}   (done_criteria ⊄ allowed_paths, propose-only)`);
  L.push('');
  if (!rows.length) {
    L.push('✅  계약모순 없음 — done_criteria 가 allowed_paths 밖 파일 생성을 요구하지 않음.');
  } else {
    L.push(`⚠️  계약모순 task ${rows.length}개 — done_criteria 가 allowed_paths 밖 파일 생성을 의무화`);
    // 시스템 패턴 롤업 — 같은 밖-디렉토리가 여러 task 에 반복되면 개별 아닌 한 이슈.
    const groups = summarizeByDir(rows).filter((g) => g.count > 1);
    if (groups.length) {
      L.push('');
      L.push('   시스템 패턴 (같은 범위 밖 디렉토리 반복 → 한 번에 해결):');
      for (const g of groups) {
        L.push(`     • ${g.dir}/  — ${g.count}개 task (allowed_paths 에 ${g.dir}/** 추가 or 해당 생성 의무 제거)`);
      }
    }
    for (const r of rows) {
      L.push('');
      L.push(`   [${r.task}]  범위 밖 생성 ${r.violations.length}건`);
      for (const v of r.violations) {
        L.push(`     • ${v.path}`);
        L.push(`       ↳ "${v.criterion}"`);
      }
    }
    L.push('');
    L.push('→ 워커는 done_criteria 를 충실히 이행하지만 merge 게이트가 범위 밖 파일을 거부한다(작업 통째 유실).');
    L.push('  수정: (a) 그 파일 경로를 allowed_paths 에 추가, 또는 (b) done_criteria 에서 범위 밖 생성 의무 제거.');
  }
  return L.join('\n');
}

module.exports = {
  assessTask,
  assessTasks,
  summarizeByDir,
  extractCreationPaths,
  looksLikePath,
  formatJson,
  formatHuman,
};
