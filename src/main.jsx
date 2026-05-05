import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import { AlertTriangle, CheckCircle2, FileCode2, KeyRound, Layers3, Loader2, Menu, RefreshCw, Save, ScrollText, ServerCog, Settings, Shield, SidebarClose, Wand2 } from 'lucide-react';
import { parseCaddyfile } from '../server/caddyParser.js';
import './styles.css';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';
const emptyConfig = { path: 'Caddyfile', content: '', parsed: parseCaddyfile(''), health: {} };
const localSettings = { userConfigured: true, caddyConfigured: true, configured: true, caddyfilePath: 'Caddyfile', logPaths: ['/var/log/caddy/access.log'], username: 'local' };

const api = async (path, options = {}) => {
  const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.stderr || `Request failed: ${res.status}`);
  return data;
};
const pageItems = [
  ['proxies', ServerCog, 'Proxies'],
  ['middlewares', Layers3, 'Middlewares'],
  ['configuration', FileCode2, 'Configuration'],
  ['logs', ScrollText, 'Logs'],
  ['settings', Settings, 'Settings'],
];
function Notice({ type = 'info', children }) { return <div className={`notice ${type}`}>{type === 'error' ? <AlertTriangle size={18}/> : <CheckCircle2 size={18}/>}<span>{children}</span></div>; }
function Shell({ children, page, setPage, collapsed, setCollapsed, user, onLogout, theme, setTheme }) {
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><button className="icon-button" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <Menu/> : <SidebarClose/>}</button><span className="logo">CaddyUI</span></div><div className="top-actions"><span className="pill"><Shield size={14}/>{user || 'admin'}</span><button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'Dark' : 'Light'}</button><button onClick={onLogout}>Logout</button></div></header>
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>{pageItems.map(([id, Icon, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon size={20}/><span>{label}</span></button>)}</aside>
    <main className={`content ${collapsed ? 'wide' : ''}`}>{children}</main>
  </div>;
}
function AuthGate({ status, onReady }) {
  const needsUser = !status?.settings?.userConfigured;
  const needsLogin = status?.settings?.userConfigured && !status?.authenticated;
  const needsConfig = status?.settings?.userConfigured && status?.authenticated && !status?.settings?.caddyConfigured;
  const discovered = status?.discovered || { caddyfiles: [], logfiles: [] };
  const [userForm, setUserForm] = useState({ username: 'admin', password: '', setupToken: '' });
  const [configForm, setConfigForm] = useState({ caddyfilePath: discovered.caddyfiles?.[0]?.path || '', logPaths: (discovered.logfiles || []).map(f => f.path).join('\n') });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitUser = async (e) => { e.preventDefault(); setBusy(true); setError(''); try {
    const path = needsLogin ? '/api/login' : '/api/setup/user';
    const payload = needsLogin ? { username: userForm.username, password: userForm.password } : userForm;
    const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    onReady(data);
  } catch (err) { setError(err.message); } finally { setBusy(false); } };

  const submitConfig = async (e) => { e.preventDefault(); setBusy(true); setError(''); try {
    const data = await api('/api/setup/config', { method: 'POST', body: JSON.stringify({ caddyfilePath: configForm.caddyfilePath, logPaths: configForm.logPaths.split('\n').map(x => x.trim()).filter(Boolean) }) });
    onReady(data);
  } catch (err) { setError(err.message); } finally { setBusy(false); } };

  if (needsConfig) return <div className="auth-page"><form className="auth-card" onSubmit={submitConfig}><h1>CaddyUI</h1><p>Admin user created. Now choose the Caddyfile and log files CaddyUI should manage.</p>{error && <Notice type="error">{error}</Notice>}
    <label>Caddyfile path<input value={configForm.caddyfilePath} onChange={e => setConfigForm({...configForm, caddyfilePath:e.target.value})}/></label>
    {discovered.caddyfiles?.length > 0 && <div className="discover"><b>Discovered Caddyfiles</b>{discovered.caddyfiles.map(f => <button type="button" key={f.path} onClick={() => setConfigForm({...configForm, caddyfilePath:f.path})}>{f.path}</button>)}</div>}
    <label>Log paths, one per line<textarea rows="5" value={configForm.logPaths} placeholder="/var/log/caddy/access.log" onChange={e => setConfigForm({...configForm, logPaths:e.target.value})}/></label>
    {discovered.logfiles?.length > 0 && <div className="discover"><b>Discovered log files</b>{discovered.logfiles.map(f => <button type="button" key={f.path} onClick={() => { const lines = new Set(configForm.logPaths.split('\n').map(x => x.trim()).filter(Boolean)); lines.add(f.path); setConfigForm({...configForm, logPaths:[...lines].join('\n')}); }}>{f.path}</button>)}</div>}
    <button className="primary" disabled={busy}>{busy ? <Loader2 className="spin"/> : <FileCode2 size={16}/>}Save Caddy configuration</button></form></div>;

  return <div className="auth-page"><form className="auth-card" onSubmit={submitUser}><h1>CaddyUI</h1><p>{needsLogin ? 'Sign in to continue setup or manage your Caddyfile.' : 'First create the admin user. Caddy configuration is selected in the next step.'}</p>{error && <Notice type="error">{error}</Notice>}
    <label>Username<input value={userForm.username} onChange={e => setUserForm({...userForm, username:e.target.value})}/></label><label>Password<input type="password" minLength={8} value={userForm.password} onChange={e => setUserForm({...userForm, password:e.target.value})}/></label>{!needsLogin && status?.settings?.setupTokenRequired && <label>Setup token<input value={userForm.setupToken} onChange={e => setUserForm({...userForm, setupToken:e.target.value})}/></label>}
    <button className="primary" disabled={busy}>{busy ? <Loader2 className="spin"/> : <KeyRound size={16}/>}{needsLogin ? 'Login' : 'Create admin account'}</button></form></div>;
}

function ConfirmModal({ confirm, onCancel, onConfirm }) {
  if (!confirm) return null;
  return <div className="confirm-layer" onMouseDown={onCancel}><div className="confirm-popover" style={{ left: confirm.x, top: confirm.y }} onMouseDown={e=>e.stopPropagation()}><h3>{confirm.title}</h3><p>{confirm.message}</p><div className="confirm-actions"><button className="danger" onClick={onConfirm}>Delete</button><button onClick={onCancel}>Cancel</button></div></div></div>;
}
const deleteConfirm = (event, title, message, action) => { const rect = event.currentTarget.getBoundingClientRect(); return { title, message, action, x: Math.min(rect.left, window.innerWidth - 430), y: Math.min(rect.bottom + 8, window.innerHeight - 170) }; };

function StatCards({ parsed }) { const stats = parsed?.summary || {}; return <div className="stats"><div><b>{stats.sites || 0}</b><span>Sites</span></div><div><b>{stats.proxies || 0}</b><span>Reverse proxies</span></div><div><b>{stats.snippets || 0}</b><span>Snippets</span></div><div><b>{stats.middleware || 0}</b><span>Imports used</span></div></div>; }
const rootDomain = (address = '') => {
  const host = address.replace(/^https?:\/\//, '').replace(/:.*/, '').trim();
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : host || 'Other';
};
const selectedImportNames = (form) => form.imports.split(',').map(x => x.trim()).filter(Boolean);
function MiddlewarePicker({ snippets, value, onChange }) {
  const selected = new Set(selectedImportNames({ imports: value }));
  const toggle = (name) => {
    const next = new Set(selected);
    next.has(name) ? next.delete(name) : next.add(name);
    onChange([...next].join(', '));
  };
  if (!snippets.length) return null;
  return <div className="middleware-picker">{snippets.map(s => <button type="button" key={s.name} className={selected.has(s.name) ? 'selected' : ''} onClick={() => toggle(s.name)}>{s.name}<span>{s.inferredType}</span></button>)}</div>;
}
const StatusDot = ({ check }) => <span className={`status-dot ${check?.online ? 'online' : 'offline'}`}>{check?.online ? 'online' : 'offline'}</span>;
function Proxies({ config, refresh, setConfig }) {
  const empty = { host: '', upstream: '', imports: '' };
  const [form, setForm] = useState(empty); const [edit, setEdit] = useState(null); const [confirmDelete, setConfirmDelete] = useState(null); const [search, setSearch] = useState(''); const [result, setResult] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const sites = config?.parsed?.sites || [];
  const snippets = config?.parsed?.snippets || [];
  const query = search.trim().toLowerCase();
  const filteredSites = query ? sites.filter(site => [site.addresses.join(' '), site.proxies.map(p=>p.upstreams.join(' ')).join(' '), site.imports.map(i=>i.name).join(' '), rootDomain(site.addresses?.[0]), `${site.line}-${site.endLine}`].join(' ').toLowerCase().includes(query)) : sites;
  const groups = filteredSites.reduce((acc, site) => { const key = rootDomain(site.addresses?.[0]); (acc[key] ||= []).push(site); return acc; }, {});
  const domains = [...new Set(sites.map(site => rootDomain(site.addresses?.[0])).filter(Boolean))].sort();
  const applyLocal = (content) => setConfig({ path: config?.path || 'Caddyfile', content, parsed: parseCaddyfile(content) });
  const add = async (e) => { e.preventDefault(); setBusy(true); setError(''); try { if(localTest){ const next = `${config.content.trimEnd()}\n\n${form.host} {\n${selectedImportNames(form).map(i=>`\timport ${i}`).join('\n')}${form.imports ? '\n' : ''}\treverse_proxy ${form.upstream}\n}\n`; applyLocal(next); setForm(empty); return; } const data = await api('/api/proxies', { method: 'POST', body: JSON.stringify({ host: form.host, upstream: form.upstream, imports: selectedImportNames(form) })}); setConfig(c => ({...c, content:data.content, parsed:data.parsed})); setForm(empty); } catch(err){ setError(err.message); } finally{ setBusy(false); } };
  const saveEdit = async (e) => { e.preventDefault(); if(!edit) return; setBusy(true); setError(''); try { if(localTest){ const lines = config.content.replace(/\r\n/g, '\n').split('\n'); const start = edit.line - 1; let depth = 0; let end = start; for(let i=start;i<lines.length;i++){ for(const ch of lines[i]){ if(ch==='{') depth++; if(ch==='}') depth--; } if(depth===0){ end=i; break; } } const block = `${edit.host} {\n${selectedImportNames(edit).map(i=>`\timport ${i}`).join('\n')}${edit.imports ? '\n' : ''}\treverse_proxy ${edit.upstream}\n}`.split('\n'); lines.splice(start, end - start + 1, ...block); applyLocal(lines.join('\n')); setEdit(null); return; } const data = await api(`/api/proxies/${edit.line}`, { method:'PUT', body:JSON.stringify({ host:edit.host, upstream:edit.upstream, imports:selectedImportNames(edit) })}); setConfig(c=>({...c, content:data.content, parsed:data.parsed})); setEdit(null); } catch(err){ setError(err.message); } finally{ setBusy(false); } };
  const startEdit = (site) => { const names = [...site.imports, ...(site.proxies[0]?.imports || [])].map(i=>i.name); setEdit({ line: site.line, host: site.addresses[0] || '', upstream: site.proxies[0]?.upstreams?.join(' ') || '', imports: [...new Set(names)].join(', ') }); };
  const validateConfig = async () => { if(localTest){ setResult({ok:true, stdout:'Local test mode'}); return; } setBusy(true); setResult(null); try { setResult(await api('/api/config/validate', { method:'POST', body:JSON.stringify({content:config?.content || ''}) })); } catch(err){ setResult({ok:false, stderr:err.message}); } finally{ setBusy(false); } };
  const reloadCaddy = async () => { if(localTest){ setResult({ok:true, stdout:'Local test mode'}); return; } setBusy(true); setResult(null); try { setResult(await api('/api/config/reload', { method:'POST' })); } catch(err){ setResult({ok:false, stderr:err.message}); } finally{ setBusy(false); } };
  const deleteProxy = async (site) => { setBusy(true); setError(''); try { if(localTest){ const lines = config.content.replace(/\r\n/g, '\n').split('\n'); const start = site.line - 1; let depth = 0; let end = start; for(let i=start;i<lines.length;i++){ for(const ch of lines[i]){ if(ch==='{') depth++; if(ch==='}') depth--; } if(depth===0){ end=i; break; } } lines.splice(start, end - start + 1); applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n')); return; } const data = await api(`/api/proxies/${site.line}`, { method:'DELETE' }); setConfig(c=>({...c, content:data.content, parsed:data.parsed})); } catch(err){ setError(err.message); } finally{ setBusy(false); setConfirmDelete(null); } };
  return <section><div className="section-head"><div><h2>Proxies</h2><p>Grouped by domain.</p></div><button onClick={refresh}><RefreshCw size={16}/> Refresh</button></div><StatCards parsed={config?.parsed}/><div className="proxy-search"><input placeholder="Search proxies" value={search} onChange={e=>setSearch(e.target.value)}/><span>{filteredSites.length} shown</span></div>{error && <Notice type="error">{error}</Notice>}<form className="quick-add" onSubmit={add}><input list="proxy-domain-suggestions" placeholder="new.example.com" value={form.host} onChange={e=>setForm({...form,host:e.target.value})}/><datalist id="proxy-domain-suggestions">{domains.flatMap(domain => [`caddyui.${domain}`, `app.${domain}`, domain]).map(host => <option key={host} value={host}/>)}</datalist><input placeholder="http://10.0.0.10:3000" value={form.upstream} onChange={e=>setForm({...form,upstream:e.target.value})}/><input placeholder="imports" value={form.imports} onChange={e=>setForm({...form,imports:e.target.value})}/><button className="primary" disabled={busy}>{busy ? <Loader2 className="spin"/> : <Wand2 size={16}/>}Add proxy</button><MiddlewarePicker snippets={snippets} value={form.imports} onChange={imports=>setForm({...form,imports})}/></form>{edit && <div className="modal-backdrop" onMouseDown={()=>setEdit(null)}><form className="edit-modal" onSubmit={saveEdit} onMouseDown={e=>e.stopPropagation()}><div className="modal-head"><h3>Edit proxy</h3><button type="button" onClick={()=>setEdit(null)}>Close</button></div><label>Host<input value={edit.host} onChange={e=>setEdit({...edit,host:e.target.value})}/></label><label>Upstream<input value={edit.upstream} onChange={e=>setEdit({...edit,upstream:e.target.value})}/></label><label>Middlewares<input value={edit.imports} onChange={e=>setEdit({...edit,imports:e.target.value})}/></label><MiddlewarePicker snippets={snippets} value={edit.imports} onChange={imports=>setEdit({...edit,imports})}/><div className="toolbar"><button className="primary" disabled={busy}>Save</button><button type="button" onClick={()=>setEdit(null)}>Cancel</button></div></form></div>}<ConfirmModal confirm={confirmDelete} onCancel={()=>setConfirmDelete(null)} onConfirm={()=>confirmDelete?.action()}/><div className="proxy-list">{Object.entries(groups).sort(([a],[b]) => a.localeCompare(b)).map(([domain, items]) => <div className="proxy-group" key={domain}><div className="proxy-group-head"><h3>{domain}</h3><span>{items.length} entries</span></div><div className="proxy-table-head"><span>Host</span><span>Upstream</span><span>Local</span><span>Domain</span><span>Middlewares</span><span>Lines</span><span>Actions</span></div>{items.map(site => <div className="proxy-row" key={site.id}><div className="proxy-row-main"><span className="proxy-host">{site.addresses.join(', ')}</span><span className="proxy-target">{site.proxies[0]?.upstreams?.join(' ') || 'no upstream'}</span><StatusDot check={config?.health?.[site.id]?.local}/><StatusDot check={config?.health?.[site.id]?.domain}/><span className="proxy-mw">{site.imports.map(i=>i.name).join(', ') || 'none'}</span><span className="proxy-lines">{site.line}-{site.endLine}</span><div className="row-actions"><button type="button" onClick={()=>startEdit(site)}>Edit</button><button type="button" className="danger" onClick={(e)=>setConfirmDelete(deleteConfirm(e, 'Delete proxy', site.addresses[0], ()=>deleteProxy(site)))}>Delete</button></div></div></div>)}</div>)}</div></section>;
}
function Middlewares({ config, setConfig }) {
  const snippets = config?.parsed?.snippets || [];
  const empty = { name: '', body: '' };
  const [edit, setEdit] = useState(null); const [confirmDelete, setConfirmDelete] = useState(null); const [form, setForm] = useState(empty); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const applyLocal = (content) => setConfig({ path: config?.path || 'Caddyfile', content, parsed: parseCaddyfile(content), health: config?.health || {} });
  const add = async (e) => { e.preventDefault(); setBusy(true); setError(''); try { if(localTest){ applyLocal(`${config.content.trimEnd()}\n\n(${form.name}) {\n${form.body.split('\n').filter(Boolean).map(l=>`\t${l.trim()}`).join('\n')}\n}\n`); setForm(empty); return; } const data = await api('/api/middlewares', { method:'POST', body:JSON.stringify(form) }); setConfig(c=>({...c, content:data.content, parsed:data.parsed})); setForm(empty); } catch(err){ setError(err.message); } finally{ setBusy(false); } };
  const save = async (e) => { e.preventDefault(); if(!edit) return; setBusy(true); setError(''); try { if(localTest){ const lines = config.content.replace(/\r\n/g, '\n').split('\n'); const start = edit.line - 1; let depth = 0; let end = start; for(let i=start;i<lines.length;i++){ for(const ch of lines[i]){ if(ch==='{') depth++; if(ch==='}') depth--; } if(depth===0){ end=i; break; } } const block = `(${edit.name}) {\n${edit.body.split('\n').filter(Boolean).map(l=>`\t${l.trim()}`).join('\n')}\n}`.split('\n'); lines.splice(start, end - start + 1, ...block); applyLocal(lines.join('\n')); setEdit(null); return; } const data = await api(`/api/middlewares/${edit.line}`, { method:'PUT', body:JSON.stringify(edit) }); setConfig(c=>({...c, content:data.content, parsed:data.parsed})); setEdit(null); } catch(err){ setError(err.message); } finally{ setBusy(false); } };
  const deleteMiddleware = async (item) => { setBusy(true); setError(''); try { if(localTest){ const lines = config.content.replace(/\r\n/g, '\n').split('\n'); const start = item.line - 1; let depth = 0; let end = start; for(let i=start;i<lines.length;i++){ for(const ch of lines[i]){ if(ch==='{') depth++; if(ch==='}') depth--; } if(depth===0){ end=i; break; } } lines.splice(start, end - start + 1); applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n')); return; } const data = await api(`/api/middlewares/${item.line}`, { method:'DELETE' }); setConfig(c=>({...c, content:data.content, parsed:data.parsed})); } catch(err){ setError(err.message); } finally{ setBusy(false); setConfirmDelete(null); } };
  return <section><div className="section-head"><div><h2>Middlewares</h2><p>Snippets and imports.</p></div></div>{error && <Notice type="error">{error}</Notice>}<form className="middleware-form" onSubmit={add}><input placeholder="name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/><textarea rows="3" placeholder="directives" value={form.body} onChange={e=>setForm({...form,body:e.target.value})}/><button className="primary" disabled={busy}>Add middleware</button></form><div className="middleware-list">{snippets.map(s => <div className="middleware-row" key={s.name}><span className="proxy-host">({s.name})</span><span className="status-dot online">{s.inferredType}</span><span className="proxy-mw">{s.usedBy?.join(', ') || 'unused'}</span><span className="proxy-lines">{s.line}-{s.endLine}</span><div className="row-actions"><button type="button" onClick={()=>setEdit({ line:s.line, name:s.name, body:s.body })}>Edit</button><button type="button" className="danger" onClick={(e)=>setConfirmDelete(deleteConfirm(e, 'Delete middleware', s.name, ()=>deleteMiddleware(s)))}>Delete</button></div></div>)}</div>{edit && <div className="modal-backdrop" onMouseDown={()=>setEdit(null)}><form className="edit-modal" onSubmit={save} onMouseDown={e=>e.stopPropagation()}><div className="modal-head"><h3>Edit middleware</h3><button type="button" onClick={()=>setEdit(null)}>Close</button></div><label>Name<input value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/></label><label>Directives<textarea rows="8" value={edit.body} onChange={e=>setEdit({...edit,body:e.target.value})}/></label><div className="toolbar"><button className="primary" disabled={busy}>Save</button><button type="button" onClick={()=>setEdit(null)}>Cancel</button></div></form></div>}<ConfirmModal confirm={confirmDelete} onCancel={()=>setConfirmDelete(null)} onConfirm={()=>confirmDelete?.action()}/></section>;
}
function Configuration({ config, setConfig, refresh }) {
  const [draft, setDraft] = useState(config?.content || ''); const [result, setResult] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(()=>setDraft(config?.content || ''), [config?.content]);
  const validate = async () => { if(localTest){ setResult({ok:true, stdout:'Local test mode'}); return; } setBusy(true); setResult(null); try { const r = await api('/api/config/validate', { method:'POST', body:JSON.stringify({content:draft})}); setResult(r); } catch(e){ setResult({ok:false, stderr:e.message}); } finally{ setBusy(false); } };
  const save = async () => { if(localTest){ setConfig(c=>({...c, content:draft, parsed:parseCaddyfile(draft)})); setResult({ok:true, stdout:'Saved in browser only'}); return; } setBusy(true); setResult(null); try { const r = await api('/api/config', { method:'POST', body:JSON.stringify({content:draft, validate:true})}); setConfig(c=>({...c, content:draft, parsed:r.parsed})); setResult({ok:true, stdout:`Saved. Backup: ${r.backup}`}); } catch(e){ setResult({ok:false, stderr:e.message}); } finally{ setBusy(false); } };
  const reload = async () => { if(localTest){ setResult({ok:true, stdout:'Local test mode'}); return; } setBusy(true); setResult(null); try { setResult(await api('/api/config/reload', { method:'POST' })); } catch(e){ setResult({ok:false, stderr:e.message}); } finally{ setBusy(false); } };
  return <section><div className="section-head"><div><h2>Configuration editor</h2><p>Monaco editor for the live Caddyfile. Validate before saving and reload Caddy after a successful save.</p></div><div className="toolbar"><button onClick={refresh}>Reload file</button><button onClick={validate} disabled={busy}>Validate</button><button className="primary" onClick={save} disabled={busy}><Save size={16}/>Save</button><button onClick={reload} disabled={busy}>Reload Caddy</button></div></div>{result && <Notice type={result.ok ? 'success' : 'error'}>{result.ok ? (result.stdout || 'Command succeeded') : (result.stderr || 'Command failed')}</Notice>}<div className="editor-wrap"><Editor height="68vh" defaultLanguage="caddyfile" theme="vs-dark" value={draft} onChange={(v)=>setDraft(v || '')} options={{ minimap:{enabled:false}, fontSize:14, wordWrap:'on', scrollBeyondLastLine:false }}/></div></section>;
}
function Logs() { const [logs, setLogs] = useState(localTest ? [{ source: 'local-test', content: 'Local test mode' }] : []); const [busy, setBusy] = useState(false); const load = async()=>{if(localTest) return; setBusy(true); try{setLogs((await api('/api/logs?lines=250')).logs)} finally{setBusy(false)}}; useEffect(()=>{load(); if(localTest) return; const t=setInterval(load, 10000); return()=>clearInterval(t)}, []); return <section><div className="section-head"><div><h2>Logs</h2><p>Auto-refreshes every 10 seconds from configured/common Caddy log paths.</p></div><button onClick={load}>{busy ? <Loader2 className="spin"/> : <RefreshCw size={16}/>}Refresh</button></div>{logs.map(l => <article className="log-card" key={l.source}><h3>{l.source}</h3><pre>{l.content}</pre></article>)}</section>; }
function SettingsPage({ settings, setSettings }) { const [form, setForm] = useState({ caddyfilePath: settings.caddyfilePath || '', logPaths: (settings.logPaths || []).join('\n') }); const [msg, setMsg]=useState(''); const save=async(e)=>{e.preventDefault(); setMsg(''); if(localTest){ setSettings({...settings, caddyfilePath:form.caddyfilePath, logPaths:form.logPaths.split('\n').map(x=>x.trim()).filter(Boolean)}); setMsg('Saved in browser only.'); return; } try{const r=await api('/api/settings',{method:'POST',body:JSON.stringify({caddyfilePath:form.caddyfilePath, logPaths:form.logPaths.split('\n').map(x=>x.trim()).filter(Boolean)})}); setSettings(r.settings); setMsg('Settings saved.');}catch(err){setMsg(err.message)}}; return <section><h2>Settings</h2><form className="settings-form" onSubmit={save}><label>Caddyfile path<input value={form.caddyfilePath} onChange={e=>setForm({...form,caddyfilePath:e.target.value})}/></label><label>Log paths<textarea rows="8" value={form.logPaths} onChange={e=>setForm({...form,logPaths:e.target.value})}/></label><button className="primary">Save settings</button>{msg && <p>{msg}</p>}</form></section>; }
function App() {
  const [status, setStatus] = useState(localTest ? { settings: localSettings, authenticated: true, discovered: { caddyfiles: [], logfiles: [] } } : null); const [settings, setSettings] = useState(localTest ? localSettings : null); const [config, setConfig] = useState(localTest ? emptyConfig : null); const [page, setPage] = useState('proxies'); const [collapsed, setCollapsed] = useState(false); const [theme, setTheme] = useState(localStorage.getItem('caddyui-theme') || 'dark'); const [error, setError] = useState('');
  const refreshConfig = async () => { if(localTest) return; setError(''); try { setConfig(await api('/api/config')); } catch (e) { setError(e.message); } };
  useEffect(()=>{document.documentElement.dataset.theme = theme; localStorage.setItem('caddyui-theme', theme)}, [theme]);
  useEffect(()=>{if(localTest){ fetch('/local-test/Caddyfile').then(r=>r.ok ? r.text() : Promise.reject()).then(content=>{ const parsed=parseCaddyfile(content); const health=Object.fromEntries(parsed.sites.map(site=>[site.id,{local:{online:false},domain:{online:false}}])); setConfig({ path:'Caddyfile', content, parsed, health }) }).catch(()=>{}); return; } api('/api/status').then(s=>{setStatus(s); setSettings(s.settings); if(s.settings.configured) refreshConfig();}).catch(e=>setError(e.message));}, []);
  if (!status) return <div className="loading"><Loader2 className="spin"/> Loading CaddyUI...</div>;
  if (!localTest && (!status.authenticated || !settings?.configured)) return <AuthGate status={status} onReady={(data)=>{setStatus(prev => ({...prev, ...data, settings:data.settings, authenticated:true, discovered:data.discovered || prev?.discovered})); setSettings(data.settings); if(data.settings.configured) refreshConfig();}}/>;
  const logout = async()=>{if(localTest){ location.reload(); return; } await api('/api/logout',{method:'POST'}); location.reload();};
  return <Shell page={page} setPage={setPage} collapsed={collapsed} setCollapsed={setCollapsed} user={settings.username} onLogout={logout} theme={theme} setTheme={setTheme}>{error && <Notice type="error">{error}</Notice>}{page === 'proxies' && <Proxies config={config} refresh={refreshConfig} setConfig={setConfig}/>} {page === 'middlewares' && <Middlewares config={config} setConfig={setConfig}/>} {page === 'configuration' && <Configuration config={config} setConfig={setConfig} refresh={refreshConfig}/>} {page === 'logs' && <Logs/>} {page === 'settings' && <SettingsPage settings={settings} setSettings={setSettings}/>}</Shell>;
}

createRoot(document.getElementById('root')).render(<App />);
