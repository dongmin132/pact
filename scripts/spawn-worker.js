'use strict';

// PACT-008 — 워커 spawn 헬퍼
//
// 메인 Claude가 Task tool로 워커를 호출하기 전에:
// 1. payload 검증
// 2. 시스템 프롬프트 렌더 (placeholder 치환)
// 3. .pact/runs/<task_id>/payload.json 작성 (재현용)
// 4. 전체 worker prompt는 파일로 저장
// 5. Task tool에 넘길 compact prompt + 보고 경로 반환
//
// **메인 Claude는 CLI stdout의 task_prompt만 Task tool 호출 시 prompt 인자로 사용한다.**
// 워커는 자기 시스템 프롬프트의 지시대로 종료 직전 status.json 만 작성한다
// (report.md 는 수기 X — collect/merge 의 report-gen 이 status.json 에서 결정적 렌더).

const fs = require('fs');
const path = require('path');

const REQUIRED_FIELDS = [
  'task_id',
  'title',
  'allowed_paths',
  'done_criteria',
  'verify_commands',
  // P1.5+ — worktree 격리 필수
  'working_dir',
  'branch_name',
  'base_branch',
];

const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

function validatePayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['payload must be an object'];
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in payload)) errors.push(`missing required field: ${f}`);
  }
  if ('task_id' in payload && !TASK_ID_RE.test(payload.task_id)) {
    errors.push(`task_id format invalid (expected /[A-Z][A-Z0-9]*-\\d+/): ${payload.task_id}`);
  }
  if ('allowed_paths' in payload && !Array.isArray(payload.allowed_paths)) {
    errors.push('allowed_paths must be an array');
  }
  if ('done_criteria' in payload && !Array.isArray(payload.done_criteria)) {
    errors.push('done_criteria must be an array');
  }
  if ('verify_commands' in payload && !Array.isArray(payload.verify_commands)) {
    errors.push('verify_commands must be an array');
  }
  // ADR-055 — yolo_mode:true에서는 forbidden_paths를 명시 deny-all로 채워야 한다.
  // 빈 배열을 허용하면 워커가 "금지 경로 없음"으로 해석해 allowed_paths를 권고로 취급.
  // permission prompt가 없으니 spec drift를 막을 게이트가 사라진다 (cycle 2 4건 실측).
  if ('forbidden_paths' in payload && !Array.isArray(payload.forbidden_paths)) {
    errors.push('forbidden_paths must be an array');
  }
  if (payload.yolo_mode === true) {
    if (!('forbidden_paths' in payload)) {
      errors.push('yolo_mode=true requires forbidden_paths (use ["**/*"] for deny-all or list explicit globs)');
    } else if (Array.isArray(payload.forbidden_paths) && payload.forbidden_paths.length === 0) {
      errors.push('yolo_mode=true with empty forbidden_paths is forbidden (use ["**/*"] for deny-all or list explicit globs)');
    }
  }
  return errors;
}

function listOrEmpty(arr) {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return '(없음)';
  return arr.map(x => `- ${x}`).join('\n');
}

function jsonOrEmpty(value) {
  if (value === undefined || value === null) return '(없음)';
  return JSON.stringify(value, null, 2);
}

function renderPrompt(payload, template) {
  const replacements = {
    task_id: payload.task_id,
    title: payload.title || '',
    allowed_paths: listOrEmpty(payload.allowed_paths),
    forbidden_paths: listOrEmpty(payload.forbidden_paths),
    done_criteria: listOrEmpty(payload.done_criteria),
    verify_commands: listOrEmpty(payload.verify_commands),
    contracts: jsonOrEmpty(payload.contracts),
    // TOK-4: context_refs 는 context.md 의 '## Slices' 가 canonical — prompt.md 에서 재나열 제거.
    context_bundle_path: `.pact/runs/${payload.task_id}/context.md`,
    tdd_mode: payload.tdd ? 'ON (RED → GREEN → REFACTOR 강제)' : 'OFF',
    educational_mode: payload.educational_mode ? 'ON (학습 노트 동시 생성)' : 'OFF',
    prd_reference: payload.prd_reference || '(없음)',
    runs_dir: `.pact/runs/${payload.task_id}`,
    context_budget_tokens: payload.context_budget_tokens ?? 20000,
    // P1.5+ worktree
    working_dir: payload.working_dir || '',
    branch_name: payload.branch_name || '',
    base_branch: payload.base_branch || '',
  };
  let out = template;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

function preparePayloadDir(payload, runsRoot) {
  const dir = path.join(runsRoot, payload.task_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'payload.json'),
    JSON.stringify(payload, null, 2) + '\n',
  );
  return dir;
}

function writePromptFile(dir, prompt) {
  const promptPath = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptPath, prompt);
  return promptPath;
}

function makeTaskPrompt(payload, paths) {
  return [
    `Task ${payload.task_id}: ${payload.title || ''}`,
    '',
    `1. Read ${paths.prompt_path}.`,
    `2. Read ${paths.context_path}.`,
    `3. Work only inside ${payload.working_dir}.`,
    `4. Write final status to ${paths.status_path} (report.md is rendered by pact report-gen — do NOT hand-write it).`,
    '',
    'Do not read full legacy SOT documents unless prompt.md explicitly names a needed section.',
    // TOK-1: caller 반환(최종 메시지)은 1~2줄 구조화 요약만. 서술은 status.json/report.md 에.
    'Then reply with only the one-line summary described in your system prompt (§ 종료 메시지) as your final message — no prose, no code, no file listing.',
  ].join('\n');
}

/**
 * 메인 Claude가 호출. payload → Task tool 호출 준비 결과 반환.
 * @param {object} payload — 워커 명세
 * @param {object} [opts]
 * @param {string} [opts.templatePath] — worker-system.md 경로 (기본: prompts/worker-system.md)
 * @param {string} [opts.runsRoot] — runs 루트 (기본: .pact/runs)
 */
function prepareWorkerSpawn(payload, opts = {}) {
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const templatePath = opts.templatePath
    || path.join(__dirname, '..', 'prompts', 'worker-system.md');
  const runsRoot = opts.runsRoot || '.pact/runs';

  let template;
  try {
    template = fs.readFileSync(templatePath, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`template read failed: ${e.message}`] };
  }

  const prompt = renderPrompt(payload, template);
  const dir = preparePayloadDir(payload, runsRoot);
  const contextPath = path.join(dir, 'context.md');
  const { writeContextBundle } = require('./context-bundle.js');
  // TOK-3(1부): anchor 없이 통째 번들된 대형 shard 경고를 호출자에 플럼빙(추가 필드, 비파괴).
  const bundle = writeContextBundle(payload, contextPath, { cwd: opts.cwd || process.cwd() });
  const promptPath = writePromptFile(dir, prompt);

  const paths = {
    prompt_path: promptPath,
    context_path: contextPath,
    status_path: path.join(dir, 'status.json'),
    report_path: path.join(dir, 'report.md'),
  };

  return {
    ok: true,
    prompt,
    task_prompt: makeTaskPrompt(payload, paths),
    runs_dir: dir,
    payload_path: path.join(dir, 'payload.json'),
    bundle_warnings: bundle.bundle_warnings || [],
    ...paths,
  };
}

module.exports = {
  prepareWorkerSpawn,
  validatePayload,
  renderPrompt,
  makeTaskPrompt,
};

// CLI: node scripts/spawn-worker.js <payload.json>
//      JSON 결과를 stdout. exit 0=ok, 2=invalid payload.
if (require.main === module) {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    console.error('Usage: node spawn-worker.js <payload.json>');
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  } catch (e) {
    console.error(`payload read failed: ${e.message}`);
    process.exit(1);
  }
  const result = prepareWorkerSpawn(payload);
  // CLI stdout는 메인 Claude 컨텍스트에 직접 들어오므로 full prompt를 절대 싣지 않는다.
  const { prompt, ...compactResult } = result;
  process.stdout.write(JSON.stringify(compactResult, null, 2) + '\n');
  process.exit(result.ok ? 0 : 2);
}
