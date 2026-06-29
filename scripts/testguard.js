'use strict';

// pact testguard — test-as-law (jmcentire/pact 차용).
// 워커가 자기 판정 테스트를 약화/우회 못 하게: 구현과 자기검증 테스트를 같은 task가
// 소유하면 플래그(propose-only). 테스트는 별도 task(author) 또는 frozen 표면이어야
// "테스트 통과 안 하면 머지 불가"가 진짜 강제된다.

// 테스트 경로: tests?/ specs?/ __tests__/ 디렉토리, 또는 .test.* / .spec.* 확장자.
const TEST_RE = /(^|\/)(tests?|specs?|__tests__)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i;
const isTestPath = (p) => TEST_RE.test(p);

function assessTestGuard(tasks = []) {
  const out = [];
  for (const t of tasks) {
    const allowed = Array.isArray(t.allowed_paths) ? t.allowed_paths : [];
    const testPaths = allowed.filter(isTestPath);
    const implPaths = allowed.filter((p) => !isTestPath(p));
    const broadGlobs = implPaths.filter((p) => p.includes('**'));

    if (testPaths.length && implPaths.length) {
      out.push({
        task: t.id, severity: 'violation', test_paths: testPaths,
        reason: '구현 + 자기검증 테스트를 같은 task가 소유 → 워커가 테스트를 약화해 통과시킬 수 있음',
      });
    } else if (!testPaths.length && broadGlobs.length) {
      out.push({
        task: t.id, severity: 'warn', globs: broadGlobs,
        reason: '광범위 글롭(**)이 테스트 파일까지 쓸어담을 수 있음 — 테스트 수정 가능 여지',
      });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'violation' ? -1 : 1));
}

function formatJson(rows) {
  return JSON.stringify({ flagged: rows }, null, 2);
}

function formatHuman(rows, project) {
  const L = [];
  L.push(`pact testguard — ${project}   (test-as-law, propose-only)`);
  L.push('');
  if (!rows.length) {
    L.push('✅  테스트를 자기가 수정 가능한 task 없음 — 테스트가 판정으로서 신뢰됨.');
  } else {
    L.push(`⚠️  자기 테스트 수정 가능 task ${rows.length}개`);
    for (const r of rows) {
      const ev = r.severity === 'violation' ? r.test_paths.join(', ') : r.globs.join(', ');
      L.push(`   [${r.severity}]  ${r.task}  (${ev}) — ${r.reason}`);
    }
    L.push('');
    L.push('→ 테스트를 별도 task(author)나 prelude로 분리 + 구현 task의 forbidden_paths에 추가.');
    L.push('   그래야 "테스트 통과 안 하면 머지 불가"가 진짜 강제됨(워커가 테스트 못 고침).');
  }
  return L.join('\n');
}

module.exports = { assessTestGuard, isTestPath, formatJson, formatHuman };
