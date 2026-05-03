'use strict';

// pact split-docs — legacy long SOT docs into context-light shards.
//
// Safety:
// - Never deletes or rewrites legacy files by default.
// - Existing shard files are not overwritten unless --force is passed.
// - Domain inference is conservative and deterministic.

const fs = require('fs');
const path = require('path');

function parseArgs(args) {
  return {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  };
}

function slugify(s) {
  const raw = String(s || '').toLowerCase();
  const cleaned = raw
    .replace(/\/api\//g, '/')
    .replace(/[^a-z0-9가-힣/_-]+/g, '-')
    .replace(/^[-_/]+|[-_/]+$/g, '');
  return cleaned.split(/[\/_-]+/).filter(Boolean)[0] || 'misc';
}

function domainFromTask(task) {
  const paths = [
    ...(Array.isArray(task.allowed_paths) ? task.allowed_paths : []),
    ...(Array.isArray(task.files) ? task.files : []),
  ];
  for (const p of paths) {
    const m = String(p).match(/(?:src|app|pages|components|lib|services|features|modules)\/([^/*]+)/);
    if (m) return slugify(m[1]);
  }
  if (task.contracts && Array.isArray(task.contracts.api_endpoints) && task.contracts.api_endpoints.length > 0) {
    return domainFromEndpoint(String(task.contracts.api_endpoints[0]));
  }
  if (task.contracts && Array.isArray(task.contracts.db_tables) && task.contracts.db_tables.length > 0) {
    return domainFromTable(String(task.contracts.db_tables[0]));
  }
  return slugify(task.id && task.id.split('-')[0]);
}

function domainFromEndpoint(endpoint) {
  const pathPart = endpoint.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '');
  const parts = pathPart.split('/').filter(Boolean).filter(p => p !== 'api' && !p.startsWith(':') && !p.startsWith('['));
  return slugify(parts[0] || 'api');
}

function domainFromTable(table) {
  const base = String(table).replace(/_?(id|ids)$/i, '').replace(/s$/i, '');
  return slugify(base);
}

function extractSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const m = /^(#{2,3})\s+(.+)$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { level: m[1].length, title: m[2].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function domainFromApiSection(section) {
  const title = section.title;
  const endpointMatch = title.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
  if (endpointMatch) return domainFromEndpoint(`${endpointMatch[1]} ${endpointMatch[2]}`);
  const body = section.lines.join('\n');
  const pathMatch = body.match(/^\s*path:\s*(\S+)/m);
  if (pathMatch) return domainFromEndpoint(pathMatch[1]);
  return slugify(title);
}

function domainFromDbSection(section) {
  const body = section.lines.join('\n');
  const tableMatch = body.match(/^\s*table:\s*([A-Za-z0-9_]+)/m);
  if (tableMatch) return domainFromTable(tableMatch[1]);
  return domainFromTable(section.title.replace(/\s*테이블\s*$/i, ''));
}

function domainFromModuleSection(section) {
  const body = section.lines.join('\n');
  const moduleMatch = body.match(/^\s*module:\s*([A-Za-z0-9가-힣_-]+)/m);
  if (moduleMatch) return slugify(moduleMatch[1]);
  // owner_paths의 첫 path에서 도메인 추정
  const ownerMatch = body.match(/^\s*-\s*([^\n]+)/m);
  if (ownerMatch) {
    const m = ownerMatch[1].match(/(?:src|app|pages|components|lib|services|features|modules)\/([^/*"\s]+)/);
    if (m) return slugify(m[1]);
  }
  return slugify(section.title);
}

function writeFileSafe(file, content, opts, written) {
  if (opts.dryRun) {
    written.push({ file, skipped: false, dry_run: true });
    return;
  }
  if (fs.existsSync(file) && !opts.force) {
    written.push({ file, skipped: true, reason: 'exists' });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  written.push({ file, skipped: false });
}

function inferContextRefs(task) {
  const refs = new Set();
  const endpoints = (task.contracts && Array.isArray(task.contracts.api_endpoints)) ? task.contracts.api_endpoints : [];
  for (const ep of endpoints) {
    if (typeof ep !== 'string' || ep === 'TBD') continue;
    refs.add(`contracts/api/${domainFromEndpoint(ep)}.md`);
  }
  const tables = (task.contracts && Array.isArray(task.contracts.db_tables)) ? task.contracts.db_tables : [];
  for (const t of tables) {
    if (typeof t !== 'string' || t === 'TBD') continue;
    refs.add(`contracts/db/${domainFromTable(t)}.md`);
  }
  // ownership shard도 task 자기 domain 기준 추가
  const ownDomain = domainFromTask(task);
  if (ownDomain && ownDomain !== 'misc') refs.add(`contracts/modules/${ownDomain}.md`);
  return Array.from(refs);
}

function injectContextRefs(sectionText, refs) {
  if (refs.length === 0) return sectionText;
  // task의 yaml 블록 찾기. 이미 context_refs가 있으면 손대지 않음.
  const yamlBlockRe = /(```yaml\n)([\s\S]*?)(\n```)/;
  const m = yamlBlockRe.exec(sectionText);
  if (!m) return sectionText;
  if (/^context_refs\s*:/m.test(m[2])) return sectionText;
  const lines = ['context_refs:', ...refs.map(r => `  - ${r}`)];
  const newYaml = m[2].replace(/\n*$/, '') + '\n' + lines.join('\n');
  return sectionText.replace(yamlBlockRe, `$1${newYaml}$3`);
}

function groupTasksByDomain() {
  const { parseTasks } = require(path.join(__dirname, '..', '..', 'scripts', 'parse-tasks.js'));
  if (!fs.existsSync('TASKS.md')) return { groups: new Map(), count: 0 };
  const md = fs.readFileSync('TASKS.md', 'utf8');
  const parsed = parseTasks(md);
  const sections = extractSections(md);
  const sectionById = new Map();
  for (const s of sections) {
    const m = /^([A-Z][A-Z0-9]*-\d+)\s+/.exec(s.title);
    if (m) sectionById.set(m[1], s.lines.join('\n').trim() + '\n');
  }

  const groups = new Map();
  for (const task of parsed.tasks) {
    const domain = domainFromTask(task);
    if (!groups.has(domain)) groups.set(domain, []);
    const baseSection = sectionById.get(task.id) || `## ${task.id}  ${task.title}\n\n`;
    const refs = inferContextRefs(task);
    const enriched = injectContextRefs(baseSection, refs);
    groups.get(domain).push(enriched);
  }
  return { groups, count: parsed.tasks.length };
}

function groupContractSections(file, kind) {
  if (!fs.existsSync(file)) return { groups: new Map(), count: 0 };
  const md = fs.readFileSync(file, 'utf8');
  const sections = extractSections(md)
    .filter(s => !/사용 가이드|예시|\(예시\)/.test(s.title));
  const groups = new Map();
  for (const s of sections) {
    let domain;
    if (kind === 'api') domain = domainFromApiSection(s);
    else if (kind === 'db') domain = domainFromDbSection(s);
    else if (kind === 'modules') domain = domainFromModuleSection(s);
    else domain = slugify(s.title);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(s.lines.join('\n').trim() + '\n');
  }
  return { groups, count: sections.length };
}

function renderTaskShard(domain, sections) {
  return [
    `# Tasks — ${domain}`,
    '',
    '> Generated by `pact split-docs` from legacy TASKS.md.',
    '',
    ...sections,
  ].join('\n').trimEnd() + '\n';
}

function renderContractShard(kind, domain, sections) {
  const legacyName = kind === 'api' ? 'API_CONTRACT.md' : kind === 'db' ? 'DB_CONTRACT.md' : 'MODULE_OWNERSHIP.md';
  const heading = kind === 'modules' ? `Modules — ${domain}` : `${kind.toUpperCase()} Contract — ${domain}`;
  return [
    `# ${heading}`,
    '',
    `> Generated by \`pact split-docs\` from legacy ${legacyName}.`,
    '',
    ...sections,
  ].join('\n').trimEnd() + '\n';
}

function renderManifest(apiDomains, dbDomains, moduleDomains) {
  const out = ['# Contracts Manifest', '', '> Generated by `pact split-docs`.', '', '## API', '', '| Domain | File |', '|---|---|'];
  for (const d of apiDomains.sort()) out.push(`| ${d} | \`contracts/api/${d}.md\` |`);
  out.push('', '## DB', '', '| Domain | File |', '|---|---|');
  for (const d of dbDomains.sort()) out.push(`| ${d} | \`contracts/db/${d}.md\` |`);
  out.push('', '## Modules', '', '| Domain | File |', '|---|---|');
  for (const d of (moduleDomains || []).sort()) out.push(`| ${d} | \`contracts/modules/${d}.md\` |`);
  return out.join('\n') + '\n';
}

function renderContextMap(taskDomains, apiDomains, dbDomains, moduleDomains) {
  const mods = moduleDomains || [];
  const domains = Array.from(new Set([...taskDomains, ...apiDomains, ...dbDomains, ...mods])).sort();
  const out = [
    '# Context Map',
    '',
    '> Generated by `pact split-docs`. Keep this file small; it is the read profile index.',
    '',
    '## Domains',
    '',
    '<!-- pact:context-map:domains:start -->',
    '| Domain | Tasks | API | DB | Modules |',
    '|---|---|---|---|---|',
  ];
  for (const d of domains) {
    out.push([
      `| ${d}`,
      taskDomains.includes(d) ? `\`tasks/${d}.md\`` : '',
      apiDomains.includes(d) ? `\`contracts/api/${d}.md\`` : '',
      dbDomains.includes(d) ? `\`contracts/db/${d}.md\`` : '',
      mods.includes(d) ? `\`contracts/modules/${d}.md\` |` : ' |',
    ].join(' | '));
  }
  out.push('<!-- pact:context-map:domains:end -->');
  out.push('', '## Read Profile', '', '- Use `pact slice --headers` before reading task details.', '- Use `pact slice --ids <ids>` for selected tasks.', '- Follow task `context_refs` to contract shards.', '- Run `pact context-map sync` after adding a new domain.', '- Do not read legacy long SOT files unless migrating.');
  return out.join('\n') + '\n';
}

module.exports = function splitDocs(args) {
  const opts = parseArgs(args);
  const written = [];

  const task = groupTasksByDomain();
  const api = groupContractSections('API_CONTRACT.md', 'api');
  const db = groupContractSections('DB_CONTRACT.md', 'db');
  const modules = groupContractSections('MODULE_OWNERSHIP.md', 'modules');

  for (const [domain, sections] of task.groups) {
    writeFileSafe(path.join('tasks', `${domain}.md`), renderTaskShard(domain, sections), opts, written);
  }
  for (const [domain, sections] of api.groups) {
    writeFileSafe(path.join('contracts/api', `${domain}.md`), renderContractShard('api', domain, sections), opts, written);
  }
  for (const [domain, sections] of db.groups) {
    writeFileSafe(path.join('contracts/db', `${domain}.md`), renderContractShard('db', domain, sections), opts, written);
  }
  for (const [domain, sections] of modules.groups) {
    writeFileSafe(path.join('contracts/modules', `${domain}.md`), renderContractShard('modules', domain, sections), opts, written);
  }

  const taskDomains = Array.from(task.groups.keys());
  const apiDomains = Array.from(api.groups.keys());
  const dbDomains = Array.from(db.groups.keys());
  const moduleDomains = Array.from(modules.groups.keys());
  if (apiDomains.length > 0 || dbDomains.length > 0 || moduleDomains.length > 0) {
    writeFileSafe(path.join('contracts', 'manifest.md'), renderManifest(apiDomains, dbDomains, moduleDomains), opts, written);
  }
  if (taskDomains.length > 0 || apiDomains.length > 0 || dbDomains.length > 0 || moduleDomains.length > 0) {
    writeFileSafe(path.join('docs', 'context-map.md'), renderContextMap(taskDomains, apiDomains, dbDomains, moduleDomains), opts, written);
  }

  const summary = {
    tasks: task.count,
    api_sections: api.count,
    db_sections: db.count,
    module_sections: modules.count,
    written: written.filter(w => !w.skipped).length,
    skipped: written.filter(w => w.skipped).length,
  };

  console.log(`✓ split-docs`);
  console.log(`  tasks: ${summary.tasks}`);
  console.log(`  api sections: ${summary.api_sections}`);
  console.log(`  db sections: ${summary.db_sections}`);
  console.log(`  module sections: ${summary.module_sections}`);
  console.log(`  written: ${summary.written}, skipped: ${summary.skipped}`);
  for (const w of written) {
    console.log(`  ${w.skipped ? 'skip' : 'write'} ${w.file}${w.reason ? ` (${w.reason})` : ''}`);
  }
};
