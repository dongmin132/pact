// 동시성 측정 하네스 — "구독에서 병렬 query 가 진짜 동시 실행되나, rate limit 에 직렬화되나?"
// pact task/worktree/머지 노이즈 제거: 도구 없는 순수 생성 query 를 같은 K개 직렬 vs 동시로 돌려 벽시계 비교.
//   speedup = T_seq / T_con  → K 에 가까우면 진짜 병렬, 1.0 이면 완전 직렬화.
//   tokens/min 도 비교 → 동시일 때도 throughput 천장이 같으면 rate cap 증거.
//
// 사용: node measure-concurrency.mjs [--k=3] [--model=sonnet] [--words=700]
// 주의: 구독 토큰 소모(소량). ANTHROPIC_API_KEY 없으면 5시간 한도에서 차감.

import { query } from '@anthropic-ai/claude-agent-sdk';

const arg = (n, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const K = parseInt(arg('k', '3'), 10);
const MODEL = arg('model', 'sonnet');
const WORDS = parseInt(arg('words', '700'), 10);

const PROMPT =
  `Write approximately ${WORDS} words of original encyclopedic prose about the cultural ` +
  `and economic history of tea across China, Japan, Britain, and India. ` +
  `Do NOT use any tools. Output the prose directly, no preamble.`;

const ms = () => Number(process.hrtime.bigint() / 1000000n);

async function runOne(label) {
  const t0 = ms();
  let out = 0;
  let cost = 0;
  let err = null;
  try {
    const q = query({ prompt: PROMPT, options: { model: MODEL, maxTurns: 1, allowedTools: [] } });
    for await (const m of q) {
      if (m.type === 'result') {
        out = (m.usage && m.usage.output_tokens) || 0;
        cost = m.total_cost_usd || 0;
      }
    }
  } catch (e) {
    err = String((e && e.message) || e);
  }
  return { label, ms: ms() - t0, out, cost, err };
}

function summarize(tag, items, wall) {
  const okItems = items.filter((x) => !x.err);
  const tok = okItems.reduce((s, x) => s + x.out, 0);
  const cost = items.reduce((s, x) => s + x.cost, 0);
  const errs = items.filter((x) => x.err);
  console.log(`\n[${tag}] wall=${(wall / 1000).toFixed(1)}s  out_tokens=${tok}  cost=$${cost.toFixed(4)}  tok/min=${tok ? Math.round((tok / wall) * 60000) : 0}`);
  items.forEach((x) =>
    console.log(`   ${x.label}: ${(x.ms / 1000).toFixed(1)}s  out=${x.out}${x.err ? `  ERROR=${x.err}` : ''}`));
  if (errs.length) console.log(`   ⚠️ ${errs.length}/${items.length} 실패(rate limit?)`);
  return { wall, tok };
}

(async () => {
  console.log(`동시성 측정: K=${K}, model=${MODEL}, ~${WORDS}단어/쿼리, auth=${process.env.ANTHROPIC_API_KEY ? 'API' : '구독'}`);

  console.log('\n워밍업(서브프로세스 spawn 오버헤드, 미집계)...');
  const warm = await runOne('warmup');
  console.log(`   warmup: ${(warm.ms / 1000).toFixed(1)}s${warm.err ? `  ERROR=${warm.err}` : ''}`);

  // 직렬: K개를 순차 await
  const seqItems = [];
  const s0 = ms();
  for (let i = 0; i < K; i++) seqItems.push(await runOne(`seq${i}`));
  const seq = summarize('직렬 SEQ', seqItems, ms() - s0);

  // 동시: 같은 K개를 Promise.all
  const c0 = ms();
  const conItems = await Promise.all(Array.from({ length: K }, (_, i) => runOne(`con${i}`)));
  const con = summarize('동시 CON', conItems, ms() - c0);

  const speedup = seq.wall / con.wall;
  console.log('\n────────── 판정 ──────────');
  console.log(`speedup = T_seq/T_con = ${speedup.toFixed(2)}x   (이상적 ${K}.0 = 진짜 병렬, 1.0 = 완전 직렬화)`);
  console.log(`throughput: 직렬 ${Math.round((seq.tok / seq.wall) * 60000)} tok/min  vs  동시 ${Math.round((con.tok / con.wall) * 60000)} tok/min`);
  const verdict =
    speedup >= K * 0.8 ? '✅ 진짜 병렬 — rate 여유 있음 (parallel 이 벽시계 이득)' :
    speedup <= 1.3 ? '❌ 완전 직렬화 — 구독 rate limit이 동시 실행을 막음 (parallel 무의미한 벽시계)' :
    '⚠️ 부분 병렬 — rate를 나눠 씀 (이득 제한적)';
  console.log(verdict);
})();
