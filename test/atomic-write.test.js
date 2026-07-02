'use strict';

// atomic-write — temp+rename 원자적 쓰기. 절단(부분쓰기) 방지로 .pact/ SOT 무결성 보장.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeFileAtomic, writeJsonAtomic, writeFileExclusive } = require('../scripts/lib/atomic-write.js');

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

// ─── writeFileExclusive (STAB-2: 락 O_EXCL/link 기반 배타 공개) ───

test('writeFileExclusive — 새 파일이면 true + 내용 정확', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'lock.pid');
    const won = writeFileExclusive(f, 'first\n');
    assert.equal(won, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'first\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileExclusive — 이미 존재하면 false(EEXIST) + 기존 내용 보존', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'lock.pid');
    assert.equal(writeFileExclusive(f, 'first\n'), true);
    // 두 번째 획득자는 원자적으로 패배 — 기존 내용 절대 훼손 X
    assert.equal(writeFileExclusive(f, 'second\n'), false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'first\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileExclusive — 성공/패배 모두 tmp 잔재 없음', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'lock.pid');
    writeFileExclusive(f, 'first\n');   // 성공
    writeFileExclusive(f, 'second\n');  // 패배(EEXIST)
    const leftovers = fs.readdirSync(dir).filter(n => n.includes('.xtmp') || n.includes('.tmp'));
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
