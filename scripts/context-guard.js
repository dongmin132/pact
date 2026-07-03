'use strict';

// pact context-guard 순수 코어 — 긴 문서 위험 수집 (사이드이펙트 X).
//
// STR-5 (P3-A): collectLongDocs 를 여기로 co-locate. 기존엔 bin/cmds/context-guard.js 안에
// 있어 run-cycle(prepare)가 형제 bin/cmds 를 라이브러리로 import 하는 레이어 역전이었다.
// 파일시스템 스캔(결정적, 출력 없음)은 scripts 레이어가 SOT — bin/cmds 는 얇은 CLI(출력)만.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_LINES = 1000;

function lineCount(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function fileExists(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function hasMarkdownShards(dir) {
  return fs.existsSync(dir)
    && fs.statSync(dir).isDirectory()
    && fs.readdirSync(dir).some(f => f.endsWith('.md'));
}

function listDocsMarkdown(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs.readdirSync(root)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(root, f));
}

function collectLongDocs(maxLines, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const abs = (p) => path.isAbsolute(p) ? p : path.join(cwd, p);

  const candidates = [
    { file: 'TASKS.md', replacementOk: () => hasMarkdownShards(abs('tasks')), fix: 'tasks/*.md shard 사용 또는 pact split-docs 실행' },
    { file: 'API_CONTRACT.md', replacementOk: () => hasMarkdownShards(abs('contracts/api')), fix: 'contracts/api/*.md shard 사용 또는 pact split-docs 실행' },
    { file: 'DB_CONTRACT.md', replacementOk: () => hasMarkdownShards(abs('contracts/db')), fix: 'contracts/db/*.md shard 사용 또는 pact split-docs 실행' },
  ];

  for (const file of listDocsMarkdown(abs('docs'))) {
    const base = path.basename(file).toLowerCase();
    if (/(prd|spec|requirements|product|dev)/.test(base)) {
      candidates.push({
        file: path.relative(cwd, file),
        replacementOk: () => false,
        fix: '긴 docs 문서는 에디터 선택 해제 후 pact slice-prd --headers/--section으로 필요한 섹션만 읽기',
      });
    }
  }

  const risks = [];
  for (const c of candidates) {
    if (!fileExists(abs(c.file))) continue;
    const lines = lineCount(abs(c.file));
    if (lines <= maxLines) continue;
    risks.push({
      file: c.file,
      lines,
      sharded: c.replacementOk(),
      fix: c.fix,
    });
  }
  return risks;
}

module.exports = {
  collectLongDocs,
  DEFAULT_MAX_LINES,
};
