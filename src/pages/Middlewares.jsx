import React, { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Copy, LayoutTemplate, Layers3, PencilLine, Plus, Search, Sparkles } from 'lucide-react';
import { parseCaddyfile } from '../../server/caddyParser.js';
import { ConfirmModal, Notice, deleteConfirm, findBlockRange } from '../components/common.jsx';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

const editorOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  wordWrap: 'on',
  scrollBeyondLastLine: false,
  automaticLayout: true,
};

const middlewareTemplates = [
  {
    key: 'security-headers',
    label: 'Security headers',
    name: 'security_headers',
    scope: 'site',
    body: `header {
\tX-Frame-Options "DENY"
\tX-Content-Type-Options "nosniff"
\tReferrer-Policy "strict-origin-when-cross-origin"
}`,
  },
  {
    key: 'forward-auth',
    label: 'Forward auth',
    name: 'forward_auth_guard',
    scope: 'site',
    body: `forward_auth 127.0.0.1:9091 {
\turi /api/authz/forward-auth
\tcopy_headers Remote-User Remote-Groups Remote-Name Remote-Email
}`,
  },
  {
    key: 'cors',
    label: 'CORS',
    name: 'cors_headers',
    scope: 'site',
    body: `header {
\tAccess-Control-Allow-Origin "*"
\tAccess-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
\tAccess-Control-Allow-Headers "*"
}`,
  },
  {
    key: 'proxy-headers',
    label: 'Proxy headers',
    name: 'proxy_headers',
    scope: 'proxy',
    body: `header_up Host {http.request.host}
header_up X-Forwarded-Proto {http.request.scheme}
header_up X-Forwarded-For {http.request.remote.host}`,
  },
];

const middlewareHelpers = [
  {
    key: 'header-block',
    label: 'Header block',
    body: `header {
\tCache-Control "no-store"
}`,
  },
  {
    key: 'handle-options',
    label: 'OPTIONS responder',
    body: `@preflight method OPTIONS
handle @preflight {
\trespond "" 204
}`,
  },
  {
    key: 'rewrite',
    label: 'Rewrite',
    body: `rewrite * /index.html`,
  },
  {
    key: 'header-up',
    label: 'header_up',
    body: `header_up X-Forwarded-Host {http.request.host}`,
  },
];

function normalizeEditorBody(value = '') {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
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

function localSnippetBlock(name, body) {
  const normalized = normalizeEditorBody(body);
  const lines = normalized
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `\t${line}`)
    .join('\n');
  return `(${name}) {\n${lines}\n}`;
}

function snippetPreview(name, body) {
  const safeName = String(name || '').trim() || 'middleware_name';
  return localSnippetBlock(safeName, body);
}

function snippetScope(snippet) {
  const names = [
    ...(snippet?.forwardAuth || []).map(() => 'forward_auth'),
    ...((snippet?.directives || []).map((directive) => directive.name) || []),
  ];
  const body = String(snippet?.body || '');
  if (names.includes('forward_auth') || /\bforward_auth\b/.test(body)) return 'site';
  if (
    names.some((name) => ['header_up', 'header_down', 'method', 'rewrite', 'uri', 'transport'].includes(name) || name.startsWith('lb_')) ||
    /\bheader_up\b|\bheader_down\b|\btransport\b/.test(body)
  ) {
    return 'proxy';
  }
  return 'site';
}

function snippetDirectiveSummary(snippet) {
  const names = [
    ...(snippet?.forwardAuth?.length ? ['forward_auth'] : []),
    ...((snippet?.directives || []).map((directive) => directive.name) || []),
  ];
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return 'custom block';
  return unique.slice(0, 4).join(', ');
}

function appendBodySegment(body = '', segment = '') {
  const current = normalizeEditorBody(body);
  const next = normalizeEditorBody(segment);
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

function buildDraftFromSnippet(snippet) {
  return {
    line: snippet.line,
    name: snippet.name,
    body: normalizeEditorBody(snippet.body),
    inferredType: snippet.inferredType,
    usedBy: snippet.usedBy || [],
    scope: snippetScope(snippet),
  };
}

function nextDuplicateName(name, snippets) {
  const existing = new Set(snippets.map((snippet) => String(snippet.name || '').toLowerCase()));
  const base = `${String(name || '').trim() || 'middleware'}-copy`;
  if (!existing.has(base.toLowerCase())) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`.toLowerCase())) index += 1;
  return `${base}-${index}`;
}

function filterSnippet(snippet, query, typeFilter, usageFilter, scopeFilter) {
  const haystack = [
    snippet.name,
    snippet.inferredType,
    snippetDirectiveSummary(snippet),
    snippetScope(snippet),
    ...(snippet.usedBy || []),
    snippet.body,
  ]
    .join(' ')
    .toLowerCase();
  const matchesQuery = !query || haystack.includes(query);
  const matchesType = typeFilter === 'all' || snippet.inferredType === typeFilter;
  const usageCount = snippet.usedBy?.length || 0;
  const matchesUsage = usageFilter === 'all' || (usageFilter === 'used' ? usageCount > 0 : usageCount === 0);
  const scope = snippetScope(snippet);
  const matchesScope = scopeFilter === 'all' || scope === scopeFilter;
  return matchesQuery && matchesType && matchesUsage && matchesScope;
}

export default function Middlewares({ config, setConfig, canEdit, theme, api, onConfigChanged }) {
  const snippets = config?.parsed?.snippets || [];
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ name: '', body: '' });
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [usageFilter, setUsageFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = search.trim().toLowerCase();
  const filteredSnippets = useMemo(
    () => snippets.filter((snippet) => filterSnippet(snippet, query, typeFilter, usageFilter, scopeFilter)),
    [snippets, query, typeFilter, usageFilter, scopeFilter]
  );

  const summary = useMemo(() => {
    const used = snippets.filter((snippet) => (snippet.usedBy?.length || 0) > 0).length;
    const proxyScoped = snippets.filter((snippet) => snippetScope(snippet) === 'proxy').length;
    const auth = snippets.filter((snippet) => snippet.inferredType === 'auth').length;
    return {
      total: snippets.length,
      used,
      unused: snippets.length - used,
      proxyScoped,
      auth,
    };
  }, [snippets]);

  const applyLocal = (content) => {
    setConfig({
      path: config?.path || 'Caddyfile',
      content,
      parsed: parseCaddyfile(content),
      health: config?.health || {},
    });
  };

  const setSuccess = (text) => {
    setMessage(text);
    setError('');
  };

  const clearMessages = () => {
    setMessage('');
    setError('');
  };

  const applyTemplateToForm = (template) => {
    clearMessages();
    setForm({
      name: form.name.trim() ? form.name : template.name,
      body: normalizeEditorBody(template.body),
    });
  };

  const appendHelperToForm = (helper) => {
    clearMessages();
    setForm((current) => ({ ...current, body: appendBodySegment(current.body, helper.body) }));
  };

  const applyTemplateToEdit = (template) => {
    if (!edit) return;
    clearMessages();
    setEdit({
      ...edit,
      name: edit.name.trim() ? edit.name : template.name,
      body: normalizeEditorBody(template.body),
    });
  };

  const appendHelperToEdit = (helper) => {
    if (!edit) return;
    clearMessages();
    setEdit((current) => ({ ...current, body: appendBodySegment(current.body, helper.body) }));
  };

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    clearMessages();
    try {
      const normalizedBody = normalizeEditorBody(form.body);
      if (localTest) {
        applyLocal(`${config.content.trimEnd()}\n\n${localSnippetBlock(form.name, normalizedBody)}\n`);
        setForm({ name: '', body: '' });
        setSuccess('Middleware added locally.');
        return;
      }
      const data = await api('/api/middlewares', {
        method: 'POST',
        body: JSON.stringify({ ...form, body: normalizedBody }),
      });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      onConfigChanged?.('Middleware added.');
      setForm({ name: '', body: '' });
      setSuccess('Middleware added.');
    } catch (err) {
      setError(err.message);
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    clearMessages();
    try {
      const normalizedBody = normalizeEditorBody(edit.body);
      if (localTest) {
        const range = findBlockRange(config.content, edit.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) {
          lines.splice(range.start, range.end - range.start + 1, ...localSnippetBlock(edit.name, normalizedBody).split('\n'));
        }
        applyLocal(lines.join('\n'));
        setEdit(null);
        setSuccess('Middleware updated locally.');
        return;
      }
      const data = await api(`/api/middlewares/${edit.line}`, {
        method: 'PUT',
        body: JSON.stringify({ ...edit, body: normalizedBody }),
      });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      onConfigChanged?.('Middleware updated.');
      setEdit(null);
      setSuccess('Middleware updated.');
    } catch (err) {
      setError(err.message);
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const deleteMiddleware = async (item) => {
    setBusy(true);
    clearMessages();
    try {
      if (localTest) {
        const range = findBlockRange(config.content, item.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) lines.splice(range.start, range.end - range.start + 1);
        applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
        setSuccess('Middleware deleted locally.');
        return;
      }
      const data = await api(`/api/middlewares/${item.line}`, { method: 'DELETE' });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      onConfigChanged?.('Middleware deleted.');
      setSuccess('Middleware deleted.');
    } catch (err) {
      setError(err.message);
      setMessage('');
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const openEdit = (snippet) => {
    clearMessages();
    setEdit(buildDraftFromSnippet(snippet));
  };

  const duplicateSnippet = (snippet) => {
    clearMessages();
    setForm({
      name: nextDuplicateName(snippet.name, snippets),
      body: normalizeEditorBody(snippet.body),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setSuccess(`Copied (${snippet.name}) into the create form.`);
  };

  const copyImportStatement = async (snippet) => {
    try {
      await navigator.clipboard.writeText(`import ${snippet.name}`);
      setSuccess(`Copied import ${snippet.name}.`);
    } catch {
      setError('Clipboard copy failed.');
      setMessage('');
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Middlewares</h2>
          <p>Build, search, duplicate, and maintain snippet libraries without dropping straight into raw config every time.</p>
        </div>
      </div>

      {message && <Notice type="success">{message}</Notice>}
      {error && <Notice type="error">{error}</Notice>}

      <div className="stats middleware-stats">
        <div><b>{summary.total}</b><span>Total snippets</span></div>
        <div><b>{summary.used}</b><span>In use</span></div>
        <div><b>{summary.proxyScoped}</b><span>Proxy-scoped</span></div>
        <div><b>{summary.auth}</b><span>Auth snippets</span></div>
      </div>

      {canEdit && (
        <div className="middleware-workbench">
          <form className="middleware-builder" onSubmit={add}>
            <div className="middleware-builder-main">
              <div className="middleware-card-head">
                <div>
                  <h3>Create middleware</h3>
                  <p>Start from a template, tweak the body, and add it directly to the Caddyfile snippet library.</p>
                </div>
                <button type="submit" className="primary" disabled={busy}>
                  <Plus size={16} />
                  Add middleware
                </button>
              </div>
              <label>
                Name
                <input
                  placeholder="security_headers"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <div className="middleware-editor-toolbar toolbar">
                <button type="button" onClick={() => setForm((current) => ({ ...current, body: normalizeEditorBody(current.body) }))}>
                  <Sparkles size={16} />
                  Normalize indentation
                </button>
                <button type="button" onClick={() => setForm({ name: '', body: '' })}>Clear draft</button>
              </div>
              <div className="middleware-editor middleware-editor-large">
                <Editor
                  height="320px"
                  defaultLanguage="caddyfile"
                  theme={theme === 'light' ? 'light' : 'vs-dark'}
                  value={form.body}
                  onChange={(value) => setForm({ ...form, body: value || '' })}
                  options={editorOptions}
                />
              </div>
            </div>

            <div className="middleware-builder-side">
              <div className="middleware-side-card">
                <div className="middleware-card-head compact">
                  <div>
                    <h4>Starter templates</h4>
                    <p>Quick-fill common middleware patterns.</p>
                  </div>
                </div>
                <div className="middleware-template-grid">
                  {middlewareTemplates.map((template) => (
                    <button key={template.key} type="button" className="middleware-template" onClick={() => applyTemplateToForm(template)}>
                      <LayoutTemplate size={16} />
                      <span>{template.label}</span>
                      <small>{template.scope}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="middleware-side-card">
                <div className="middleware-card-head compact">
                  <div>
                    <h4>Directive helpers</h4>
                    <p>Append small blocks instead of rewriting boilerplate by hand.</p>
                  </div>
                </div>
                <div className="middleware-helper-list">
                  {middlewareHelpers.map((helper) => (
                    <button key={helper.key} type="button" onClick={() => appendHelperToForm(helper)}>
                      {helper.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="middleware-side-card middleware-preview-card">
                <div className="middleware-card-head compact">
                  <div>
                    <h4>Preview</h4>
                    <p>This is the block that will be written.</p>
                  </div>
                </div>
                <pre>{snippetPreview(form.name, form.body)}</pre>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="proxy-search middleware-searchbar">
        <div className="middleware-search-input">
          <Search size={16} />
          <input placeholder="Search by name, directive, usage, or body" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="snippet">snippet</option>
          <option value="headers">headers</option>
          <option value="auth">auth</option>
          <option value="tls">tls</option>
        </select>
        <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
          <option value="all">All scopes</option>
          <option value="site">site</option>
          <option value="proxy">proxy</option>
        </select>
        <select value={usageFilter} onChange={(e) => setUsageFilter(e.target.value)}>
          <option value="all">All usage</option>
          <option value="used">In use</option>
          <option value="unused">Unused</option>
        </select>
      </div>

      <div className="middleware-results">
        <span>{filteredSnippets.length} shown</span>
        <span>{summary.total} total</span>
        <span>{summary.unused} unused</span>
      </div>

      <div className="middleware-list middleware-library">
        <div className="middleware-table-head">
          <span>Name</span>
          <span>Type</span>
          <span>Scope</span>
          <span>Directives</span>
          <span>Used by</span>
          <span>Actions</span>
        </div>
        {filteredSnippets.map((snippet) => {
          const scope = snippetScope(snippet);
          const usageCount = snippet.usedBy?.length || 0;
          return (
            <div
              className={`middleware-row ${canEdit ? 'clickable' : ''}`}
              key={snippet.name}
              onClick={canEdit ? () => openEdit(snippet) : undefined}
              role={canEdit ? 'button' : undefined}
              tabIndex={canEdit ? 0 : undefined}
              onKeyDown={canEdit ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openEdit(snippet);
                }
              } : undefined}
            >
              <span className="middleware-name" data-label="Name">
                <strong>({snippet.name})</strong>
                <small>{usageCount > 0 ? `${usageCount} import${usageCount === 1 ? '' : 's'}` : 'unused'}</small>
              </span>
              <span className="middleware-type" data-label="Type">
                <span className={`middleware-chip ${snippet.inferredType || 'snippet'}`}>{snippet.inferredType || 'snippet'}</span>
              </span>
              <span className="middleware-scope" data-label="Scope">{scope}</span>
              <span className="middleware-directives" data-label="Directives">{snippetDirectiveSummary(snippet)}</span>
              <span className="middleware-usedby" data-label="Used by">{snippet.usedBy?.join(', ') || 'unused'}</span>
              <div className="row-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); copyImportStatement(snippet); }}>
                  <Copy size={14} />
                  Copy import
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); duplicateSnippet(snippet); }}>
                  <Layers3 size={14} />
                  Duplicate
                </button>
                {canEdit && (
                  <>
                    <button type="button" onClick={(e) => { e.stopPropagation(); openEdit(snippet); }}>
                      <PencilLine size={14} />
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(deleteConfirm(e, 'Delete middleware', snippet.name, () => deleteMiddleware(snippet)));
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {filteredSnippets.length === 0 && (
          <div className="middleware-empty">
            <h3>No middleware matches</h3>
            <p>Try loosening the filters or create a new snippet from a starter template.</p>
          </div>
        )}
      </div>

      {edit && (
        <div className="modal-backdrop" onMouseDown={() => setEdit(null)}>
          <form className="edit-modal middleware-edit-modal" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>Edit middleware</h3>
                <p>Refine the snippet body, rename it, and keep an eye on usage before saving.</p>
              </div>
              <button type="button" onClick={() => setEdit(null)}>Close</button>
            </div>
            <div className="middleware-edit-layout">
              <div className="proxy-edit-card">
                <h4>Details</h4>
                <label>
                  Name
                  <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </label>
                <div className="middleware-meta-grid">
                  <div>
                    <span>Type</span>
                    <b>{edit.inferredType || 'snippet'}</b>
                  </div>
                  <div>
                    <span>Scope</span>
                    <b>{edit.scope}</b>
                  </div>
                  <div>
                    <span>Used by</span>
                    <b>{edit.usedBy?.length || 0}</b>
                  </div>
                  <div>
                    <span>Directives</span>
                    <b>{snippetDirectiveSummary(edit)}</b>
                  </div>
                </div>
                <div className="middleware-usage-list">
                  <h4>Imported by</h4>
                  <p>{edit.usedBy?.join(', ') || 'Unused right now.'}</p>
                </div>
                <div className="middleware-template-grid compact">
                  {middlewareTemplates.map((template) => (
                    <button key={template.key} type="button" className="middleware-template" onClick={() => applyTemplateToEdit(template)}>
                      <LayoutTemplate size={16} />
                      <span>{template.label}</span>
                      <small>{template.scope}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="proxy-edit-card">
                <h4>Body</h4>
                <div className="middleware-editor-toolbar toolbar">
                  <button type="button" onClick={() => setEdit((current) => ({ ...current, body: normalizeEditorBody(current.body) }))}>
                    <Sparkles size={16} />
                    Normalize indentation
                  </button>
                  {middlewareHelpers.map((helper) => (
                    <button key={helper.key} type="button" onClick={() => appendHelperToEdit(helper)}>{helper.label}</button>
                  ))}
                </div>
                <div className="middleware-editor middleware-editor-large">
                  <Editor
                    height="420px"
                    defaultLanguage="caddyfile"
                    theme={theme === 'light' ? 'light' : 'vs-dark'}
                    value={edit.body}
                    onChange={(value) => setEdit({ ...edit, body: value || '' })}
                    options={editorOptions}
                  />
                </div>
              </div>

              <div className="proxy-edit-card middleware-preview-card">
                <h4>Live preview</h4>
                <pre>{snippetPreview(edit.name, edit.body)}</pre>
                <button type="button" onClick={() => copyImportStatement(edit)}>
                  <Copy size={14} />
                  Copy import statement
                </button>
              </div>
            </div>
            <div className="toolbar">
              <button className="primary" disabled={busy}>Save</button>
              <button type="button" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmModal
        confirm={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete?.action()}
      />
    </section>
  );
}
