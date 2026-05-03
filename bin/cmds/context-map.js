'use strict';

// pact context-map sync — docs/context-map.md의 Domains 표를 현재 shard 디렉토리 상태에 맞춰 재생성.
//
// 안전 정책:
// - Domains 표 블록만 교체. 나머지 prose는 그대로.
// - context-map.md가 없으면 templates/context-map.md를 시드로 복사.

const fs = require('fs');
const path = require('path');

function listShards(dir) {
  const full = path.join(process.cwd(), dir);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return [];
  return fs.readdirSync(full)
    .filter(f => f.endsWith('.md') && f !== 'manifest.md')
    .map(f => f.replace(/\.md$/, ''))
    .sort();
}

function buildDomainsTable() {
  const taskDomains = listShards('tasks');
  const apiDomains = listShards('contracts/api');
  const dbDomains = listShards('contracts/db');
  const moduleDomains = listShards('contracts/modules');

  const all = Array.from(new Set([
    ...taskDomains, ...apiDomains, ...dbDomains, ...moduleDomains,
  ])).sort();

  const lines = [
    '## Domains',
    '',
    '<!-- pact:context-map:domains:start -->',
    '| Domain | Tasks | API | DB | Modules |',
    '|---|---|---|---|---|',
  ];
  for (const d of all) {
    lines.push([
      `| ${d}`,
      taskDomains.includes(d) ? `\`tasks/${d}.md\`` : '',
      apiDomains.includes(d) ? `\`contracts/api/${d}.md\`` : '',
      dbDomains.includes(d) ? `\`contracts/db/${d}.md\`` : '',
      moduleDomains.includes(d) ? `\`contracts/modules/${d}.md\` |` : ' |',
    ].join(' | '));
  }
  if (all.length === 0) lines.push('| (없음) |  |  |  |  |');
  lines.push('<!-- pact:context-map:domains:end -->');
  return { block: lines.join('\n'), count: all.length };
}

function replaceDomainsBlock(text, newBlock) {
  // 동작: "## Domains" 섹션을 newBlock으로 교체. 마커 유무 상관없음.
  // idempotent: 동일 입력에 두 번 실행해도 출력 동일.
  const startMarker = '<!-- pact:context-map:domains:start -->';
  const endMarker = '<!-- pact:context-map:domains:end -->';
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);

  let cutFrom;
  let cutTo;

  if (startIdx >= 0 && endIdx > startIdx) {
    // 마커 둘 다 있으면 ## Domains 헤더(있다면)부터 endMarker까지 교체
    const beforeMarker = text.lastIndexOf('## Domains', startIdx);
    cutFrom = beforeMarker >= 0 ? beforeMarker : startIdx;
    cutTo = endIdx + endMarker.length;
  } else {
    const headerIdx = text.indexOf('## Domains');
    if (headerIdx >= 0) {
      cutFrom = headerIdx;
      const after = text.slice(headerIdx);
      const nextHeaderRel = after.search(/\n##\s+(?!Domains)/);
      cutTo = nextHeaderRel >= 0 ? headerIdx + nextHeaderRel : text.length;
    } else {
      // ## Domains 없음 → 끝에 추가
      return text.trimEnd() + '\n\n' + newBlock + '\n';
    }
  }

  const before = text.slice(0, cutFrom).trimEnd();
  const tail = text.slice(cutTo).replace(/^\n+/, '');
  if (tail.length === 0) {
    return before + '\n\n' + newBlock + '\n';
  }
  return before + '\n\n' + newBlock + '\n\n' + tail;
}

function ensureSeed() {
  const target = 'docs/context-map.md';
  if (fs.existsSync(target)) return target;
  fs.mkdirSync('docs', { recursive: true });
  const seed = path.join(__dirname, '..', '..', 'templates', 'context-map.md');
  if (fs.existsSync(seed)) {
    fs.writeFileSync(target, fs.readFileSync(seed, 'utf8'));
  } else {
    fs.writeFileSync(target, '# Context Map\n\n## Domains\n\n');
  }
  return target;
}

function syncCommand(args) {
  const dryRun = args.includes('--dry-run');
  const target = ensureSeed();
  const before = fs.readFileSync(target, 'utf8');
  const { block, count } = buildDomainsTable();
  const after = replaceDomainsBlock(before, block);

  if (dryRun) {
    console.log(`(dry-run) ${target} domains=${count}`);
    if (before === after) console.log('  변경 없음');
    else console.log('  Domains 표 갱신 예정');
    return;
  }

  if (before === after) {
    console.log(`✓ ${target} (변경 없음, domains=${count})`);
    return;
  }

  fs.writeFileSync(target, after);
  console.log(`✓ ${target} (domains=${count})`);
}

module.exports = function contextMap(args) {
  const sub = args[0];
  if (sub === 'sync') return syncCommand(args.slice(1));
  console.error('Usage: pact context-map sync [--dry-run]');
  process.exit(1);
};
