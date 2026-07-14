'use strict';

// cost-estimate — usage 토큰 → USD 추정 (순수 함수, 의존성 0).
//
// 왜 필요한가: SDK(0.3.178 실측)는 abort/timeout 으로 스트림이 끊기면 result 메시지
// (total_cost_usd)를 남기지 않고 throw 한다. 그 경로에서 워커 비용이 $0 으로 ledger 에
// 기록되면 budget cap 이 실지출을 과소계상해 잠재 지출이 상한을 넘을 수 있다.
// assistant 메시지마다 실려 오는 message.usage 를 누적해 두면 여기서 비용을 추정한다.
//
// 단가: platform.claude.com 가격표 (2026-07 확인, USD per 1M tokens).
// cache_read = 0.1×input, cache_creation(5분 TTL) = 1.25×input.
// 미지 모델은 opus 단가(최고가)로 보수 추정 — cap 불변식은 과소계상만이 위험하다.
const PRICES_PER_MTOK = [
  { match: 'haiku', input: 1, output: 5 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'opus', input: 5, output: 25 },
];
const FALLBACK = { input: 5, output: 25 }; // opus 단가

function rateFor(model) {
  const m = String(model || '').toLowerCase();
  const hit = PRICES_PER_MTOK.find((p) => m.includes(p.match));
  return hit || FALLBACK;
}

/**
 * usage 토큰 합계로 비용(USD)을 추정한다.
 * @param {{input_tokens?:number, output_tokens?:number, cache_read_input_tokens?:number, cache_creation_input_tokens?:number}|null} usage
 * @param {string} model  'sonnet' | 'claude-opus-4-8' 등 — substring 매칭
 * @returns {number}
 */
function estimateCostUsd(usage, model) {
  if (!usage) return 0;
  const r = rateFor(model);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const crTok = usage.cache_read_input_tokens || 0;
  const ccTok = usage.cache_creation_input_tokens || 0;
  return (inTok * r.input + outTok * r.output + crTok * r.input * 0.1 + ccTok * r.input * 1.25) / 1e6;
}

module.exports = { estimateCostUsd };
