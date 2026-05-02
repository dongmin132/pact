#!/usr/bin/env node
'use strict';

// pact teammate-idle hook (Agent Teams 공식 패턴)
// 트리거: TeammateIdle — 팀 에이전트(워커) 대기/멈춤 감지
// 동작: 메인 Claude에게 알림. 자동 abort 안 함 (사용자 결정).

const fs = require('fs');
const path = require('path');

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();
  // 대기 중인 워커 task_id (payload에 있다면 우선 사용)
  const taskId = payload.task_id
    || payload.subagent_task_id
    || (payload.metadata && payload.metadata.task_id);

  // status.json 미작성 / payload-input.json만 있는 워커 식별
  const runsDir = path.join(cwd, '.pact', 'runs');
  if (!fs.existsSync(runsDir)) process.exit(0);

  const stuck = [];
  for (const d of fs.readdirSync(runsDir)) {
    const full = path.join(runsDir, d);
    if (!fs.statSync(full).isDirectory()) continue;
    const hasInput = fs.existsSync(path.join(full, 'payload-input.json'));
    const hasStatus = fs.existsSync(path.join(full, 'status.json'));
    const hasPayload = fs.existsSync(path.join(full, 'payload.json'));
    // payload는 있고 status는 없으면 워커 작업 중 또는 stuck
    if ((hasInput || hasPayload) && !hasStatus) {
      const m = fs.statSync(hasPayload
        ? path.join(full, 'payload.json')
        : path.join(full, 'payload-input.json')).mtimeMs;
      const elapsedSec = Math.round((Date.now() - m) / 1000);
      stuck.push({ task_id: d, elapsed_sec: elapsedSec });
    }
  }

  if (stuck.length === 0) process.exit(0);

  // 5분 이상 stuck인 워커만 알림
  const longStuck = stuck.filter(s => s.elapsed_sec > 300);
  if (longStuck.length === 0) process.exit(0);

  const summary = longStuck.map(s => `  - ${s.task_id} (${s.elapsed_sec}s)`).join('\n');
  const out = {
    systemMessage:
      `⏸ pact: 워커 ${longStuck.length}개가 5분 이상 대기 중. ` +
      `진행 안 되면 /pact:abort 또는 사용자 개입 필요.\n${summary}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (require.main === module) main();
