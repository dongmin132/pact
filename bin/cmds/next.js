'use strict';

// pact next — .pact/batch.json의 batches[0]에서 미점유 task 한 개 출력.
// --all: 미점유 전부, --json: JSON

const fs = require('fs');
const path = require('path');
const { listLocks } = require('../../scripts/lock.js');

function parseArgs(args) {
  return {
    all: args.includes('--all'),
    json: args.includes('--json'),
  };
}

module.exports = function next(args) {
  const { all, json } = parseArgs(args);
  const cwd = process.cwd();

  const batchPath = path.join(cwd, '.pact', 'batch.json');
  if (!fs.existsSync(batchPath)) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: 'batch.json 없음 (pact batch 또는 pact run-cycle prepare 먼저)' }) + '\n');
    else console.error('batch.json 없음. pact batch 또는 pact run-cycle prepare 먼저.');
    process.exit(2);
  }

  let batch;
  try {
    batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  } catch (e) {
    console.error('batch.json 파싱 실패:', e.message);
    process.exit(2);
  }

  const currentBatch = (batch.batches && batch.batches[0]) || [];
  const taskIds = currentBatch.map(t => (typeof t === 'string' ? t : t.id || t.task_id)).filter(Boolean);

  // 살아있는 lock 잡힌 task 제외
  const heldByAlive = new Set(
    listLocks({ cwd }).filter(l => l.alive).map(l => l.task_id)
  );
  const available = taskIds.filter(id => !heldByAlive.has(id));

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, available, held: [...heldByAlive] }, null, 2) + '\n');
    return;
  }

  if (available.length === 0) {
    console.log('미점유 task 없음. (현재 batch 모두 다른 세션이 잡고 있음)');
    if (heldByAlive.size > 0) {
      console.log(`점유 중: ${[...heldByAlive].join(', ')}`);
    }
    process.exit(0);
  }

  if (all) {
    available.forEach(id => console.log(id));
  } else {
    console.log(available[0]);
    if (available.length > 1) console.error(`(${available.length - 1}개 더. --all로 전체)`);
  }
};
