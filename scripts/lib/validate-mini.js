'use strict';

// Minimal validators — ajv·ajv-formats dep 제거용 (ADR-013).
// 우리 두 schema(worker-status, task) 전용 hand-written.

const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const STATUS_ENUM = new Set(['done', 'failed', 'blocked']);
const VERIFY_ENUM = new Set(['pass', 'fail', 'skip']);
const PRIORITY_ENUM = new Set(['P0', 'P1', 'P2', 'P1.5', 'P2.5', 'P2.6']);
const TASK_STATUS_ENUM = new Set(['todo', 'in_progress', 'done', 'failed', 'blocked']);
const KIND_ENUM = new Set(['complete', 'contract_only']);

function err(path, message, keyword) {
  return { path, message, keyword };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** worker-status.schema 검증 */
function validateStatus(obj) {
  const errors = [];
  if (!isObject(obj)) {
    return { ok: false, errors: [err('/', 'must be object', 'type')] };
  }

  // 필수 필드
  for (const f of ['task_id', 'status', 'files_changed', 'files_attempted_outside_scope',
                   'verify_results', 'tdd_evidence', 'completed_at']) {
    if (!(f in obj)) errors.push(err(`/${f}`, `must have required property '${f}'`, 'required'));
  }

  if ('task_id' in obj && (typeof obj.task_id !== 'string' || !TASK_ID_RE.test(obj.task_id))) {
    errors.push(err('/task_id', `must match pattern ${TASK_ID_RE}`, 'pattern'));
  }
  if ('status' in obj && !STATUS_ENUM.has(obj.status)) {
    errors.push(err('/status', `must be one of: ${[...STATUS_ENUM].join('|')}`, 'enum'));
  }
  if ('branch_name' in obj && obj.branch_name !== null && typeof obj.branch_name !== 'string') {
    errors.push(err('/branch_name', 'must be string or null', 'type'));
  }
  if ('commits_made' in obj && (!Number.isInteger(obj.commits_made) || obj.commits_made < 0)) {
    errors.push(err('/commits_made', 'must be integer ≥ 0', 'type'));
  }
  if ('clean_for_merge' in obj && typeof obj.clean_for_merge !== 'boolean') {
    errors.push(err('/clean_for_merge', 'must be boolean', 'type'));
  }
  if ('files_changed' in obj && !Array.isArray(obj.files_changed)) {
    errors.push(err('/files_changed', 'must be array', 'type'));
  }
  if ('files_attempted_outside_scope' in obj && !Array.isArray(obj.files_attempted_outside_scope)) {
    errors.push(err('/files_attempted_outside_scope', 'must be array', 'type'));
  }
  if ('verify_results' in obj) {
    if (!isObject(obj.verify_results)) {
      errors.push(err('/verify_results', 'must be object', 'type'));
    } else {
      for (const [k, v] of Object.entries(obj.verify_results)) {
        if (!VERIFY_ENUM.has(v)) {
          errors.push(err(`/verify_results/${k}`, `must be one of: ${[...VERIFY_ENUM].join('|')}`, 'enum'));
        }
      }
    }
  }
  if ('tdd_evidence' in obj) {
    if (!isObject(obj.tdd_evidence)) {
      errors.push(err('/tdd_evidence', 'must be object', 'type'));
    } else {
      for (const f of ['red_observed', 'green_observed']) {
        if (!(f in obj.tdd_evidence)) {
          errors.push(err(`/tdd_evidence/${f}`, `must have required property '${f}'`, 'required'));
        } else if (typeof obj.tdd_evidence[f] !== 'boolean') {
          errors.push(err(`/tdd_evidence/${f}`, 'must be boolean', 'type'));
        }
      }
    }
  }
  if ('completed_at' in obj && (typeof obj.completed_at !== 'string' || !ISO_RE.test(obj.completed_at))) {
    errors.push(err('/completed_at', 'must be ISO 8601 date-time', 'format'));
  }
  if ('decisions' in obj) {
    if (!Array.isArray(obj.decisions)) {
      errors.push(err('/decisions', 'must be array', 'type'));
    } else {
      obj.decisions.forEach((d, i) => {
        if (!isObject(d)) {
          errors.push(err(`/decisions/${i}`, 'must be object', 'type'));
          return;
        }
        for (const f of ['topic', 'choice', 'rationale']) {
          if (!(f in d)) errors.push(err(`/decisions/${i}/${f}`, `must have '${f}'`, 'required'));
          else if (typeof d[f] !== 'string') errors.push(err(`/decisions/${i}/${f}`, 'must be string', 'type'));
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** task.schema 검증 (TASKS.md의 한 task) */
function validateTask(obj) {
  const errors = [];
  if (!isObject(obj)) {
    return { ok: false, errors: [err('/', 'must be object', 'type')] };
  }

  // 필수: id, title, priority, dependencies, allowed_paths, done_criteria, tdd
  for (const f of ['id', 'title', 'priority', 'dependencies', 'allowed_paths', 'done_criteria', 'tdd']) {
    if (!(f in obj)) errors.push(err(`/${f}`, `must have required property '${f}'`, 'required'));
  }

  if ('id' in obj && (typeof obj.id !== 'string' || !TASK_ID_RE.test(obj.id))) {
    errors.push(err('/id', `must match ${TASK_ID_RE}`, 'pattern'));
  }
  if ('title' in obj && (typeof obj.title !== 'string' || obj.title.length === 0)) {
    errors.push(err('/title', 'must be non-empty string', 'minLength'));
  }
  if ('priority' in obj && !PRIORITY_ENUM.has(obj.priority)) {
    errors.push(err('/priority', `must be one of: ${[...PRIORITY_ENUM].join('|')}`, 'enum'));
  }
  if ('dependencies' in obj) {
    if (!Array.isArray(obj.dependencies)) {
      errors.push(err('/dependencies', 'must be array', 'type'));
    } else {
      obj.dependencies.forEach((d, i) => {
        if (typeof d === 'string') return;  // string 형식 허용
        if (!isObject(d)) {
          errors.push(err(`/dependencies/${i}`, 'must be string or object', 'type'));
          return;
        }
        if (typeof d.task_id !== 'string') errors.push(err(`/dependencies/${i}/task_id`, 'must be string', 'type'));
        if (!KIND_ENUM.has(d.kind)) errors.push(err(`/dependencies/${i}/kind`, `must be one of: ${[...KIND_ENUM].join('|')}`, 'enum'));
      });
    }
  }
  if ('allowed_paths' in obj) {
    if (!Array.isArray(obj.allowed_paths) || obj.allowed_paths.length === 0) {
      errors.push(err('/allowed_paths', 'must be non-empty array', 'minItems'));
    }
  }
  if ('files' in obj && Array.isArray(obj.files) && obj.files.length > 5) {
    errors.push(err('/files', 'max 5 files per task', 'maxItems'));
  }
  if ('done_criteria' in obj) {
    if (!Array.isArray(obj.done_criteria) || obj.done_criteria.length === 0) {
      errors.push(err('/done_criteria', 'must have ≥1 entry', 'minItems'));
    }
  }
  if ('tdd' in obj && typeof obj.tdd !== 'boolean') {
    errors.push(err('/tdd', 'must be boolean', 'type'));
  }
  if ('status' in obj && obj.status !== undefined && !TASK_STATUS_ENUM.has(obj.status)) {
    errors.push(err('/status', `must be one of: ${[...TASK_STATUS_ENUM].join('|')}`, 'enum'));
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateStatus, validateTask };
