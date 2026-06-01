'use strict';

// pact validate-status — worker가 status.json 작성 직전 self-validate (issue #3).
// scripts/validate-status.js의 CLI 모드와 동일 동작을 pact CLI에 노출.
//
// Exit:
//   0  통과
//   1  usage (인자 누락)
//   2  read fail
//   3  schema 위반 (stdout JSON.errors 참고)

const fs = require('fs');
const { validateStatus } = require('../../scripts/validate-status.js');

module.exports = function validateStatusCmd(args) {
  const filePath = args[0];
  if (!filePath) {
    console.error('Usage: pact validate-status <path/to/status.json>');
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
};
