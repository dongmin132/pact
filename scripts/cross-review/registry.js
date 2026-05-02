'use strict';

// PACT-032 — 어댑터 registry
//
// 어댑터 등록·조회·삭제. 동일 이름 중복 등록 거부.

const _registry = new Map();

function register(name, adapter) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('adapter name required');
  }
  if (!adapter || typeof adapter.check_available !== 'function' || typeof adapter.call_review !== 'function') {
    throw new Error(`adapter ${name} must implement check_available() and call_review()`);
  }
  if (_registry.has(name)) {
    throw new Error(`adapter ${name} already registered`);
  }
  _registry.set(name, adapter);
}

function get(name) {
  return _registry.get(name) || null;
}

function unregister(name) {
  return _registry.delete(name);
}

function listAdapters() {
  return [..._registry.keys()];
}

function clear() {
  _registry.clear();
}

module.exports = { register, get, unregister, listAdapters, clear };
