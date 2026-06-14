'use strict';

// atomic-write — temp+rename 원자적 쓰기. 절단(부분쓰기) 방지로 .pact/ SOT 무결성 보장.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeFileAtomic, writeJsonAtomic } = require('../scripts/lib/atomic-write.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pact-aw-'));
}

test('writeFileAtomic — 내용 정확히 기록', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'a.txt');
    writeFileAtomic(f, 'hello\nworld\n');
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello\nworld\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic — 기존 파일 덮어쓰기', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'OLD');
    writeFileAtomic(f, 'NEW');
    assert.equal(fs.readFileSync(f, 'utf8'), 'NEW');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic — 성공 후 .tmp 잔재 없음', () => {
  const dir = tmpDir();
  try {
    writeFileAtomic(path.join(dir, 'a.txt'), 'x');
    const leftovers = fs.readdirSync(dir).filter(n => n.includes('.tmp'));
    assert.deepEqual(leftovers, [], `tmp 잔재: ${leftovers}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeJsonAtomic — JSON round-trip (+개행)', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'a.json');
    writeJsonAtomic(f, { a: 1, b: [2, 3] });
    const raw = fs.readFileSync(f, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(raw), { a: 1, b: [2, 3] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
