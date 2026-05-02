'use strict';

// PACT-032 — Cross-review 어댑터 인터페이스
//
// v1.0 구현체: codex만. v1.1+에서 gemini-cli·cursor-agent 등 추가 가능.
// 모든 어댑터는 다음 두 메서드 제공:
//
//   async check_available() → boolean
//   async call_review(input: ReviewInput) → Finding[]
//
// 어댑터는 registry를 통해 등록·조회됨.

/**
 * @typedef {Object} ReviewInput
 * @property {'plan'|'code'} target
 * @property {string[]} artifacts  - 파일 경로 또는 commit 범위
 * @property {string} context      - 사용자 요구사항·CLAUDE.md 발췌
 * @property {number} [timeout_ms]
 */

/**
 * @typedef {Object} Finding
 * @property {string} file
 * @property {number} [line]
 * @property {'info'|'warn'|'error'} severity
 * @property {string} message      - 한국어
 * @property {number} [confidence] - 0-10 (어댑터가 제공하면)
 */

/**
 * Adapter 인터페이스 (덕 타이핑).
 * @typedef {Object} Adapter
 * @property {string} name
 * @property {() => Promise<boolean>} check_available
 * @property {(input: ReviewInput) => Promise<Finding[]>} call_review
 */

/** Mock 어댑터 — 테스트 / 미설치 환경 fallback */
function createMockAdapter(name = 'mock', findings = []) {
  return {
    name,
    async check_available() { return true; },
    async call_review(_input) { return findings.slice(); },
  };
}

module.exports = { createMockAdapter };
