'use strict';

// pact context-guard — /pact:parallel 진입 전 긴 문서가 기본 컨텍스트로 들어오는 사고를 막는다.
//
// 이 가드는 파일 시스템에서 확인 가능한 위험만 결정적으로 차단한다.
// VS Code 선택 영역 자체는 CLI가 볼 수 없으므로, 실패 메시지와 command 문서에서
// "긴 문서 선택 해제"를 별도 사용자 액션으로 요구한다.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_LINES = 1000;
const EXIT_CONTEXT_RISK = 7;

function parseArgs(args) {
  const opts = {
    parallel: args.includes('--parallel'),
    allowLongContext: args.includes('--allow-long-context'),
    maxLines: DEFAULT_MAX_LINES,
  };

  const maxIdx = args.indexOf('--max-lines');
  if (maxIdx >= 0 && args[maxIdx + 1]) {
    const n = Number(args[maxIdx + 1]);
    if (Number.isFinite(n) && n > 0) opts.maxLines = Math.floor(n);
  }

  return opts;
}

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

function collectLongDocs(maxLines) {
  const candidates = [
    { file: 'TASKS.md', replacementOk: () => hasMarkdownShards('tasks'), fix: 'tasks/*.md shard 사용 또는 pact split-docs 실행' },
    { file: 'API_CONTRACT.md', replacementOk: () => hasMarkdownShards('contracts/api'), fix: 'contracts/api/*.md shard 사용 또는 pact split-docs 실행' },
    { file: 'DB_CONTRACT.md', replacementOk: () => hasMarkdownShards('contracts/db'), fix: 'contracts/db/*.md shard 사용 또는 pact split-docs 실행' },
  ];

  for (const file of listDocsMarkdown('docs')) {
    const base = path.basename(file).toLowerCase();
    if (/(prd|spec|requirements|product|dev)/.test(base)) {
      candidates.push({
        file,
        replacementOk: () => false,
        fix: '긴 docs 문서는 에디터 선택 해제 후 pact slice-prd --headers/--section으로 필요한 섹션만 읽기',
      });
    }
  }

  const risks = [];
  for (const c of candidates) {
    if (!fileExists(c.file)) continue;
    const lines = lineCount(c.file);
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

function printRisks(risks, opts) {
  console.error('⚠️ context-guard: 긴 문서가 기본 컨텍스트로 들어갈 위험이 있습니다.');
  console.error(`max_lines=${opts.maxLines}`);
  for (const r of risks) {
    const state = r.sharded ? 'shard 있음, legacy 원문 선택 주의' : 'shard/section 필요';
    console.error(`- ${r.file}: ${r.lines} lines (${state})`);
    console.error(`  fix: ${r.fix}`);
  }
  console.error('');
  console.error('조치: 긴 문서를 VS Code에서 선택한 상태라면 선택을 해제하고, docs/context-map.md 또는 slice 명령으로 필요한 섹션만 읽으세요.');
  console.error('정말 강행해야 하면 pact context-guard --parallel --allow-long-context 를 명시적으로 사용하세요.');
}

module.exports = function contextGuard(args) {
  const opts = parseArgs(args);
  const risks = collectLongDocs(opts.maxLines);

  if (risks.length > 0 && opts.parallel && !opts.allowLongContext) {
    printRisks(risks, opts);
    process.exit(EXIT_CONTEXT_RISK);
  }

  if (risks.length === 0) {
    console.log(`✓ context-guard ok (max_lines=${opts.maxLines})`);
    return;
  }

  console.log(`context-guard warning only (risks=${risks.length}, allow_long_context=${opts.allowLongContext})`);
  for (const r of risks) {
    console.log(`- ${r.file}: ${r.lines} lines`);
  }
};
