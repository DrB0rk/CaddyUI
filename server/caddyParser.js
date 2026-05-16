const stripInlineComment = (line) => {
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') inQuote = !inQuote;
    if (char === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
};

const firstToken = (line) => line.trim().split(/\s+/)[0] || '';
const normalizeAddress = (line) => line.replace(/\s*\{\s*$/, '').trim();
const TAG_PREFIX_PATTERN = /^#\s*caddyui-tags\s*:\s*(.*)$/i;
const CATEGORY_PREFIX_PATTERN = /^#\s*caddyui-category\s*:\s*(.*)$/i;
const DISABLED_PREFIX_PATTERN = /^#\s*caddyui-disabled\s*:\s*(true|1|yes)\s*$/i;
const DISABLED_PROXY_PREFIX_PATTERN = /^(\s*)#\s*caddyui-disabled-proxy\s?(.*)$/i;

function findMatchingBrace(lines, startIndex, normalizeLine = stripInlineComment) {
  let depth = 0;
  for (let i = startIndex; i < lines.length; i++) {
    const clean = normalizeLine(lines[i]);
    for (const char of clean) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
    if (depth === 0) return i;
  }
  return lines.length - 1;
}

function unmaskDisabledProxyLine(line = '') {
  const match = String(line || '').match(DISABLED_PROXY_PREFIX_PATTERN);
  if (!match) return line;
  return `${match[1]}${match[2]}`;
}

function maskDisabledProxyLine(line = '') {
  const plain = unmaskDisabledProxyLine(line);
  const indent = plain.match(/^\s*/)?.[0] || '';
  const content = plain.trimStart();
  if (!content) return plain;
  return `${indent}# caddyui-disabled-proxy ${content}`;
}

function disabledProxyDirective(line = '') {
  const unmasked = unmaskDisabledProxyLine(line);
  if (unmasked === line) return '';
  return stripInlineComment(unmasked).trim();
}

function collectDirectives(lines, start, end) {
  const directives = [];
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const clean = stripInlineComment(raw).trim();
    if (!clean || clean === '}' || clean.endsWith('{')) continue;
    const [name, ...args] = clean.split(/\s+/);
    directives.push({ name, args, raw: raw.trim(), line: i + 1 });
  }
  return directives;
}

function collectImports(lines, start, end) {
  return collectDirectives(lines, start, end)
    .filter((d) => d.name === 'import')
    .map((d) => ({ name: d.args[0], args: d.args.slice(1), line: d.line }));
}

function normalizeTags(tags = []) {
  const seen = new Set();
  const values = Array.isArray(tags)
    ? tags
    : String(tags || '')
        .split(',')
        .map((x) => x.trim());
  const normalized = [];
  for (const value of values) {
    const tag = String(value || '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

function normalizeCategory(value = '') {
  return String(value || '')
    .split(',')[0]
    .trim();
}

function parseSiteTags(lines, start, end) {
  const tags = [];
  let depth = 0;
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const trimmed = String(raw || '').trim();
    if (depth === 0) {
      const match = trimmed.match(TAG_PREFIX_PATTERN);
      if (match) tags.push(...match[1].split(',').map((x) => x.trim()));
    }
    for (const char of stripInlineComment(raw)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return normalizeTags(tags);
}

function parseSiteCategory(lines, start, end) {
  let category = '';
  let depth = 0;
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const trimmed = String(raw || '').trim();
    if (depth === 0) {
      const match = trimmed.match(CATEGORY_PREFIX_PATTERN);
      if (match) category = normalizeCategory(match[1]);
    }
    for (const char of stripInlineComment(raw)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return category;
}

function parseSiteDisabled(lines, start, end) {
  let disabled = false;
  let depth = 0;
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const trimmed = String(raw || '').trim();
    if (depth === 0 && DISABLED_PREFIX_PATTERN.test(trimmed)) disabled = true;
    for (const char of stripInlineComment(raw)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return disabled;
}

function parseSiteLog(lines, start, end) {
  let depth = 0;
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const clean = stripInlineComment(raw).trim();
    if (!clean) continue;
    if (depth === 0 && clean === 'log') return { mode: 'default', line: i + 1 };
    if (depth === 0 && clean.startsWith('log ') && clean.endsWith('{')) {
      const blockEnd = findMatchingBrace(lines, i);
      let mode = 'default';
      let filePath = '';
      for (let j = i + 1; j < blockEnd; j++) {
        const bodyLine = stripInlineComment(lines[j]).trim();
        if (!bodyLine) continue;
        if (bodyLine.startsWith('output ')) {
          const parts = bodyLine.split(/\s+/);
          if (parts[1] === 'stdout') mode = 'stdout';
          else if (parts[1] === 'stderr') mode = 'stderr';
          else if (parts[1] === 'discard') mode = 'discard';
          else if (parts[1] === 'file') {
            mode = 'file';
            filePath = parts.slice(2).join(' ');
          } else {
            mode = parts[1] || 'default';
          }
        }
      }
      return { mode, path: filePath, line: i + 1, endLine: blockEnd + 1 };
    }
    for (const char of clean) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return { mode: 'none', line: null };
}

function parseNamedMatchers(lines, start, end) {
  const matchers = [];
  for (let i = start; i <= end; i++) {
    const clean = stripInlineComment(lines[i]).trim();
    if (!clean.startsWith('@')) continue;
    const [name, ...rest] = clean.split(/\s+/);
    if (clean.endsWith('{')) {
      const blockEnd = findMatchingBrace(lines, i);
      matchers.push({ name, type: 'block', args: rest.filter((x) => x !== '{'), body: lines.slice(i + 1, blockEnd).map((l) => l.trim()).filter(Boolean), line: i + 1 });
      i = blockEnd;
    } else {
      matchers.push({ name, type: rest[0] || 'inline', args: rest.slice(1), line: i + 1 });
    }
  }
  return matchers;
}

function parseProxyFromLine(line, lineNumber, blockLines = [], endLine = lineNumber, disabled = false) {
  const clean = stripInlineComment(line).replace(/\s*\{\s*$/, '').trim();
  const parts = clean.split(/\s+/);
  const idx = parts.indexOf('reverse_proxy');
  if (idx === -1) return null;
  const maybeMatcher = parts[idx + 1]?.startsWith('@') ? parts[idx + 1] : null;
  const upstreams = parts.slice(idx + 1 + (maybeMatcher ? 1 : 0));
  const imports = blockLines
    .map((l, n) => ({ raw: stripInlineComment(l).trim(), line: lineNumber + n + 1 }))
    .filter((d) => d.raw.startsWith('import '))
    .map((d) => ({ name: d.raw.split(/\s+/)[1], line: d.line }));
  const options = blockLines.map((l) => l.trim()).filter(Boolean);
  return { matcher: maybeMatcher, upstreams, imports, options, line: lineNumber, endLine, disabled };
}

function parseForwardAuthFromLine(line, lineNumber, blockLines = []) {
  const clean = stripInlineComment(line).replace(/\s*\{\s*$/, '').trim();
  const parts = clean.split(/\s+/);
  const idx = parts.indexOf('forward_auth');
  if (idx === -1) return null;
  return {
    upstream: parts[idx + 1] || '',
    options: blockLines.map((l) => l.trim()).filter(Boolean),
    line: lineNumber,
  };
}

function scanBlocks(lines, start, end) {
  const proxies = [];
  const forwardAuth = [];
  const handles = [];
  const directives = [];
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const clean = stripInlineComment(raw).trim();
    const disabledDirective = disabledProxyDirective(raw);
    const effective = disabledDirective || clean;
    const isDisabledProxy = Boolean(disabledDirective);
    if (!effective || effective === '}') continue;

    if (/^handle\b/.test(clean) && clean.endsWith('{')) {
      const blockEnd = findMatchingBrace(lines, i);
      const child = scanBlocks(lines, i + 1, blockEnd - 1);
      handles.push({ matcher: clean.replace(/\s*\{\s*$/, '').split(/\s+/)[1] || null, line: i + 1, proxies: child.proxies, directives: child.directives });
      proxies.push(...child.proxies.map((p) => ({ ...p, context: 'handle', handleMatcher: clean.split(/\s+/)[1] || null })));
      i = blockEnd;
      continue;
    }

    if (effective.includes('reverse_proxy')) {
      let blockLines = [];
      if (effective.endsWith('{')) {
        const blockEnd = isDisabledProxy
          ? findMatchingBrace(lines, i, (line) => stripInlineComment(unmaskDisabledProxyLine(line)))
          : findMatchingBrace(lines, i);
        blockLines = lines.slice(i + 1, blockEnd).map(unmaskDisabledProxyLine);
        const proxy = parseProxyFromLine(effective, i + 1, blockLines, blockEnd + 1, isDisabledProxy);
        if (proxy) proxies.push(proxy);
        i = blockEnd;
      } else {
        const proxy = parseProxyFromLine(effective, i + 1, [], i + 1, isDisabledProxy);
        if (proxy) proxies.push(proxy);
      }
      continue;
    }

    if (clean.includes('forward_auth')) {
      let blockLines = [];
      if (clean.endsWith('{')) {
        const blockEnd = findMatchingBrace(lines, i);
        blockLines = lines.slice(i + 1, blockEnd);
        const auth = parseForwardAuthFromLine(raw, i + 1, blockLines);
        if (auth) forwardAuth.push(auth);
        i = blockEnd;
      } else {
        const auth = parseForwardAuthFromLine(raw, i + 1);
        if (auth) forwardAuth.push(auth);
      }
      continue;
    }

    if (!clean.endsWith('{')) {
      const [name, ...args] = clean.split(/\s+/);
      directives.push({ name, args, raw: raw.trim(), line: i + 1 });
    }
  }
  return { proxies, forwardAuth, handles, directives };
}

export function parseCaddyfile(source = '') {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const snippets = [];
  const sites = [];
  const globals = [];
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const clean = stripInlineComment(lines[i]).trim();
    if (!clean || clean.startsWith('#') || clean === '}') continue;

    if (clean.endsWith('{')) {
      const header = normalizeAddress(clean);
      const end = findMatchingBrace(lines, i);
      const bodyStart = i + 1;
      const bodyEnd = Math.max(i, end - 1);
      const body = lines.slice(bodyStart, end).join('\n');
      const scan = scanBlocks(lines, bodyStart, bodyEnd);
      const imports = collectImports(lines, bodyStart, bodyEnd);
      const matchers = parseNamedMatchers(lines, bodyStart, bodyEnd);

      if (/^\(.+\)$/.test(header)) {
        snippets.push({ name: header.slice(1, -1), line: i + 1, endLine: end + 1, imports, directives: scan.directives, forwardAuth: scan.forwardAuth, body });
      } else if (header === '') {
        globals.push({ line: i + 1, endLine: end + 1, body });
      } else {
        const addresses = header.split(',').map((x) => x.trim()).filter(Boolean);
        const logging = parseSiteLog(lines, bodyStart, bodyEnd);
        const tags = parseSiteTags(lines, bodyStart, bodyEnd);
        const category = parseSiteCategory(lines, bodyStart, bodyEnd);
        const disabled = parseSiteDisabled(lines, bodyStart, bodyEnd) || (scan.proxies.length > 0 && scan.proxies.every((proxy) => proxy.disabled));
        sites.push({ id: `${addresses.join(',')}:${i + 1}`, addresses, line: i + 1, endLine: end + 1, imports, matchers, proxies: scan.proxies, forwardAuth: scan.forwardAuth, handles: scan.handles, directives: scan.directives, logging, tags, category, disabled, body });
      }
      i = end;
    } else if (clean.includes('{') && !clean.endsWith('{')) {
      warnings.push({ line: i + 1, message: 'Inline blocks are only partially represented in the visual parser.' });
    }
  }

  const importedSnippetNames = new Set([...sites, ...snippets].flatMap((x) => x.imports.map((i) => i.name)));
  const middlewareSnippets = snippets.map((snippet) => ({
    ...snippet,
    usedBy: sites.filter((site) => site.imports.some((i) => i.name === snippet.name)).map((site) => site.addresses.join(', ')),
    inferredType: snippet.forwardAuth.length ? 'auth' : snippet.directives.some((d) => d.name.startsWith('header')) ? 'headers' : snippet.directives.some((d) => d.name === 'tls') ? 'tls' : 'snippet',
  }));

  return {
    summary: { sites: sites.length, proxies: sites.reduce((sum, site) => sum + site.proxies.length, 0), snippets: snippets.length, middleware: importedSnippetNames.size },
    sites,
    snippets: middlewareSnippets,
    globals,
    warnings,
  };
}


function proxyScopedSnippet(snippet) {
  if (!snippet) return false;
  const body = String(snippet.body || '');
  const names = (snippet.directives || []).map((d) => d.name);
  // `forward_auth` snippets are intended for site/server block scope.
  if (names.includes('forward_auth') || /\bforward_auth\b/.test(body)) return false;
  return names.some((name) => ['header_up', 'header_down', 'method', 'rewrite', 'uri', 'transport'].includes(name) || name.startsWith('lb_')) || /\bheader_up\b|\bheader_down\b|\btransport\b/.test(body);
}
function splitImportsByScope(source, imports = []) {
  const parsed = parseCaddyfile(source);
  const snippets = new Map((parsed.snippets || []).map((snippet) => [snippet.name, snippet]));
  const siteImports = [];
  const proxyImports = [];
  for (const name of imports.filter(Boolean)) {
    const snippet = snippets.get(name);
    if (proxyScopedSnippet(snippet)) proxyImports.push(name);
    else siteImports.push(name);
  }
  return { siteImports, proxyImports };
}

function formatLogLines(indent, logging = {}) {
  const mode = String(logging?.mode || 'none').trim();
  if (!mode || mode === 'none') return [];
  if (mode === 'default') return [`${indent}log`];
  if (mode === 'stdout' || mode === 'stderr' || mode === 'discard') {
    return [`${indent}log {`, `${indent}\toutput ${mode}`, `${indent}}`];
  }
  if (mode === 'file') {
    const filePath = String(logging?.path || '').trim();
    if (!filePath) return [`${indent}log`];
    return [`${indent}log {`, `${indent}\toutput file ${filePath}`, `${indent}}`];
  }
  return [`${indent}log`];
}

function removeTopLevelLog(lines) {
  const kept = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const clean = stripInlineComment(raw).trim();
    if (depth === 0 && clean === 'log') continue;
    if (depth === 0 && clean.startsWith('log ') && clean.endsWith('{')) {
      const blockEnd = findMatchingBrace(lines, i);
      i = blockEnd;
      continue;
    }
    kept.push(raw);
    for (const char of stripInlineComment(raw)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return kept;
}

function removeTopLevelImports(lines) {
  const kept = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = stripInlineComment(line).trim();
    if (!(depth === 0 && trimmed.startsWith('import '))) kept.push(line);
    for (const char of stripInlineComment(line)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return kept;
}

function removeTopLevelTags(lines) {
  const kept = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!(depth === 0 && TAG_PREFIX_PATTERN.test(trimmed))) kept.push(line);
    for (const char of stripInlineComment(line)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return kept;
}

function removeTopLevelCategory(lines) {
  const kept = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!(depth === 0 && CATEGORY_PREFIX_PATTERN.test(trimmed))) kept.push(line);
    for (const char of stripInlineComment(line)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return kept;
}

function removeDisabledMarker(lines) {
  return lines.filter((line) => !DISABLED_PREFIX_PATTERN.test(String(line || '').trim()));
}

function replaceFirstTopLevelReverseProxy(lines, upstream, proxyImports = []) {
  const next = [];
  let depth = 0;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const clean = stripInlineComment(raw).trim();
    if (!replaced && depth === 0 && clean.startsWith('reverse_proxy ')) {
      const indent = raw.match(/^\s*/)?.[0] || '';
      const hasBlock = clean.endsWith('{');
      const parts = clean.replace(/\s*\{\s*$/, '').split(/\s+/);
      const maybeMatcher = parts[1]?.startsWith('@') ? parts[1] : null;
      const header = `${indent}reverse_proxy ${maybeMatcher ? `${maybeMatcher} ` : ''}${upstream}`;
      if (hasBlock) {
        const blockEnd = findMatchingBrace(lines, i);
        const bodyLines = lines.slice(i + 1, blockEnd).filter((line) => !stripInlineComment(line).trim().startsWith('import '));
        const proxyImportLines = proxyImports.map((name) => `${indent}\timport ${name}`);
        next.push(`${header} {`, ...proxyImportLines, ...bodyLines, `${indent}}`);
        i = blockEnd;
      } else if (proxyImports.length) {
        next.push(`${header} {`, ...proxyImports.map((name) => `${indent}\timport ${name}`), `${indent}}`);
      } else {
        next.push(header);
      }
      replaced = true;
      continue;
    }
    next.push(raw);
    for (const char of stripInlineComment(raw)) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  return next;
}

export function appendSimpleProxy(source, { host, upstream, imports = [], logging = {}, disabled = false }) {
  const safeHost = String(host || '').trim();
  const safeUpstream = String(upstream || '').trim();
  if (!safeHost || !safeUpstream) throw new Error('Host and upstream are required.');
  const { siteImports, proxyImports } = splitImportsByScope(source, imports);
  const importLines = siteImports.map((name) => `\timport ${name}`).join('\n');
  const disabledLine = disabled ? '\t# caddyui-disabled: true' : '';
  const logLines = formatLogLines('\t', logging).join('\n');
  const proxyImportLines = proxyImports.map((name) => `\t\timport ${name}`).join('\n');
  const proxyBlock = proxyImportLines
    ? `\treverse_proxy ${safeUpstream} {\n${proxyImportLines}\n\t}`
    : `\treverse_proxy ${safeUpstream}`;
  const proxyLine = disabled ? proxyBlock.split('\n').map(maskDisabledProxyLine).join('\n') : proxyBlock;
  const block = `${safeHost} {\n${disabledLine ? `${disabledLine}\n` : ''}${importLines ? `${importLines}\n` : ''}${logLines ? `${logLines}\n` : ''}${proxyLine}\n}\n`;
  return `${source.trimEnd()}\n\n${block}`;
}


export function updateSimpleProxy(source, { siteLine, host, upstream, imports = [], logging, disabled = false }) {
  const safeHost = String(host || '').trim();
  const safeUpstream = String(upstream || '').trim();
  const targetLine = Number(siteLine);
  if (!targetLine || !safeHost || !safeUpstream) throw new Error('Site line, host and upstream are required.');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = targetLine - 1;
  if (start < 0 || start >= lines.length) throw new Error('Site block was not found.');
  const end = findMatchingBrace(lines, start);
  const { siteImports, proxyImports } = splitImportsByScope(source, imports);
  const bodyLines = lines.slice(start + 1, end);
  const cleanedBody = removeTopLevelLog(removeTopLevelImports(removeTopLevelTags(removeTopLevelCategory(removeDisabledMarker(bodyLines)))));
  const rewrittenBody = replaceFirstTopLevelReverseProxy(cleanedBody, safeUpstream, proxyImports);
  const indent = bodyLines.find((line) => line.trim())?.match(/^\s*/)?.[0] || '\t';
  const block = [
    `${safeHost} {`,
    ...(disabled ? [`${indent}# caddyui-disabled: true`] : []),
    ...siteImports.map((name) => `${indent}import ${name}`),
    ...formatLogLines(indent, logging),
    ...(disabled ? rewrittenBody.map(maskDisabledProxyLine) : rewrittenBody),
    '}',
  ];
  lines.splice(start, end - start + 1, ...block);
  return lines.join('\n');
}

export function setProxyDisabled(source, { siteLine, disabled = true }) {
  const targetLine = Number(siteLine);
  if (!targetLine) throw new Error('Site line is required.');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = targetLine - 1;
  if (start < 0 || start >= lines.length) throw new Error('Site block was not found.');
  let end = findMatchingBrace(lines, start);
  const indent = lines.slice(start + 1, end).find((line) => line.trim())?.match(/^\s*/)?.[0] || '\t';

  for (let i = start + 1; i < end; i++) {
    if (DISABLED_PREFIX_PATTERN.test(String(lines[i] || '').trim())) {
      lines.splice(i, 1);
      end -= 1;
      i -= 1;
    }
  }

  for (let i = start + 1; i < end; i++) {
    const clean = stripInlineComment(unmaskDisabledProxyLine(lines[i])).trim();
    if (!clean.includes('reverse_proxy')) continue;
    if (clean.endsWith('{')) {
      const blockEnd = findMatchingBrace(lines, i, (line) => stripInlineComment(unmaskDisabledProxyLine(line)));
      for (let j = i; j <= blockEnd; j++) {
        lines[j] = disabled ? maskDisabledProxyLine(lines[j]) : unmaskDisabledProxyLine(lines[j]);
      }
      i = blockEnd;
    } else {
      lines[i] = disabled ? maskDisabledProxyLine(lines[i]) : unmaskDisabledProxyLine(lines[i]);
    }
  }

  if (disabled) lines.splice(start + 1, 0, `${indent}# caddyui-disabled: true`);
  return lines.join('\n');
}


export function appendSnippet(source, { name, body = '' }) {
  const safeName = String(name || '').trim().replace(/^\(|\)$/g, '');
  if (!safeName) throw new Error('Middleware name is required.');
  const safeBody = normalizeSnippetBody(body);
  const block = `(${safeName}) {\n${formatSnippetBodyLines(safeBody).join('\n')}\n}\n`;
  return `${source.trimEnd()}\n\n${block}`;
}

export function updateSnippet(source, { line, name, body = '' }) {
  const targetLine = Number(line);
  const safeName = String(name || '').trim().replace(/^\(|\)$/g, '');
  if (!targetLine || !safeName) throw new Error('Middleware line and name are required.');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = targetLine - 1;
  if (start < 0 || start >= lines.length) throw new Error('Middleware block was not found.');
  const end = findMatchingBrace(lines, start);
  const safeBody = normalizeSnippetBody(body);
  const block = [`(${safeName}) {`, ...formatSnippetBodyLines(safeBody), `}`];
  lines.splice(start, end - start + 1, ...block);
  return lines.join('\n');
}


export function deleteBlockAtLine(source, line) {
  const targetLine = Number(line);
  if (!targetLine) throw new Error('Line is required.');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = targetLine - 1;
  if (start < 0 || start >= lines.length) throw new Error('Block was not found.');
  const end = findMatchingBrace(lines, start);
  lines.splice(start, end - start + 1);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeSnippetBody(body = '') {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const content = lines.filter((line) => line.trim().length > 0);
  if (!content.length) return '';
  const minIndent = content.reduce((min, line) => {
    const indent = (line.match(/^\s*/) || [''])[0].length;
    return Math.min(min, indent);
  }, Number.POSITIVE_INFINITY);
  return lines.map((line) => (line.trim().length ? line.slice(minIndent) : '')).join('\n');
}

function formatSnippetBodyLines(body = '') {
  return String(body || '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `\t${line}`);
}
