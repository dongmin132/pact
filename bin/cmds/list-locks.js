'use strict';

// pact list-locks — 현재 잡혀있는 모든 lock 목록.
// --session <label>  : 특정 session_label 잡은 것만
// --mine             : 내 session (resolveSessionLabel 자동)
// --alive            : 살아있는 PID만 (stale 제외)
// --json             : JSON 출력 (자동화용)
//
// /pact:parallel 슬래시 명령이 "내가 잡은 task만 spawn"하기 위해 사용.

const { listLocks } = require('../../scripts/lock.js');
const { resolveSessionLabel } = require('./claim.js');

function parseArgs(args) {
  let session = null;
  let mine = false;
  let aliveOnly = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session' || a === '--label') session = args[++i];
    else if (a === '--mine') mine = true;
    else if (a === '--alive') aliveOnly = true;
    else if (a === '--json') json = true;
  }
  return { session, mine, aliveOnly, json };
}

module.exports = function listLocksCli(args) {
  const { session: explicit, mine, aliveOnly, json } = parseArgs(args);
  const cwd = process.cwd();

  const session = mine ? resolveSessionLabel() : explicit;

  let locks = listLocks({ cwd });
  if (aliveOnly) locks = locks.filter(l => l.alive);
  if (session) locks = locks.filter(l => l.session_label === session);

  if (json) {
    process.stdout.write(JSON.stringify({
      session_label: session || null,
      task_ids: locks.map(l => l.task_id),
      locks,
    }, null, 2) + '\n');
    return;
  }

  if (locks.length === 0) {
    if (session) console.log(`잡은 lock 없음 (session=${session})`);
    else console.log('잡힌 lock 없음');
    return;
  }

  for (const l of locks) {
    const aliveTag = l.alive ? '🟢' : '🔴 stale';
    const sessTag = l.session_label ? ` [${l.session_label}]` : '';
    console.log(`${aliveTag} ${l.task_id} pid=${l.pid}${sessTag} acquired=${l.acquired_at}`);
  }
};
