// batch-builder.js
//
// pact — 워커 배치 구성 알고리즘 (v1.0)
//
// orchestrator가 병렬 워커를 안전하게 spawn하기 위한 사전 계산.
// 입력: TASKS.md에서 파싱된 task 배열
// 출력: 순차 실행할 배치 목록 + 실행 불가 task 목록
//
// 설계 원칙
// 1. 정적 path 기반 충돌 감지 (dynamic lock보다 단순·안전)
// 2. 의존성 그래프로 순서 보장
// 3. 배치당 최대 워커 수 제한 (토큰 비용 통제)
// 4. cycle / deadlock 발견 시 즉시 사용자 위임 (절대 추측 X)
// 5. skipped task는 반드시 사유와 함께 반환

'use strict';

// ─────────────────────────────────────────────────────────────
// JSDoc 타입
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Task
 * @property {string}   id              - 고유 ID (예: "PACT-042")
 * @property {string}   title
 * @property {'backend'|'frontend'|'ai'|'qa'} worker_type
 * @property {string[]} allowed_paths   - glob 가능
 * @property {Array<string|{task_id: string, kind: 'complete'|'contract_only'}>} dependencies
 *           - 다른 task의 id (string) 또는 {task_id, kind} 객체. kind 생략 시 'complete' 취급.
 * @property {'todo'|'in_progress'|'done'|'failed'} status
 * @property {number}   retry_count
 */

/**
 * @typedef {Object} BatchPlanOptions
 * @property {number} [maxBatchSize]   - 배치당 최대 워커 수 (기본 4)
 */

/**
 * @typedef {Object} SkippedTask
 * @property {Task}   task
 * @property {string} reason
 */

/**
 * @typedef {Object} BatchPlan
 * @property {Task[][]}      batches    - 순차 실행할 배치 목록
 * @property {SkippedTask[]} skipped    - 실행 불가 task와 사유
 * @property {string|null}   error      - 치명적 오류 (cycle 등)
 */


// ─────────────────────────────────────────────────────────────
// Glob 매칭 (외부 의존성 없는 최소 구현)
//   지원: ** (재귀), * (단일 segment), 일반 문자/구분자
//   미지원: ?, [abc], brace expansion
//   MODULE_OWNERSHIP.md 용도엔 충분
// ─────────────────────────────────────────────────────────────

const _globRegexCache = new Map();

function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++; // `**/` 형태에서 / 흡수
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

function matchesGlob(path, glob) {
  let re = _globRegexCache.get(glob);
  if (!re) {
    re = globToRegex(glob);
    _globRegexCache.set(glob, re);
  }
  return re.test(path);
}


// ─────────────────────────────────────────────────────────────
// 경로 충돌 감지
// ─────────────────────────────────────────────────────────────

/** glob에서 첫 wildcard 직전까지의 디렉토리 prefix 추출 */
function literalDirPrefix(glob) {
  const idx = glob.search(/[*?]/);
  if (idx === -1) {
    // wildcard 없음 = 구체 경로. 파일 자체를 prefix로 취급
    return glob;
  }
  const before = glob.slice(0, idx);
  const lastSlash = before.lastIndexOf('/');
  return lastSlash >= 0 ? before.slice(0, lastSlash) : '';
}

/** a가 b의 디렉토리 prefix인가 (또는 동일) */
function isDirPrefixOf(a, b) {
  if (a === b) return true;
  if (a === '') return true; // empty prefix는 모든 것의 prefix
  return b.startsWith(a + '/');
}

/** 경계가 비어있는(cross-cutting) glob인가 — 보수적으로 충돌 처리 */
function isCrossCutting(glob) {
  return literalDirPrefix(glob) === '' && glob.includes('*');
}

/** 두 path 패턴이 겹칠 가능성이 있는가 */
function singlePairOverlaps(a, b) {
  if (a === b) return true;

  // cross-cutting glob은 무조건 충돌로 간주
  if (isCrossCutting(a) || isCrossCutting(b)) return true;

  const aHasGlob = a.includes('*');
  const bHasGlob = b.includes('*');

  if (!aHasGlob && !bHasGlob) {
    return a === b; // 둘 다 구체 경로
  }
  if (aHasGlob && !bHasGlob) {
    return matchesGlob(b, a);
  }
  if (!aHasGlob && bHasGlob) {
    return matchesGlob(a, b);
  }

  // 둘 다 glob — prefix 비교
  const aPrefix = literalDirPrefix(a);
  const bPrefix = literalDirPrefix(b);
  return isDirPrefixOf(aPrefix, bPrefix) || isDirPrefixOf(bPrefix, aPrefix);
}

/** 두 path 집합이 한 쌍이라도 겹치면 true */
function pathsOverlap(pathsA, pathsB) {
  for (const a of pathsA) {
    for (const b of pathsB) {
      if (singlePairOverlaps(a, b)) return true;
    }
  }
  return false;
}


// ─────────────────────────────────────────────────────────────
// 입력 검증
// ─────────────────────────────────────────────────────────────

function validateInput(tasks) {
  if (!Array.isArray(tasks)) {
    return { error: 'tasks must be an array' };
  }

  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') {
      return { error: 'task missing id' };
    }
    if (ids.has(t.id)) {
      return { error: `duplicate task id: ${t.id}` };
    }
    ids.add(t.id);

    if (!Array.isArray(t.allowed_paths) || t.allowed_paths.length === 0) {
      return { error: `task ${t.id} has empty allowed_paths` };
    }
    if (!Array.isArray(t.dependencies)) {
      return { error: `task ${t.id} dependencies must be an array` };
    }
  }

  // 의존성 참조 무결성 (string 또는 {task_id, kind} 둘 다 지원)
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      const depId = typeof dep === 'string' ? dep : dep && dep.task_id;
      if (!depId || !ids.has(depId)) {
        return { error: `task ${t.id} depends on unknown task ${JSON.stringify(dep)}` };
      }
    }
  }

  return { error: null };
}

/** 의존성 entry → task_id 추출. string 또는 {task_id, kind} 둘 다 지원. */
function depTaskId(dep) {
  return typeof dep === 'string' ? dep : (dep && dep.task_id);
}

/** 의존성 entry → kind 추출. 생략 시 'complete' default. */
function depKind(dep) {
  if (typeof dep === 'string') return 'complete';
  return (dep && dep.kind) || 'complete';
}


// ─────────────────────────────────────────────────────────────
// 의존성 cycle 감지 — Kahn's algorithm
// ─────────────────────────────────────────────────────────────

function detectCycles(tasks) {
  const inDegree = new Map();
  const adj = new Map();

  for (const t of tasks) {
    inDegree.set(t.id, t.dependencies.length);
    if (!adj.has(t.id)) adj.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      const depId = depTaskId(dep);
      if (!adj.has(depId)) adj.set(depId, []);
      adj.get(depId).push(t.id);
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    processed++;
    for (const nbr of (adj.get(id) || [])) {
      inDegree.set(nbr, inDegree.get(nbr) - 1);
      if (inDegree.get(nbr) === 0) queue.push(nbr);
    }
  }

  if (processed < tasks.length) {
    const involved = tasks
      .filter(t => inDegree.get(t.id) > 0)
      .map(t => t.id);
    return { hasCycle: true, involved };
  }
  return { hasCycle: false, involved: [] };
}


// ─────────────────────────────────────────────────────────────
// 배치 패킹 (그리디)
// ─────────────────────────────────────────────────────────────

function allDependenciesMet(task, completedIds, contractDefinedIds) {
  return task.dependencies.every(dep => {
    const id = depTaskId(dep);
    const kind = depKind(dep);
    if (kind === 'contract_only') {
      return contractDefinedIds ? contractDefinedIds.has(id) : completedIds.has(id);
    }
    return completedIds.has(id);
  });
}

function packBatch(candidates, maxSize) {
  const batch = [];
  for (const c of candidates) {
    if (batch.length >= maxSize) break;
    const conflicts = batch.some(t => pathsOverlap(t.allowed_paths, c.allowed_paths));
    if (!conflicts) {
      batch.push(c);
    }
    // 충돌하는 candidate은 자연스럽게 다음 배치로 넘어감
  }
  return batch;
}


// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────

/**
 * Task 목록을 받아 충돌 없고 의존성을 만족하는 배치 계획을 생성한다.
 * @param {Task[]} tasks
 * @param {BatchPlanOptions} [options]
 * @returns {BatchPlan}
 */
function buildBatches(tasks, options = {}) {
  const maxBatchSize = options.maxBatchSize ?? 4;

  // 1) 입력 검증
  const v = validateInput(tasks);
  if (v.error) {
    return { batches: [], skipped: [], error: v.error };
  }

  // 2) Cycle 감지
  const cycle = detectCycles(tasks);
  if (cycle.hasCycle) {
    return {
      batches: [],
      skipped: tasks.map(t => ({ task: t, reason: 'in_dependency_cycle' })),
      error: `의존성 사이클: ${cycle.involved.join(', ')} — 사용자 결정 필요`
    };
  }

  // 3) 그리디 배치 구성
  const completedIds = new Set(
    tasks.filter(t => t.status === 'done').map(t => t.id)
  );
  const batches = [];
  const skipped = [];
  let remaining = tasks.filter(
    t => t.status !== 'done' && t.status !== 'failed'
  );

  // 안전장치: 어떤 경우에도 무한루프 방지
  let safety = 1000;

  while (remaining.length > 0 && safety-- > 0) {
    const ready = remaining.filter(t => allDependenciesMet(t, completedIds));

    if (ready.length === 0) {
      // 의존성 미충족 task만 남음 — 어딘가가 막혀 있음
      for (const t of remaining) {
        skipped.push({ task: t, reason: 'unmet_dependency_after_planning' });
      }
      break;
    }

    const batch = packBatch(ready, maxBatchSize);

    if (batch.length === 0) {
      // 모든 ready task가 서로 충돌 — 비정상
      for (const t of ready) {
        skipped.push({ task: t, reason: 'mutual_path_conflict' });
      }
      break;
    }

    batches.push(batch);
    for (const t of batch) {
      completedIds.add(t.id); // 스케줄된 = 완료된 것으로 취급
    }
    const batchIds = new Set(batch.map(t => t.id));
    remaining = remaining.filter(t => !batchIds.has(t.id));
  }

  if (safety <= 0) {
    return { batches, skipped, error: 'safety counter exhausted (algorithm bug)' };
  }

  return { batches, skipped, error: null };
}

module.exports = {
  buildBatches,
  // 테스트용 export
  pathsOverlap,
  detectCycles,
  validateInput,
  depTaskId,
  depKind,
};


// ─────────────────────────────────────────────────────────────
// Demo — 실제 실행해보기
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const tasks = [
    {
      id: 'PACT-001',
      title: '로그인 API 핸들러',
      worker_type: 'backend',
      allowed_paths: ['src/api/auth/login.ts', 'src/types/auth.ts'],
      dependencies: [],
      status: 'todo',
      retry_count: 0,
    },
    {
      id: 'PACT-002',
      title: '회원가입 API 핸들러',
      worker_type: 'backend',
      // src/types/auth.ts를 PACT-001과 공유 → 같은 배치 금지
      allowed_paths: ['src/api/auth/signup.ts', 'src/types/auth.ts'],
      dependencies: [],
      status: 'todo',
      retry_count: 0,
    },
    {
      id: 'PACT-003',
      title: '관리자 사용자 목록 페이지',
      worker_type: 'frontend',
      allowed_paths: ['src/app/admin/users/**'],
      dependencies: [],
      status: 'todo',
      retry_count: 0,
    },
    {
      id: 'PACT-004',
      title: '리포트 생성 prompt',
      worker_type: 'ai',
      allowed_paths: ['prompts/report/**'],
      dependencies: [],
      status: 'todo',
      retry_count: 0,
    },
    {
      id: 'PACT-005',
      title: '관리자 사용자 목록 e2e 테스트',
      worker_type: 'qa',
      allowed_paths: ['tests/e2e/admin/users.spec.ts'],
      // PACT-003 페이지가 먼저 만들어져야 함
      dependencies: ['PACT-003'],
      status: 'todo',
      retry_count: 0,
    },
    {
      id: 'PACT-006',
      title: '리포트 생성 API',
      worker_type: 'backend',
      allowed_paths: ['src/api/reports/**'],
      // PACT-004의 prompt가 먼저 정의돼야 함
      dependencies: ['PACT-004'],
      status: 'todo',
      retry_count: 0,
    },
  ];

  const plan = buildBatches(tasks, { maxBatchSize: 4 });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Batch Plan');
  console.log('═══════════════════════════════════════════════════════════');
  if (plan.error) {
    console.log('❌ ERROR:', plan.error);
  } else {
    plan.batches.forEach((batch, i) => {
      console.log(`\nBatch ${i + 1}  (${batch.length}개 워커 병렬):`);
      for (const t of batch) {
        console.log(`  • [${t.worker_type.padEnd(8)}] ${t.id}  ${t.title}`);
      }
    });
    if (plan.skipped.length > 0) {
      console.log('\n⚠️  Skipped:');
      for (const s of plan.skipped) {
        console.log(`  • ${s.task.id} — ${s.reason}`);
      }
    }
  }
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('충돌 감지 단위 테스트');
  console.log('═══════════════════════════════════════════════════════════');

  const cases = [
    [['src/types/auth.ts'], ['src/types/auth.ts'], true,  '동일 파일'],
    [['src/api/auth/**'],   ['src/api/auth/login.ts'], true,  'glob이 구체 경로 포함'],
    [['src/api/**'],        ['src/api/auth/**'], true,  '상위 glob이 하위 포함'],
    [['src/api/auth/**'],   ['src/api/users/**'], false, '동급 다른 디렉토리'],
    [['src/api/auth/**'],   ['src/components/**'], false, '완전 다른 트리'],
    [['**/*.test.ts'],      ['src/api/auth/login.ts'], true, 'cross-cutting 보수적 충돌'],
  ];

  for (const [a, b, expected, label] of cases) {
    const actual = pathsOverlap(a, b);
    const ok = actual === expected ? '✅' : '❌';
    console.log(`  ${ok} ${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)} → ${actual}`);
  }
}
