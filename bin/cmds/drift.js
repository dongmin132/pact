'use strict';

// pact drift — reflect 사전수집 결정적 CLI (A-3, read-only). 얇은 래퍼: 코어는 scripts/drift.js.
// clean:true 면 /pact:reflect 가 planner(LLM) 호출을 건너뛴다.

const path = require('path');
const { computeDrift } = require(path.join(__dirname, '..', '..', 'scripts', 'drift.js'));

module.exports = function drift(args) {
  const projFlagIdx = (args || []).indexOf('--project');
  const cwd = projFlagIdx >= 0 && args[projFlagIdx + 1] ? path.resolve(args[projFlagIdx + 1]) : process.cwd();
  const r = computeDrift({ cwd });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  if (!r.ok) process.exitCode = 1;
};
