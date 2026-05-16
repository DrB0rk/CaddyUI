import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Loader2, RefreshCw, Wand2 } from 'lucide-react';
import { appendSimpleProxy, parseCaddyfile, setProxyDisabled, updateSimpleProxy } from '../../server/caddyParser.js';
import {
  ConfirmModal,
  MiddlewarePicker,
  Notice,
  ProxyRow,
  StatCards,
  deleteConfirm,
  normalizeLogging,
  previewProxyBlock,
  readBlockAtLine,
  replaceBlockAtLine,
  rootDomain,
  selectedImportNames,
  selectedTagNames,
} from '../components/common.jsx';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

const compareText = (a, b) => String(a || '').toLowerCase().localeCompare(String(b || '').toLowerCase());
const compareBool = (a, b) => Number(Boolean(a)) - Number(Boolean(b));

function sortValue(site, key, health) {
  if (key === 'domain') return rootDomain(site.addresses?.[0]);
  if (key === 'host') return site.addresses?.[0] || '';
  if (key === 'upstream') return site.proxies?.[0]?.upstreams?.join(' ') || '';
  if (key === 'description') return site.description || '';
  if (key === 'local') return Boolean(health?.[site.id]?.local?.online);
  if (key === 'category') return site.category || '';
  if (key === 'tags') return (site.tags || []).join(', ');
  if (key === 'imports') return [...(site.imports || []).map((i) => i.name), ...((site.proxies?.[0]?.imports || []).map((i) => i.name))].join(', ');
  return '';
}

function sortSites(a, b, sort, health) {
  if (sort.key === 'local') {
    const value = compareBool(sortValue(a, sort.key, health), sortValue(b, sort.key, health));
    if (value !== 0) return sort.dir === 'asc' ? value : -value;
    return compareText(a.addresses?.[0], b.addresses?.[0]);
  }
  const value = compareText(sortValue(a, sort.key, health), sortValue(b, sort.key, health));
  if (value !== 0) return sort.dir === 'asc' ? value : -value;
  return compareText(a.addresses?.[0], b.addresses?.[0]);
}

function AutoCompleteInput({ value, onChange, suggestions, placeholder = '' }) {
  const [open, setOpen] = useState(false);
  const prefix = String(value || '').trim().toLowerCase();
  const matches = useMemo(
    () =>
      suggestions.filter((item) =>
        !prefix ? true : String(item).toLowerCase().includes(prefix)
      ),
    [suggestions, prefix]
  );
  return (
    <div className="autocomplete-field">
      <input
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && matches.length > 0 && (
        <div className="autocomplete-menu">
          {matches.slice(0, 10).map((item) => (
            <button
              type="button"
              key={item}
              className="autocomplete-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(item);
                setOpen(false);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TagAutoCompleteInput({ value, onChange, suggestions, placeholder = '' }) {
  const [open, setOpen] = useState(false);
  const parts = String(value || '').split(',');
  const prefixParts = parts.slice(0, -1).map((x) => x.trim()).filter(Boolean);
  const used = new Set(prefixParts.map((x) => x.toLowerCase()));
  const current = (parts[parts.length - 1] || '').trim().toLowerCase();
  const matches = useMemo(
    () =>
      suggestions.filter((item) => {
        const lower = String(item).toLowerCase();
        if (used.has(lower)) return false;
        if (!current) return true;
        return lower.includes(current);
      }),
    [suggestions, used, current]
  );
  const applyTag = (tag) => {
    const next = [...prefixParts, tag].join(', ');
    onChange(`${next}, `);
  };
  return (
    <div className="autocomplete-field">
      <input
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
      />
      {open && matches.length > 0 && (
        <div className="autocomplete-menu">
          {matches.slice(0, 12).map((item) => (
            <button
              type="button"
              key={item}
              className="autocomplete-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                applyTag(item);
                setOpen(false);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Proxies({ config, refresh, setConfig, canEdit, theme, health, loading, api, onConfigChanged }) {
  const empty = { host: '', upstream: '', description: '', category: '', tags: '', imports: '', logMode: 'none', logPath: '' };
  const [form, setForm] = useState(empty);
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [collapsedSections, setCollapsedSections] = useState({});
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('domain');
  const [sort, setSort] = useState({ key: 'host', dir: 'asc' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renderLimits, setRenderLimits] = useState({});

  const sites = config?.parsed?.sites || [];
  const snippets = config?.parsed?.snippets || [];
  const deferredSearch = useDeferredValue(search);
  const query = deferredSearch.trim().toLowerCase();

  const filteredSites = useMemo(() => {
    if (!query) return sites;
    return sites.filter((site) =>
      [
        site.addresses.join(' '),
        site.proxies.map((proxy) => proxy.upstreams.join(' ')).join(' '),
        site.imports.map((i) => i.name).join(' '),
        (site.proxies[0]?.imports || []).map((i) => i.name).join(' '),
        rootDomain(site.addresses?.[0]),
        site.description || '',
        (site.tags || []).join(' '),
        site.category || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [query, sites]);

  const groupedEntries = useMemo(() => {
    const sorted = [...filteredSites].sort((a, b) => sortSites(a, b, sort, health));
    const groups = new Map();
    for (const site of sorted) {
      const key = viewMode === 'category' ? (site.category || 'Uncategorized') : rootDomain(site.addresses?.[0]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(site);
    }
    const entries = [...groups.entries()];
    const sortSectionsByKey = (viewMode === 'domain' && sort.key === 'domain') || (viewMode === 'category' && sort.key === 'category');
    if (sortSectionsByKey) {
      entries.sort((a, b) => compareText(a[0], b[0]) * (sort.dir === 'asc' ? 1 : -1));
    } else {
      entries.sort((a, b) => compareText(a[0], b[0]));
    }
    return entries;
  }, [filteredSites, sort, health, viewMode]);

  useEffect(() => {
    const initial = Object.fromEntries(groupedEntries.map(([name]) => [name, 14]));
    setRenderLimits(initial);
    if (!groupedEntries.length) return;
    const timer = setInterval(() => {
      setRenderLimits((current) => {
        let changed = false;
        const next = { ...current };
        for (const [name, items] of groupedEntries) {
          const cur = next[name] || 0;
          if (cur < items.length) {
            next[name] = Math.min(items.length, cur + 18);
            changed = true;
          }
        }
        if (!changed) clearInterval(timer);
        return changed ? next : current;
      });
    }, 80);
    return () => clearInterval(timer);
  }, [groupedEntries]);

  const domains = useMemo(
    () =>
      [...new Set(sites.map((site) => rootDomain(site.addresses?.[0])).filter(Boolean))]
        .sort((a, b) => compareText(a, b)),
    [sites]
  );

  const allTags = useMemo(() => {
    const unique = new Set();
    for (const site of sites) for (const tag of site.tags || []) unique.add(tag);
    return [...unique].sort((a, b) => compareText(a, b));
  }, [sites]);

  const categories = useMemo(() => {
    const unique = new Set();
    for (const site of sites) if (site.category) unique.add(site.category);
    return [...unique].sort((a, b) => compareText(a, b));
  }, [sites]);

  const applyLocal = (content) => {
    setConfig({
      path: config?.path || 'Caddyfile',
      content,
      parsed: parseCaddyfile(content),
      health: config?.health || {},
    });
  };

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = {
        host: form.host,
        upstream: form.upstream,
        description: form.description,
        category: form.category,
        imports: selectedImportNames(form.imports),
        tags: selectedTagNames(form.tags),
        logging: { mode: form.logMode, path: form.logPath },
      };
      if (localTest) {
        applyLocal(appendSimpleProxy(config.content, payload));
        setForm(empty);
        return;
      }
      const data = await api('/api/proxies', { method: 'POST', body: JSON.stringify(payload) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
      onConfigChanged?.('Proxy added.', data.event || null);
      setForm(empty);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError('');
    try {
      if (edit.rawOpen) {
        const nextContent = replaceBlockAtLine(config.content, edit.line, edit.rawBlock);
        if (localTest) {
          applyLocal(nextContent);
          setEdit(null);
          return;
        }
        const data = await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({ content: nextContent, validate: true }),
        });
        setConfig((current) => ({ ...current, content: nextContent, parsed: data.parsed, health: data.health || current.health }));
        onConfigChanged?.('Proxy updated.', data.event || null);
        setEdit(null);
        return;
      }
      const payload = {
        host: edit.host,
        upstream: edit.upstream,
        description: edit.description,
        category: edit.category,
        imports: selectedImportNames(edit.imports),
        tags: selectedTagNames(edit.tags),
        logging: { mode: edit.logMode, path: edit.logPath },
        disabled: Boolean(edit.disabled),
      };
      if (localTest) {
        applyLocal(updateSimpleProxy(config.content, { siteLine: edit.line, ...payload }));
        setEdit(null);
        return;
      }
      const data = await api(`/api/proxies/${edit.line}`, { method: 'PUT', body: JSON.stringify(payload) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
      onConfigChanged?.('Proxy updated.', data.event || null);
      setEdit(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (site) => {
    const names = [...site.imports, ...(site.proxies[0]?.imports || [])].map((item) => item.name);
    const logging = normalizeLogging(site.logging);
    setEdit({
      line: site.line,
      host: site.addresses[0] || '',
      upstream: site.proxies[0]?.upstreams?.join(' ') || '',
      description: site.description || '',
      category: site.category || '',
      tags: (site.tags || []).join(', '),
      imports: [...new Set(names)].join(', '),
      logMode: logging.mode,
      logPath: logging.path,
      disabled: Boolean(site.disabled),
      rawOpen: false,
      rawBlock: readBlockAtLine(config.content, site.line),
    });
  };

  const deleteProxy = async (site) => {
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        const start = site.line - 1;
        let depth = 0;
        let end = start;
        for (let i = start; i < lines.length; i += 1) {
          for (const ch of lines[i]) {
            if (ch === '{') depth += 1;
            if (ch === '}') depth -= 1;
          }
          if (depth === 0) {
            end = i;
            break;
          }
        }
        lines.splice(start, end - start + 1);
        applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
        return;
      }
      const data = await api(`/api/proxies/${site.line}`, { method: 'DELETE' });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
      onConfigChanged?.('Proxy deleted.', data.event || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const toggleDisabled = async (site) => {
    setBusy(true);
    setError('');
    try {
      const disabled = !site.disabled;
      if (localTest) {
        applyLocal(setProxyDisabled(config.content, { siteLine: site.line, disabled }));
        return;
      }
      const data = await api(`/api/proxies/${site.line}/disabled`, { method: 'POST', body: JSON.stringify({ disabled }) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
      onConfigChanged?.(disabled ? 'Proxy disabled.' : 'Proxy enabled.', data.event || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSort = (key) => {
    setSort((current) => (current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  const sortArrow = (key) => (sort.key !== key ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼');
  const sectionLabel = viewMode === 'category' ? 'category' : 'domain';

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Proxies</h2>
          <p>Grouped by {sectionLabel}.</p>
        </div>
        <div className="toolbar">
          <label>
            View
            <select value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
              <option value="domain">Sections by domain</option>
              <option value="category">Sections by category</option>
            </select>
          </label>
          <button onClick={refresh}><RefreshCw size={16} /> Refresh</button>
        </div>
      </div>

      <StatCards parsed={config?.parsed} />

      {loading && (
        <div className="proxy-loading">
          <div className="proxy-row-skeleton"><span /><span /><span /><span /><span /><span /><span /><span /></div>
          <div className="proxy-row-skeleton"><span /><span /><span /><span /><span /><span /><span /><span /></div>
          <div className="proxy-row-skeleton"><span /><span /><span /><span /><span /><span /><span /><span /></div>
        </div>
      )}

      <div className="proxy-search">
        <input placeholder="Search proxies" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span>{filteredSites.length} shown</span>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      {canEdit && (
        <form className="quick-add" onSubmit={add}>
          <input list="proxy-domain-suggestions" placeholder="new.example.com" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
          <datalist id="proxy-domain-suggestions">
            {domains.flatMap((domain) => [`caddyui.${domain}`, `app.${domain}`, domain]).map((host) => <option key={host} value={host} />)}
          </datalist>
          <input placeholder="http://10.0.0.10:3000" value={form.upstream} onChange={(e) => setForm({ ...form, upstream: e.target.value })} />
          <input className="proxy-description-input" placeholder="short description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <AutoCompleteInput
            value={form.category}
            placeholder="category"
            suggestions={categories}
            onChange={(next) => setForm({ ...form, category: next })}
          />
          <TagAutoCompleteInput
            value={form.tags}
            placeholder="tags: prod, internal"
            suggestions={allTags}
            onChange={(next) => setForm({ ...form, tags: next })}
          />
          <select value={form.logMode} onChange={(e) => setForm({ ...form, logMode: e.target.value })}>
            <option value="none">No access log</option>
            <option value="default">Default log</option>
            <option value="stdout">Log to stdout</option>
            <option value="stderr">Log to stderr</option>
            <option value="file">Log to file</option>
          </select>
          {form.logMode === 'file' && <input placeholder="/var/log/caddy/site.access.log" value={form.logPath} onChange={(e) => setForm({ ...form, logPath: e.target.value })} />}
          <button className="primary" disabled={busy}>{busy ? <Loader2 className="spin" /> : <Wand2 size={16} />}Add proxy</button>
          <MiddlewarePicker snippets={snippets} value={form.imports} onChange={(imports) => setForm({ ...form, imports })} />
        </form>
      )}

      {edit && (
        <div className="modal-backdrop" onMouseDown={() => setEdit(null)}>
          <form className="edit-modal proxy-edit-modal" onSubmit={saveEdit} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit proxy</h3>
              <button type="button" onClick={() => setEdit(null)}>Close</button>
            </div>
            <div className="proxy-edit-layout">
              <section className="proxy-edit-card">
                <h4>Connection</h4>
                <label>
                  Host
                  <input value={edit.host} onChange={(e) => { const next = { ...edit, host: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} />
                </label>
                <label>
                  Upstream
                  <input value={edit.upstream} onChange={(e) => { const next = { ...edit, upstream: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} />
                </label>
                <label>
                  Description
                  <textarea rows="3" value={edit.description} onChange={(e) => { const next = { ...edit, description: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} placeholder="What this proxy is for" />
                </label>
              </section>
              <section className="proxy-edit-card">
                <h4>Organization</h4>
                <label>
                  Category
                  <AutoCompleteInput
                    value={edit.category}
                    suggestions={categories}
                    onChange={(value) => {
                      const next = { ...edit, category: value };
                      if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                      setEdit(next);
                    }}
                  />
                </label>
                <label>
                  Tags
                  <TagAutoCompleteInput
                    value={edit.tags}
                    placeholder="prod, internal"
                    suggestions={allTags}
                    onChange={(value) => {
                      const next = { ...edit, tags: value };
                      if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                      setEdit(next);
                    }}
                  />
                </label>
                <div className="proxy-edit-card proxy-edit-card-compact">
                  <h4>Middleware</h4>
                  <MiddlewarePicker snippets={snippets} value={edit.imports} onChange={(imports) => { const next = { ...edit, imports }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} />
                </div>
              </section>
              <section className="proxy-edit-card">
                <h4>Logging</h4>
                <label>
                  Logging
                  <select value={edit.logMode} onChange={(e) => { const next = { ...edit, logMode: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }}>
                    <option value="none">No access log</option>
                    <option value="default">Default log</option>
                    <option value="stdout">Log to stdout</option>
                    <option value="stderr">Log to stderr</option>
                    <option value="file">Log to file</option>
                  </select>
                </label>
                {edit.logMode === 'file' && (
                  <label>
                    Log file
                    <input value={edit.logPath} onChange={(e) => { const next = { ...edit, logPath: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} />
                  </label>
                )}
              </section>
            </div>
            <button type="button" className="expand-toggle" onClick={() => { const nextOpen = !edit.rawOpen; const next = { ...edit, rawOpen: nextOpen }; if (nextOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }}>
              {edit.rawOpen ? 'Hide raw config' : 'Edit raw config'}
            </button>
            {edit.rawOpen && (
              <div className="raw-proxy-editor">
                <Editor height="360px" defaultLanguage="caddyfile" theme={theme === 'light' ? 'light' : 'vs-dark'} value={edit.rawBlock} onChange={(value) => setEdit({ ...edit, rawBlock: value || '' })} options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }} />
              </div>
            )}
            <div className="toolbar">
              <button className="primary" disabled={busy}>Save</button>
              <button type="button" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmModal confirm={confirmDelete} onCancel={() => setConfirmDelete(null)} onConfirm={() => confirmDelete?.action()} />

      <div className="proxy-list">
        {groupedEntries.map(([groupName, items]) => {
          const sectionKey = `${viewMode}:${groupName}`;
          return (
            <details
              className="proxy-group"
              key={sectionKey}
              open={!collapsedSections[sectionKey]}
              onToggle={(e) => {
                const isOpen = e.currentTarget?.open ?? true;
                setCollapsedSections((current) => ({ ...current, [sectionKey]: !isOpen }));
              }}
            >
              <summary className="proxy-group-head">
                <h3>{groupName}</h3>
                <span>{items.length} entries</span>
              </summary>
              <div className="proxy-table-head">
                <button type="button" className={`table-sort ${sort.key === 'host' ? 'active' : ''}`} onClick={() => toggleSort('host')}>Host{sortArrow('host')}</button>
                <button type="button" className={`table-sort ${sort.key === 'upstream' ? 'active' : ''}`} onClick={() => toggleSort('upstream')}>Upstream{sortArrow('upstream')}</button>
                <button type="button" className={`table-sort ${sort.key === 'local' ? 'active' : ''}`} onClick={() => toggleSort('local')}>Local{sortArrow('local')}</button>
                <span>State</span>
                <button type="button" className={`table-sort ${sort.key === 'category' ? 'active' : ''}`} onClick={() => toggleSort('category')}>Category{sortArrow('category')}</button>
                <button type="button" className={`table-sort ${sort.key === 'tags' ? 'active' : ''}`} onClick={() => toggleSort('tags')}>Tags{sortArrow('tags')}</button>
                <button type="button" className={`table-sort ${sort.key === 'imports' ? 'active' : ''}`} onClick={() => toggleSort('imports')}>Imports{sortArrow('imports')}</button>
                <span>Actions</span>
              </div>
              {items.slice(0, renderLimits[groupName] || 0).map((site) => (
                <ProxyRow
                  key={site.id}
                  site={site}
                  healthCheck={health?.[site.id]?.local}
                  canEdit={canEdit}
                  onToggleDisabled={() => toggleDisabled(site)}
                  onEdit={() => startEdit(site)}
                  onDelete={(e) => setConfirmDelete(deleteConfirm(e, 'Delete proxy', site.addresses[0], () => deleteProxy(site)))}
                />
              ))}
              {(renderLimits[groupName] || 0) < items.length && <div className="proxy-row-skeleton"><span /><span /><span /><span /><span /><span /><span /><span /></div>}
            </details>
          );
        })}
      </div>
    </section>
  );
}
