'use strict';

// pact next — 현재 batch에서 미점유 task 한 개 출력.
// SOT: .pact/current_batch.json (modern prepare/admit이 쓰는 라이브 in-flight 집합, task_ids 평탄 배열).
// 부재 시에만 레거시 .pact/batch.json(`pact batch` 산출, batches[0]={index,task_ids})로 폴백.
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

// entry가 문자열이든 {id|task_id} 객체든 task_id 문자열로 정규화.
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map(t => (typeof t === 'string' ? t : t && (t.id || t.task_id))).filter(Boolean);
}

// 현재 batch의 task_id 목록을 읽는다.
// 1순위: current_batch.json.task_ids (평탄 문자열 배열).
// 2순위: batch.json.batches[0].task_ids (레거시 객체 포맷; 구(舊) 배열 포맷도 방어).
// 어느 파일도 없으면 null.
function readCurrentTaskIds(cwd) {
  const currentBatchPath = path.join(cwd, '.pact', 'current_batch.json');
  if (fs.existsSync(currentBatchPath)) {
    const cb = JSON.parse(fs.readFileSync(currentBatchPath, 'utf8'));
    return normalizeEntries(cb.task_ids || []);
  }
  const batchPath = path.join(cwd, '.pact', 'batch.json');
  if (fs.existsSync(batchPath)) {
    const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
    const first = (batch.batches && batch.batches[0]) || {};
    // first는 {index, task_ids} 객체 (batch.js:50-53). 구 배열 포맷도 수용.
    return normalizeEntries(Array.isArray(first) ? first : (first.task_ids || []));
  }
  return null;
}

module.exports = function next(args) {
  const { all, json } = parseArgs(args);
  const cwd = process.cwd();

  let taskIds;
  try {
    taskIds = readCurrentTaskIds(cwd);
  } catch (e) {
    console.error('batch 파일 파싱 실패:', e.message);
    process.exit(2);
  }

  if (taskIds === null) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: 'current_batch.json 없음 (/pact:parallel 또는 pact run-cycle prepare 먼저)' }) + '\n');
    else console.error('current_batch.json 없음. /pact:parallel 또는 pact run-cycle prepare 먼저.');
    process.exit(2);
  }

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
