// 최소 pact 프로젝트 픽스처 — pact 래퍼 오버헤드 측정용 (trivial task 3개).
// e2e 테스트의 init/plan 시뮬과 동일 포맷. 워커는 "한 줄 파일 생성"만 하지만
// pact 스캐폴딩(prompt/context read·verify·status.json·report.md 10줄·commit·validate)을 전부 거침.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.argv[2];
if (!dir) { console.error('usage: node fixture-setup.mjs <dir>'); process.exit(1); }
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'ignore', shell: '/bin/bash' });

fs.mkdirSync(dir, { recursive: true });
sh('git init -b main', dir);
sh('git config user.email t@t.t && git config user.name t', dir);
fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');

for (const f of ['CLAUDE.md', 'PROGRESS.md', 'DECISIONS.md']) {
  fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
}
fs.mkdirSync(path.join(dir, '.pact/runs'), { recursive: true });
fs.mkdirSync(path.join(dir, '.pact/worktrees'), { recursive: true });
fs.writeFileSync(path.join(dir, '.pact/.gitignore'), '*\n!.gitignore\n');
fs.writeFileSync(path.join(dir, '.pact/state.json'),
  JSON.stringify({ version: 1, current_cycle: 0, active_workers: [] }, null, 2));

const tasks = [
  { id: 'PROJ-001', title: 'create a', file: 'src/a.ts', val: 'a' },
  { id: 'PROJ-002', title: 'create b', file: 'src/b.ts', val: 'b' },
  { id: 'PROJ-003', title: 'create c', file: 'src/c.ts', val: 'c' },
];
const md = ['# TASKS\n', '## frontmatter\n', '```yaml', 'educational_mode: false', '```\n', '---\n'];
for (const t of tasks) {
  md.push(`## ${t.id}  ${t.title}\n`);
  md.push('```yaml');
  md.push('priority: P0');
  md.push('dependencies: []');
  md.push(`allowed_paths: ${JSON.stringify([t.file])}`);
  md.push(`files: ${JSON.stringify([t.file])}`);
  md.push(`work: [create ${t.file} with exactly: export const ${t.val} = 1;]`);
  md.push(`done_criteria: [${t.file} exists exporting const ${t.val}]`);
  md.push('verify_commands: []');
  md.push('tdd: false');
  md.push('```\n');
}
fs.writeFileSync(path.join(dir, 'TASKS.md'), md.join('\n'));

sh('git add -A && git commit -m init', dir);
console.log(dir);
