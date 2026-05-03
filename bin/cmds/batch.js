'use strict';

// pact batch — TASKS.md → .pact/batch.json
// 결정적 알고리즘 (LLM 안 거침). batch-builder.js·parse-tasks.js 활용.

const fs = require('fs');
const path = require('path');

module.exports = function batch(args) {
  const tasksPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const outputPath = '.pact/batch.json';

  const { discoverTaskFiles, parseTaskFiles } = require(path.join(__dirname, '..', '..', 'scripts', 'task-sources.js'));
  const taskFiles = discoverTaskFiles({ file: tasksPath });
  if (taskFiles.length === 0) {
    console.error(`${tasksPath || 'TASKS.md 또는 tasks/*.md'} not found. /pact:plan을 먼저 실행하세요.`);
    process.exit(2);
  }

  const { buildBatches } = require(path.join(__dirname, '..', '..', 'batch-builder.js'));

  const parsed = parseTaskFiles(taskFiles);

  if (parsed.errors.length > 0) {
    console.error('task 파싱 에러:');
    parsed.errors.forEach(e => console.error(`  ${e.file || '?'} ${e.taskId || '-'}: ${e.error}`));
    process.exit(3);
  }

  if (parsed.tbdMarkers.length > 0) {
    console.error('TBD 마커 잔존:');
    parsed.tbdMarkers.forEach(m => console.error(`  ${m.taskId}: ${m.fields.join(', ')}`));
    console.error('/pact:contracts로 architect 호출하세요.');
    process.exit(4);
  }

  const plan = buildBatches(parsed.tasks, { maxBatchSize: 5 });

  if (plan.error) {
    console.error('배치 생성 실패:', plan.error);
    process.exit(5);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = {
    generated_at: new Date().toISOString(),
    task_sources: taskFiles,
    total_tasks: parsed.tasks.length,
    batches: plan.batches.map((b, i) => ({
      index: i,
      task_ids: b.map(t => t.id),
    })),
    skipped: plan.skipped.map(s => ({ task_id: s.task.id, reason: s.reason })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

  console.log(`✓ ${outputPath}`);
  console.log(`  source ${taskFiles.join(', ')}`);
  console.log(`  배치 ${plan.batches.length}개, 총 ${parsed.tasks.length}개 task, skipped ${plan.skipped.length}개`);
};
