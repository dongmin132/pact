#!/usr/bin/env node
'use strict';

// pact subagent-stop-review hook
// 트리거: SubagentStop — 서브에이전트 종료 시
// 동작: 워커였으면 status.json 검증. 누락·이상 시 경고.

const fs = require('fs');
const path = require('path');

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  // 서브에이전트 타입 확인 — worker만 처리
  const subagentType = payload.subagent_type || (payload.metadata && payload.metadata.subagent_type);
  if (subagentType !== 'worker') process.exit(0);

  const cwd = payload.cwd || process.cwd();

  // .pact/runs/ 안에서 가장 최근 status.json 찾기
  const runsDir = path.join(cwd, '.pact', 'runs');
  if (!fs.existsSync(runsDir)) process.exit(0);

  const taskDirs = fs.readdirSync(runsDir).filter(d => {
    const full = path.join(runsDir, d);
    return fs.statSync(full).isDirectory();
  });

  // mtime 가장 최근 디렉토리
  let latest = null;
  let latestMtime = 0;
  for (const d of taskDirs) {
    const full = path.join(runsDir, d);
    const m = fs.statSync(full).mtimeMs;
    if (m > latestMtime) {
      latest = full;
      latestMtime = m;
    }
  }
  if (!latest) process.exit(0);

  const statusPath = path.join(latest, 'status.json');
  const taskId = path.basename(latest);

  if (!fs.existsSync(statusPath)) {
    const out = {
      systemMessage: `⚠️ pact: 워커 ${taskId}가 status.json 없이 종료됨. blocked 처리 권장.`,
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch (e) {
    const out = {
      systemMessage: `⚠️ pact: ${taskId}/status.json 파싱 실패: ${e.message}`,
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  // Schema 검증 (validate-status.js 위임 — 중복 방지)
  let schemaErrors = [];
  try {
    const { validateStatus } = require(path.join(__dirname, '..', 'scripts', 'validate-status.js'));
    const v = validateStatus(status);
    if (!v.ok) schemaErrors = v.errors.map(e => `${e.path}: ${e.message}`);
  } catch { /* validator 없으면 패스 */ }

  // 의심 사항 체크 (schema 외 의미 검증)
  const warnings = [];
  if (schemaErrors.length > 0) {
    warnings.push(`status.json schema 위반:\n    ${schemaErrors.join('\n    ')}`);
  }
  if (status.files_attempted_outside_scope && status.files_attempted_outside_scope.length > 0) {
    warnings.push(`권한 외 파일 수정 시도: ${status.files_attempted_outside_scope.join(', ')}`);
  }
  if (status.status === 'done' && status.tdd_evidence && status.tdd_evidence.red_observed === false) {
    warnings.push('TDD ON인데 red_observed=false (RED 단계 누락 의심)');
  }
  if (status.commits_made === 0 && status.status === 'done') {
    warnings.push('commits_made=0인데 status=done (빈 작업 의심)');
  }

  if (warnings.length === 0) process.exit(0);

  const out = {
    systemMessage: `⚠️ pact: 워커 ${taskId} 의심 사항:\n  - ${warnings.join('\n  - ')}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main();
