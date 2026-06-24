'use strict';

// pact prelude — format.js
// tasks → 제안 객체(buildProposal) → 사람용 / JSON. propose-only(아무것도 안 고침).

const { detectFreezeCandidates } = require('./detect.js');
const { proposePreludes } = require('./propose.js');

function buildProposal(tasks = [], minShare = 3) {
  const { freeze, shardCandidates } = detectFreezeCandidates(tasks, minShare);
  const { preludes, rewrites } = proposePreludes(tasks, freeze);
  return { min_share: minShare, freeze, shard_candidates: shardCandidates, preludes, rewrites };
}

function formatJson(p) {
  return JSON.stringify(p, null, 2);
}

// 붙여넣기 가능한 prelude task yaml (사람이 tasks/ shard 에 추가)
function preludeYaml(pl) {
  const paths = pl.allowed_paths.map((p) => `  - ${p}`).join('\n');
  return [
    `## ${pl.id}  ${pl.dir} 공유표면 freeze`,
    '',
    '```yaml',
    'priority: P0',
    'status: todo',
    'dependencies: []',
    'allowed_paths:',
    paths,
    'done_criteria:',
    '  - 위 공유파일을 이번 배치용으로 한 번에 확정(freeze)하고 typecheck 통과',
    'tdd: false',
    '```',
  ].join('\n');
}

function formatHuman(p, project) {
  const L = [];
  L.push(`pact prelude — ${project}   (propose-only, 안 고침)`);
  L.push(`공유 task 임계 min=${p.min_share}`);
  L.push('');

  if (!p.freeze.length) {
    L.push('🧊  FREEZE 후보 없음 — 구체 공유파일이 임계 미만. (--min 낮춰보기)');
  } else {
    L.push(`🧊  FREEZE 후보 (구체 공유파일 ${p.freeze.length}개)`);
    for (const f of p.freeze.slice(0, 12)) {
      L.push(`   ${String(f.tasks.length).padStart(2)} tasks  ${f.path}   ← ${f.tasks.slice(0, 6).join(', ')}${f.tasks.length > 6 ? ' …' : ''}`);
    }
  }
  L.push('');

  if (p.preludes.length) {
    L.push(`📦  제안 prelude task ${p.preludes.length}개 (붙여넣기용 yaml)`);
    for (const pl of p.preludes) {
      L.push('');
      L.push(preludeYaml(pl));
    }
    L.push('');
    L.push('✂️  의존 task 재작성 (반영하거나 /pact:plan 에)');
    for (const r of p.rewrites) {
      L.push(`   ${r.task}: +dep ${r.deps.join(',')} (complete) · -allowed ${r.removed_paths.join(', ')} (→forbidden)`);
    }
    L.push('');
  }

  if (p.shard_candidates.length) {
    L.push(`🧩  샤딩 후보 (글롭 — freeze 안 함, v2 후보)`);
    for (const s of p.shard_candidates.slice(0, 8)) {
      L.push(`   ${String(s.tasks.length).padStart(2)} tasks  ${s.path}`);
    }
    L.push('');
  }

  L.push('→ 적용: prelude task를 tasks/ shard에 추가 + 위 재작성 반영 후 /pact:parallel.');
  L.push('   (buildBatches가 prelude를 wave 0, 의존들을 병렬 배치 / pre-tool-guard가 공유파일 수정 차단)');
  return L.join('\n');
}

module.exports = { buildProposal, formatHuman, formatJson, preludeYaml };
