'use strict';

// PACT-033 — Codex 어댑터
//
// codex CLI (OpenAI Codex headless 모드) 호출.
// check_available: codex --version 시도
// call_review: codex exec ... 호출 후 결과를 Finding[]로 변환
//
// 테스트 가능하도록 runner 주입 패턴.

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function defaultRunner(args, opts = {}) {
  return spawnSync('codex', args, {
    encoding: 'utf8',
    timeout: opts.timeout_ms || DEFAULT_TIMEOUT_MS,
    cwd: opts.cwd || process.cwd(),
  });
}

function buildReviewPrompt(input) {
  const targetLabel = input.target === 'plan' ? '설계 (plan)' : '코드 변경 (cycle diff)';
  return [
    `# pact cross-review (${targetLabel})`,
    '',
    '다음 자료를 검토하고 발견 사항을 JSON 배열로 반환해주세요.',
    '',
    '## 컨텍스트',
    input.context || '(없음)',
    '',
    '## 자료',
    ...(input.artifacts || []).map(a => `- ${a}`),
    '',
    '## 출력 형식 (JSON 배열, 한국어 message)',
    '[{"file": "<path>", "line": <number?>, "severity": "info|warn|error", "message": "<한국어>", "confidence": <1-10?>}]',
    '',
    '발견 0개면 빈 배열 `[]`. 추측은 confidence ≤ 4로 표기.',
  ].join('\n');
}

function parseFindings(stdout) {
  if (!stdout) return [];
  // JSON 배열을 찾아 추출 (codex 출력에 다른 텍스트 섞일 수 있음)
  const m = stdout.match(/\[\s*\{[\s\S]*?\}\s*\]|\[\s*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter(f => f && typeof f.file === 'string' && typeof f.message === 'string')
      .map(f => ({
        file: f.file,
        line: typeof f.line === 'number' ? f.line : undefined,
        severity: ['info', 'warn', 'error'].includes(f.severity) ? f.severity : 'info',
        message: f.message,
        confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
      }));
  } catch {
    return [];
  }
}

function createCodexAdapter(opts = {}) {
  const runner = opts.runner || defaultRunner;
  const timeout_ms = opts.timeout_ms || DEFAULT_TIMEOUT_MS;

  return {
    name: 'codex',

    async check_available() {
      const r = runner(['--version'], { timeout_ms: 5000 });
      return r && r.status === 0;
    },

    async call_review(input) {
      const prompt = buildReviewPrompt(input);
      const r = runner(['exec', prompt], { timeout_ms });
      if (!r || r.status !== 0) {
        return [{
          file: '(adapter)',
          severity: 'warn',
          message: `codex 호출 실패 또는 timeout: ${r && r.stderr ? r.stderr.trim().slice(0, 200) : 'unknown'}`,
        }];
      }
      return parseFindings(r.stdout);
    },
  };
}

module.exports = { createCodexAdapter, buildReviewPrompt, parseFindings };
