import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Loader2, RefreshCw, Wand2 } from 'lucide-react';
import { appendSimpleProxy, parseCaddyfile, updateSimpleProxy } from '../../server/caddyParser.js';
import { ConfirmModal, MiddlewarePicker, Notice, ProxyRow, StatCards, deleteConfirm, normalizeLogging, previewProxyBlock, readBlockAtLine, replaceBlockAtLine, rootDomain, selectedImportNames } from '../components/common.jsx';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

export default function Proxies({ config, refresh, setConfig, canEdit, theme, health, loading, api }) {
  const empty = { host: '', upstream: '', imports: '', logMode: 'none', logPath: '' };
  const [form, setForm] = useState(empty);
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [collapsedDomains, setCollapsedDomains] = useState({});
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renderLimits, setRenderLimits] = useState({});

  const sites = config?.parsed?.sites || [];
  const snippets = config?.parsed?.snippets || [];
  const deferredSearch = useDeferredValue(search);
  const query = deferredSearch.trim().toLowerCase();
  const filteredSites = useMemo(() => query ? sites.filter((site) => [site.addresses.join(' '), site.proxies.map((proxy) => proxy.upstreams.join(' ')).join(' '), site.imports.map((i) => i.name).join(' '), (site.proxies[0]?.imports || []).map((i) => i.name).join(' '), rootDomain(site.addresses?.[0])].join(' ').toLowerCase().includes(query)) : sites, [query, sites]);
  const groups = useMemo(() => filteredSites.reduce((acc, site) => { const key = rootDomain(site.addresses?.[0]); (acc[key] ||= []).push(site); return acc; }, {}), [filteredSites]);
  useEffect(() => {
    const domainEntries = Object.entries(groups);
    const initial = Object.fromEntries(domainEntries.map(([domain]) => [domain, 14]));
    setRenderLimits(initial);
    if (!domainEntries.length) return;
    const timer = setInterval(() => {
      setRenderLimits((current) => {
        let changed = false;
        const next = { ...current };
        for (const [domain, items] of domainEntries) {
          const cur = next[domain] || 0;
          if (cur < items.length) { next[domain] = Math.min(items.length, cur + 18); changed = true; }
        }
        if (!changed) clearInterval(timer);
        return changed ? next : current;
      });
    }, 80);
    return () => clearInterval(timer);
  }, [groups]);
  const domains = useMemo(() => [...new Set(sites.map((site) => rootDomain(site.addresses?.[0])).filter(Boolean))].sort(), [sites]);

  const applyLocal = (content) => setConfig({ path: config?.path || 'Caddyfile', content, parsed: parseCaddyfile(content), health: config?.health || {} });

  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (localTest) { applyLocal(appendSimpleProxy(config.content, { host: form.host, upstream: form.upstream, imports: selectedImportNames(form.imports), logging: { mode: form.logMode, path: form.logPath } })); setForm(empty); return; }
      const data = await api('/api/proxies', { method: 'POST', body: JSON.stringify({ host: form.host, upstream: form.upstream, imports: selectedImportNames(form.imports), logging: { mode: form.logMode, path: form.logPath } }) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
      setForm(empty);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const saveEdit = async (e) => {
    e.preventDefault(); if (!edit) return;
    setBusy(true); setError('');
    try {
      if (edit.rawOpen) {
        const nextContent = replaceBlockAtLine(config.content, edit.line, edit.rawBlock);
        if (localTest) { applyLocal(nextContent); setEdit(null); return; }
        const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ content: nextContent, validate: true }) });
        setConfig((current) => ({ ...current, content: nextContent, parsed: data.parsed, health: data.health || current.health }));
        setEdit(null); return;
      }
      if (localTest) { applyLocal(updateSimpleProxy(config.content, { siteLine: edit.line, host: edit.host, upstream: edit.upstream, imports: selectedImportNames(edit.imports), logging: { mode: edit.logMode, path: edit.logPath } })); setEdit(null); return; }
      const data = await api(`/api/proxies/${edit.line}`, { method: 'PUT', body: JSON.stringify({ host: edit.host, upstream: edit.upstream, imports: selectedImportNames(edit.imports), logging: { mode: edit.logMode, path: edit.logPath } }) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
      setEdit(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const startEdit = (site) => {
    const names = [...site.imports, ...(site.proxies[0]?.imports || [])].map((item) => item.name);
    const logging = normalizeLogging(site.logging);
    setEdit({ line: site.line, host: site.addresses[0] || '', upstream: site.proxies[0]?.upstreams?.join(' ') || '', imports: [...new Set(names)].join(', '), logMode: logging.mode, logPath: logging.path, rawOpen: false, rawBlock: readBlockAtLine(config.content, site.line) });
  };

  const deleteProxy = async (site) => {
    setBusy(true); setError('');
    try {
      if (localTest) {
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        const start = site.line - 1;
        let depth = 0; let end = start;
        for (let i = start; i < lines.length; i += 1) { for (const ch of lines[i]) { if (ch === '{') depth += 1; if (ch === '}') depth -= 1; } if (depth === 0) { end = i; break; } }
        lines.splice(start, end - start + 1);
        applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
        return;
      }
      const data = await api(`/api/proxies/${site.line}`, { method: 'DELETE' });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
    } catch (err) { setError(err.message); } finally { setBusy(false); setConfirmDelete(null); }
  };

  return <section><div className="section-head"><div><h2>Proxies</h2><p>Grouped by domain.</p></div><div className="toolbar"><button onClick={refresh}><RefreshCw size={16} /> Refresh</button></div></div><StatCards parsed={config?.parsed} />{loading && <div className="proxy-loading"><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div></div>}{result && <Notice type={result.ok ? 'success' : 'error'}>{result.ok ? result.stdout || 'Command succeeded' : result.stderr || 'Command failed'}</Notice>}<div className="proxy-search"><input placeholder="Search proxies" value={search} onChange={(e) => setSearch(e.target.value)} /><span>{filteredSites.length} shown</span></div>{error && <Notice type="error">{error}</Notice>}{canEdit && <form className="quick-add" onSubmit={add}><input list="proxy-domain-suggestions" placeholder="new.example.com" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /><datalist id="proxy-domain-suggestions">{domains.flatMap((domain) => [`caddyui.${domain}`, `app.${domain}`, domain]).map((host) => <option key={host} value={host} />)}</datalist><input placeholder="http://10.0.0.10:3000" value={form.upstream} onChange={(e) => setForm({ ...form, upstream: e.target.value })} /><select value={form.logMode} onChange={(e) => setForm({ ...form, logMode: e.target.value })}><option value="none">No access log</option><option value="default">Default log</option><option value="stdout">Log to stdout</option><option value="stderr">Log to stderr</option><option value="file">Log to file</option></select>{form.logMode === 'file' && <input placeholder="/var/log/caddy/site.access.log" value={form.logPath} onChange={(e) => setForm({ ...form, logPath: e.target.value })} />}<button className="primary" disabled={busy}>{busy ? <Loader2 className="spin" /> : <Wand2 size={16} />}Add proxy</button><MiddlewarePicker snippets={snippets} value={form.imports} onChange={(imports) => setForm({ ...form, imports })} /></form>}{edit && <div className="modal-backdrop" onMouseDown={() => setEdit(null)}><form className="edit-modal" onSubmit={saveEdit} onMouseDown={(e) => e.stopPropagation()}><div className="modal-head"><h3>Edit proxy</h3><button type="button" onClick={() => setEdit(null)}>Close</button></div><label>Host<input value={edit.host} onChange={(e) => { const next = { ...edit, host: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} /></label><label>Upstream<input value={edit.upstream} onChange={(e) => { const next = { ...edit, upstream: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} /></label><label>Logging<select value={edit.logMode} onChange={(e) => { const next = { ...edit, logMode: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }}><option value="none">No access log</option><option value="default">Default log</option><option value="stdout">Log to stdout</option><option value="stderr">Log to stderr</option><option value="file">Log to file</option></select></label>{edit.logMode === 'file' && <label>Log file<input value={edit.logPath} onChange={(e) => { const next = { ...edit, logPath: e.target.value }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} /></label>}<MiddlewarePicker snippets={snippets} value={edit.imports} onChange={(imports) => { const next = { ...edit, imports }; if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }} /><button type="button" className="expand-toggle" onClick={() => { const nextOpen = !edit.rawOpen; const next = { ...edit, rawOpen: nextOpen }; if (nextOpen) next.rawBlock = previewProxyBlock(config.content, next); setEdit(next); }}>{edit.rawOpen ? 'Hide raw config' : 'Edit raw config'}</button>{edit.rawOpen && <div className="raw-proxy-editor"><Editor height="360px" defaultLanguage="caddyfile" theme={theme === 'light' ? 'light' : 'vs-dark'} value={edit.rawBlock} onChange={(value) => setEdit({ ...edit, rawBlock: value || '' })} options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }} /></div>}<div className="toolbar"><button className="primary" disabled={busy}>Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div></form></div>}<ConfirmModal confirm={confirmDelete} onCancel={() => setConfirmDelete(null)} onConfirm={() => confirmDelete?.action()} /><div className="proxy-list">{Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([domain, items]) => <details className="proxy-group" key={domain} open={!collapsedDomains[domain]} onToggle={(e) => { const isOpen = e.currentTarget?.open ?? true; setCollapsedDomains((current) => ({ ...current, [domain]: !isOpen })); }}><summary className="proxy-group-head"><h3>{domain}</h3><span>{items.length} entries</span></summary><div className="proxy-table-head"><span>Host</span><span>Upstream</span><span>Local</span><span>Middlewares</span><span>Actions</span></div>{items.slice(0, renderLimits[domain] || 0).map((site) => <ProxyRow key={site.id} site={site} healthCheck={health?.[site.id]?.local} canEdit={canEdit} onEdit={() => startEdit(site)} onDelete={(e) => setConfirmDelete(deleteConfirm(e, 'Delete proxy', site.addresses[0], () => deleteProxy(site)))} />)}{(renderLimits[domain] || 0) < items.length && <div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div>}</details>)}</div></section>;
}
