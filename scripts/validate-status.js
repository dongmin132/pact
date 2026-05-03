'use strict';

// 워커 status.json 검증 (Contract-First 영감)
// hand-written validator (ADR-013, ajv 제거).

const fs = require('fs');
const { validateStatus } = require('./lib/validate-mini.js');

module.exports = { validateStatus };

// CLI: node validate-status.js <status.json>
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node validate-status.js <status.json>');
    process.exit(1);
  }
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`read failed: ${e.message}`);
    process.exit(2);
  }
  const r = validateStatus(obj);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.ok ? 0 : 3);
}
