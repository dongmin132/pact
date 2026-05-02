'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectStack } = require('../scripts/detect-stack.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pact-stack-'));
}

test('Node + TypeScript', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      scripts: { lint: 'eslint', test: 'jest', build: 'tsc' },
      devDependencies: { typescript: '^5' },
    }));
    fs.writeFileSync(path.join(d, 'tsconfig.json'), '{}');
    const r = detectStack(d);
    assert.equal(r.stack, 'node-typescript');
    assert.equal(r.verify_commands.lint, 'npm run lint');
    assert.equal(r.verify_commands.test, 'npm test');
    assert.equal(r.verify_commands.build, 'npm run build');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Node — script 없으면 skip', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: {} }));
    const r = detectStack(d);
    assert.equal(r.stack, 'node');
    assert.equal(r.verify_commands.lint, 'skip');
    assert.equal(r.verify_commands.typecheck, 'skip');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Java Maven', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'pom.xml'), '<project/>');
    const r = detectStack(d);
    assert.equal(r.stack, 'java-maven');
    assert.equal(r.verify_commands.test, 'mvn test');
    assert.equal(r.verify_commands.build, 'mvn package');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Java Gradle (wrapper 있음)', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'build.gradle'), '');
    fs.writeFileSync(path.join(d, 'gradlew'), '#!/bin/sh');
    const r = detectStack(d);
    assert.equal(r.stack, 'java-gradle');
    assert.equal(r.verify_commands.test, './gradlew test');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Rust', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]');
    const r = detectStack(d);
    assert.equal(r.stack, 'rust');
    assert.equal(r.verify_commands.lint, 'cargo clippy');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Go', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'go.mod'), 'module x');
    const r = detectStack(d);
    assert.equal(r.stack, 'go');
    assert.equal(r.verify_commands.test, 'go test ./...');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Python', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]');
    const r = detectStack(d);
    assert.equal(r.stack, 'python');
    assert.equal(r.verify_commands.test, 'pytest');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('미감지 → unknown + 모두 skip', () => {
  const d = tmp();
  try {
    const r = detectStack(d);
    assert.equal(r.stack, 'unknown');
    assert.equal(r.verify_commands.lint, 'skip');
    assert.equal(r.verify_commands.test, 'skip');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
