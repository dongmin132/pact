'use strict';

// cost-estimate — abort/timeout 으로 SDK 가 result(total_cost_usd)를 못 남기고 죽은 워커의
// 비용을 assistant 메시지 usage 로 추정하는 순수 모듈. 단가 출처: platform.claude.com 가격표
// (2026-07 확인). cache_read = 0.1×input, cache_creation(5m TTL) = 1.25×input.

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateCostUsd } = require('../scripts/lib/cost-estimate.js');

test('sonnet — input 1M tok = $3', () => {
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000 }, 'sonnet'), 3);
});

test('sonnet — 전체 모델명(claude-sonnet-4-5)도 substring 매칭', () => {
  assert.equal(estimateCostUsd({ output_tokens: 1_000_000 }, 'claude-sonnet-4-5'), 15);
});

test('opus — output 1M tok = $25', () => {
  assert.equal(estimateCostUsd({ output_tokens: 1_000_000 }, 'claude-opus-4-8'), 25);
});

test('haiku — input+output 각 1M = $6', () => {
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'haiku'), 6);
});

test('cache 단가 — read 0.1×input, creation 1.25×input (sonnet)', () => {
  assert.ok(Math.abs(estimateCostUsd({ cache_read_input_tokens: 1_000_000 }, 'sonnet') - 0.3) < 1e-12);
  assert.ok(Math.abs(estimateCostUsd({ cache_creation_input_tokens: 1_000_000 }, 'sonnet') - 3.75) < 1e-12);
});

test('미지 모델 — 보수적으로 opus 단가 적용(예산 cap 과소계상 방지)', () => {
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000 }, 'some-future-model'), 5);
});

test('빈/누락 usage — 0', () => {
  assert.equal(estimateCostUsd({}, 'sonnet'), 0);
  assert.equal(estimateCostUsd(null, 'sonnet'), 0);
});
