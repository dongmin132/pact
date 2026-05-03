'use strict';

// PACT-006 — TASKS.md 파서
//
// 입력: TASKS.md 마크다운 텍스트
// 출력: { tasks, tbdMarkers, frontmatter, errors }
//
// 설계 원칙:
// 1. task heading은 `## <PREFIX>-<NUM>  <title>` 패턴 (예: ## PACT-042  로그인 API)
//    소문자 prefix(`## Task 작성 가이드`)는 task로 인식 안 함 — 가이드 섹션 무시
// 2. 각 task heading 다음 첫 번째 ```yaml 블록만 task 정의로 취급
// 3. TBD 마커는 yaml 값 어디든 'TBD' 문자열이 박혀있으면 검출
// 4. 잘못된 yaml은 errors 배열에 기록, tasks에는 누락

const fs = require('fs');
const yaml = require('./lib/yaml-mini.js');

const TASK_HEADING_RE = /^## ([A-Z][A-Z0-9]*-\d+)\s+(.+)$/gm;
const FRONTMATTER_HEADING_RE = /^## frontmatter\s*$/m;
const YAML_BLOCK_RE = /```yaml\s*\n([\s\S]*?)\n```/;

/** ## frontmatter 섹션 yaml 블록 추출 */
function parseFrontmatter(markdown) {
  const headingMatch = FRONTMATTER_HEADING_RE.exec(markdown);
  if (!headingMatch) return {};

  const startIdx = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(startIdx);
  const nextHeadingRel = rest.search(/^##\s/m);
  const section = nextHeadingRel >= 0 ? rest.slice(0, nextHeadingRel) : rest;

  const yamlMatch = YAML_BLOCK_RE.exec(section);
  if (!yamlMatch) return {};

  try {
    return yaml.load(yamlMatch[1]) || {};
  } catch {
    return {};
  }
}

/** 재귀적으로 'TBD' 문자열 위치를 dotted path로 수집 */
function findTbds(value, prefix = '') {
  const out = [];
  if (value === 'TBD') {
    out.push(prefix);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      out.push(...findTbds(item, p));
    });
    return out;
  }

  for (const [key, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    out.push(...findTbds(v, p));
  }
  return out;
}

/**
 * TASKS.md 파싱.
 * @param {string} markdown
 * @returns {{tasks: Array, tbdMarkers: Array, frontmatter: object, errors: Array}}
 */
function parseTasks(markdown) {
  const tasks = [];
  const tbdMarkers = [];
  const errors = [];
  const frontmatter = parseFrontmatter(markdown);

  if (!markdown) return { tasks, tbdMarkers, frontmatter, errors };

  const matches = [...markdown.matchAll(TASK_HEADING_RE)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const taskId = match[1];
    const title = match[2].trim();
    const startIdx = match.index;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    const section = markdown.slice(startIdx, endIdx);

    const yamlMatch = YAML_BLOCK_RE.exec(section);
    if (!yamlMatch) {
      errors.push({ taskId, error: 'no yaml block found in task section' });
      continue;
    }

    let parsed;
    try {
      parsed = yaml.load(yamlMatch[1]);
    } catch (e) {
      errors.push({ taskId, error: `yaml parse error: ${e.message}` });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({ taskId, error: 'yaml block did not parse to an object' });
      continue;
    }

    const tbdFields = findTbds(parsed);
    if (tbdFields.length > 0) {
      tbdMarkers.push({ taskId, fields: tbdFields });
    }

    tasks.push({
      id: taskId,
      title,
      ...parsed,
      status: 'todo',
      retry_count: 0,
    });
  }

  return { tasks, tbdMarkers, frontmatter, errors };
}

/** task 검증 (hand-written, dep-free). */
function validateTasksAgainstSchema(tasks) {
  const { validateTask } = require('./lib/validate-mini.js');
  const errors = [];
  for (const t of tasks) {
    const v = validateTask(t);
    if (!v.ok) {
      for (const e of v.errors) {
        errors.push({
          task_id: t.id,
          path: e.path,
          message: e.message,
          keyword: e.keyword,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  parseTasks,
  findTbds,
  parseFrontmatter,
  validateTasksAgainstSchema,
};

// CLI: node scripts/parse-tasks.js <TASKS.md path>
//      JSON 결과를 stdout에 쓴다. 파일 없으면 exit 2.
if (require.main === module) {
  const filepath = process.argv[2];
  if (!filepath) {
    console.error('Usage: node parse-tasks.js <TASKS.md>');
    process.exit(1);
  }
  let md;
  try {
    md = fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    console.error(`read failed: ${e.message}`);
    process.exit(2);
  }
  const result = parseTasks(md);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.errors.length > 0 ? 3 : 0);
}
