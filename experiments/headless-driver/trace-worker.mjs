// 워커 1개 턴별 트레이스 — "13턴이 실제로 뭘 하나" 측정.
// driver.runWorkerReal 과 동일 구성(worker.md 시스템프롬프트·allowedTools·canUseTool·sonnet)으로
// 워커를 띄우되, 매 assistant 메시지(턴)가 호출하는 도구를 그대로 찍는다.
// 사용: cwd = pact 픽스처 프로젝트. node trace-worker.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const PACT_BIN = join(PLUGIN_ROOT, 'bin', 'pact');
const nodeRequire = createRequire(import.meta.url);

const stripFrontmatter = (s) => { const m = /^---\n[\s\S]*?\n---\n/.exec(s); return m ? s.slice(m[0].length) : s; };

// 1) 태스크 1개 prepare
const j = JSON.parse(execSync(`node ${PACT_BIN} run-cycle prepare --max=1`, { encoding: 'utf8' }));
if (!j.task_prompts || !j.task_prompts.length) { console.error('태스크 없음:', JSON.stringify(j).slice(0, 300)); process.exit(1); }
const task = j.task_prompts[0];
const payload = JSON.parse(readFileSync(join(process.cwd(), '.pact/runs', task.task_id, 'payload.json'), 'utf8'));
const allowedPaths = payload.allowed_paths || ['**'];

const systemPrompt = stripFrontmatter(readFileSync(join(PLUGIN_ROOT, 'agents', 'worker.md'), 'utf8'));
const { guardToolUse } = nodeRequire(join(PLUGIN_ROOT, 'scripts', 'lib', 'worker-guard.js'));
const canUseTool = async (toolName, input) => {
  const r = guardToolUse(toolName, input || {}, { workingDir: task.working_dir, allowedPaths });
  return r.allow ? { behavior: 'allow' } : { behavior: 'deny', message: r.reason, interrupt: true };
};

function brief(name, input) {
  input = input || {};
  if (['Read', 'Write', 'Edit'].includes(name)) return basename(input.file_path || input.path || input.notebook_path || '?');
  if (name === 'Bash') return JSON.stringify(String(input.command || '').slice(0, 64));
  if (['Glob', 'Grep'].includes(name)) return input.pattern || '';
  return '';
}

const { query } = await import('@anthropic-ai/claude-agent-sdk');
console.log(`task=${task.task_id}  cwd=${task.working_dir}\n`);

let turn = 0, finalTurns = 0, cost = 0, subtype = '';
const counts = {};
const q = query({
  prompt: task.task_prompt,
  options: {
    model: 'sonnet', cwd: task.working_dir,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    canUseTool, permissionMode: 'default', maxTurns: 200, systemPrompt,
  },
});
for await (const m of q) {
  if (m.type === 'assistant') {
    turn++;
    const blocks = (m.message && m.message.content) || m.content || [];
    const tools = blocks.filter((b) => b.type === 'tool_use').map((b) => { counts[b.name] = (counts[b.name] || 0) + 1; return `${b.name}(${brief(b.name, b.input)})`; });
    const hasText = blocks.some((b) => b.type === 'text' && b.text && b.text.trim());
    console.log(`턴 ${String(turn).padStart(2)}: ${tools.length ? tools.join('  +  ') : (hasText ? '(텍스트/생각만)' : '(빈)')}`);
  }
  if (m.type === 'result') { finalTurns = m.num_turns || turn; cost = m.total_cost_usd || 0; subtype = m.subtype; }
}
console.log(`\n=== assistant 턴 ${turn}개 (SDK num_turns=${finalTurns}) · $${cost.toFixed(4)} · ${subtype} ===`);
console.log('도구 호출 합계:', JSON.stringify(counts));
