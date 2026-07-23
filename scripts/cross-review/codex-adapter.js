'use strict';

// PACT-033 — Codex 어댑터
//
// codex CLI (OpenAI Codex headless 모드) 호출.
// check_available: codex --version 시도
// call_review: codex exec ... 호출 후 결과를 Finding[]로 변환
//
// 테스트 가능하도록 runner 주입 패턴.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// 임의의 파싱 결과(any) → 정규화된 Finding[]. 배열이 아니면 null.
function normalizeFindings(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.filter(f => f && typeof f.file === 'string' && typeof f.message === 'string')
    .map(f => ({
      file: f.file,
      line: typeof f.line === 'number' ? f.line : undefined,
      severity: ['info', 'warn', 'error'].includes(f.severity) ? f.severity : 'info',
      message: f.message,
      confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
    }));
}

function parseFindings(stdout) {
  if (!stdout) return [];
  // JSON 배열을 찾아 추출 (codex 사람용 stdout 에 다른 텍스트 섞일 수 있음 — 폴백 경로)
  const m = stdout.match(/\[\s*\{[\s\S]*?\}\s*\]|\[\s*\]/);
  if (!m) return [];
  try {
    const norm = normalizeFindings(JSON.parse(m[0]));
    return norm === null ? [] : norm;
  } catch {
    return [];
  }
}

// XREV-CODEX-3: --output-last-message 로 캡처한 '최종 assistant 메시지 파일' 파싱.
// 파일 전체를 JSON 으로 직접 parse 우선 (중첩 배열·message 내 `}]` 리터럴에서
// parseFindings 의 비그리디 정규식이 조기 절단하는 것을 회피). 순수 JSON 이
// 아니면 parseFindings 정규식 스크레이핑으로 폴백. 비어있으면 null(→ stdout 폴백 신호).
function parseCapturedMessage(captured) {
  const trimmed = (captured || '').trim();
  if (!trimmed) return null;
  try {
    const norm = normalizeFindings(JSON.parse(trimmed));
    if (norm !== null) return norm;
  } catch {
    /* 순수 JSON 아님 → 아래 정규식 폴백 */
  }
  return parseFindings(captured);
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
      // XREV-CODEX-3: 결정적 출력 캡처.
      // codex exec 의 최종 assistant 메시지만 --output-last-message 로 파일에 받아
      // 그 파일을 파싱한다. 기본 stdout 에는 추론·툴호출·프롬프트 에코가 섞여
      // 첫 `[{…}]` 매치가 가짜 finding(file:'<path>')이 될 위험이 있어 이를 구조적으로 회피.
      // 파일 미기록/파싱 실패/mkdtemp 실패 시엔 기존 stdout 스크레이핑으로 폴백(하위호환).
      // (2단계: --output-schema <schema.json> 로 Finding[] 스키마 강제 — 이번 스코프 밖)
      let tmpDir = null;
      let lastMsgFile = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-codex-'));
        lastMsgFile = path.join(tmpDir, 'last-message.txt');
      } catch {
        tmpDir = null;
        lastMsgFile = null;
      }
      const args = lastMsgFile
        ? ['exec', '--output-last-message', lastMsgFile, prompt]
        : ['exec', prompt];
      try {
        const r = runner(args, { timeout_ms });
        if (!r || r.status !== 0) {
          // M26: spawnSync 는 실행 자체 실패를 throw 대신 r.error(ENOENT=미설치·ETIMEDOUT=타임아웃)로
          // 준다 — 이를 버리고 'unknown' 으로 보고하면 인프라 오류가 리뷰 발견으로 위장된다. 원인을
          // 정확히 분류하고 kind:'infra' 로 표시(리뷰 결함 아님).
          const err = r && r.error;
          let message;
          if (err && err.code === 'ENOENT') message = 'codex CLI 미설치 (PATH 에 codex 없음) — cross-review 건너뜀. 설치: npm i -g @openai/codex 또는 codex 문서 참고';
          else if ((err && err.code === 'ETIMEDOUT') || (r && r.signal === 'SIGTERM')) message = `codex 타임아웃 (${timeout_ms}ms 초과) — cross-review 건너뜀`;
          else message = `codex 호출 실패: ${(r && r.stderr && r.stderr.trim().slice(0, 200)) || (err && err.message) || `exit ${r && r.status}`}`;
          return [{ file: '(adapter)', severity: 'warn', kind: 'infra', message }];
        }
        // 1차(결정적): 최종 메시지 파일이 있으면 그것만 신뢰.
        if (lastMsgFile) {
          let captured = null;
          try { captured = fs.readFileSync(lastMsgFile, 'utf8'); } catch { captured = null; }
          const parsed = parseCapturedMessage(captured);
          if (parsed !== null) return parsed;
        }
        // 2차(폴백): stdout 스크레이핑 — 파일 미기록/빈 파일/mkdtemp 실패 시.
        return parseFindings(r.stdout);
      } finally {
        if (tmpDir) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
        }
      }
    },
  };
}

module.exports = { createCodexAdapter, buildReviewPrompt, parseFindings, parseCapturedMessage, normalizeFindings };
