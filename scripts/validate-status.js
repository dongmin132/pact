'use strict';

// 워커 status.json 검증 (Contract-First 영감)
//
// coordinator·pact merge가 통합 모드 진입 직전 호출.
// 형식 위반 → 워커 자동 blocked 처리, "거짓·누락 보고" 위험 줄임.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

let _validator = null;

function getValidator() {
  if (_validator) return _validator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  try {
    addFormats(ajv);
  } catch {
    // ajv-formats 없어도 동작 (date-time 검증만 약해짐)
  }
  const schemaPath = path.join(__dirname, '..', 'schemas', 'worker-status.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  _validator = ajv.compile(schema);
  return _validator;
}

function validateStatus(obj) {
  const validate = getValidator();
  const valid = validate(obj);
  if (valid) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (validate.errors || []).map(e => ({
      path: e.instancePath || '/',
      message: e.message,
      keyword: e.keyword,
    })),
  };
}

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
