'use strict';

// pact context-guard — /pact:parallel 진입 전 긴 문서 위험을 경고한다 (얇은 CLI).
//
// 이 가드는 파일 시스템에서 확인 가능한 위험을 알려준다.
// VS Code 선택 영역 자체는 CLI가 볼 수 없으므로, 실패 메시지와 command 문서에서
// "긴 문서 선택 해제"를 별도 사용자 액션으로 요구한다.
//
// STR-5 (P3-A): 순수 스캔 코어 collectLongDocs 는 scripts/context-guard.js 로 co-locate 되어
// run-cycle 의 형제 bin/cmds import 레이어 역전을 없앴다. 이 파일은 인자 파싱 + 출력만 담는다.
// collectLongDocs·DEFAULT_MAX_LINES 는 하위호환 위해 재export.

const { collectLongDocs, DEFAULT_MAX_LINES } = require('../../scripts/context-guard.js');

function parseArgs(args) {
  const opts = {
    parallel: args.includes('--parallel'),
    allowLongContext: args.includes('--allow-long-context'),
    quiet: args.includes('--quiet') || args.includes('-q'),
    maxLines: DEFAULT_MAX_LINES,
  };

  const maxIdx = args.indexOf('--max-lines');
  if (maxIdx >= 0 && args[maxIdx + 1]) {
    const n = Number(args[maxIdx + 1]);
    if (Number.isFinite(n) && n > 0) opts.maxLines = Math.floor(n);
  }

  return opts;
}

function printRisks(risks, opts) {
  console.log('⚠️ context-guard warning: 긴 문서가 기본 컨텍스트로 들어갈 위험이 있습니다.');
  console.log(`max_lines=${opts.maxLines}`);
  for (const r of risks) {
    const state = r.sharded ? 'shard 있음, legacy 원문 선택 주의' : 'shard/section 필요';
    console.log(`- ${r.file}: ${r.lines} lines (${state})`);
    console.log(`  fix: ${r.fix}`);
  }
  console.log('');
  console.log('조치: 긴 문서를 VS Code에서 선택한 상태라면 선택을 해제하세요.');
  console.log('워커의 긴 SOT 원문 Read는 PreToolUse hook이 실제 호출 순간 차단합니다.');
}

module.exports = contextGuard;
module.exports.collectLongDocs = collectLongDocs;
module.exports.DEFAULT_MAX_LINES = DEFAULT_MAX_LINES;

function contextGuard(args) {
  const opts = parseArgs(args);
  const risks = collectLongDocs(opts.maxLines);

  if (opts.quiet) {
    if (risks.length === 0) console.log('context-guard ok');
    else console.log(`context-guard warn: ${risks.length} long doc(s)`);
    return;
  }

  if (risks.length > 0 && opts.parallel && !opts.allowLongContext) {
    printRisks(risks, opts);
    return;
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
