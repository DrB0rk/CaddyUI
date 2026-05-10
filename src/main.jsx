import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  KeyRound,
  Layers3,
  Loader2,
  Menu,
  RefreshCw,
  Save,
  ScrollText,
  ServerCog,
  Settings,
  Shield,
  SidebarClose,
  Wand2,
} from 'lucide-react';
import { appendSimpleProxy, parseCaddyfile, updateSimpleProxy } from '../server/caddyParser.js';
import pkg from '../package.json';
import './styles.css';

const APP_VERSION = pkg.version;
const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';
const emptyConfig = { path: 'Caddyfile', content: '', parsed: parseCaddyfile(''), health: {} };
const localSettings = {
  userConfigured: true,
  caddyConfigured: true,
  configured: true,
  caddyfilePath: 'Caddyfile',
  logPaths: ['/var/log/caddy/access.log'],
  username: 'local',
  role: 'admin',
};

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
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

const canEditRole = (role) => role === 'edit' || role === 'admin';
const canAdminRole = (role) => role === 'admin';

function Notice({ type = 'info', children }) {
  return (
    <div className={`notice ${type}`}>
      {type === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
      <span>{children}</span>
    </div>
  );
}

function Shell({
  children,
  page,
  setPage,
  collapsed,
  setCollapsed,
  user,
  onLogout,
  theme,
  setTheme,
  appInfo,
  onCheckUpdates,
  onRunUpdate,
  canUpdate,
  checkingUpdates,
  updating,
  canEdit,
  onValidateCaddy,
  onConfirmReloadCaddy,
  caddyBusy,
}) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button className="icon-button" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <Menu /> : <SidebarClose />}
          </button>
          <span className="logo">CaddyUI</span>
          <span className="app-version">v{APP_VERSION}</span>
        </div>
        <div className="top-actions">
          <span className="pill">
            <Shield size={14} />
            {user || 'user'}
          </span>
                    {canEdit && (
            <>
              <button onClick={onValidateCaddy} disabled={caddyBusy}>Validate</button>
              <button onClick={onConfirmReloadCaddy} disabled={caddyBusy}>Reload Caddy</button>
            </>
          )}
          <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? 'Dark' : 'Light'}
          </button>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div>
          {pageItems.map(([id, Icon, label]) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-meta">
            <span className="sidebar-version">v{appInfo?.version || APP_VERSION}</span>
            <span className={`sidebar-status ${appInfo?.updateAvailable ? 'update' : 'current'}`}>
              {updating ? 'Updating' : appInfo?.updateAvailable ? 'Update available' : 'Current'}
            </span>
          </div>
          <div className="sidebar-actions">
            <button type="button" onClick={onCheckUpdates} disabled={checkingUpdates || updating}>
              {checkingUpdates ? 'Checking...' : 'Check updates'}
            </button>
            {canUpdate && appInfo?.updateAvailable && (
              <button type="button" className="primary" onClick={onRunUpdate} disabled={updating}>
                {updating ? 'Updating...' : 'Update now'}
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className={`content ${collapsed ? 'wide' : ''}`}>{children}</main>
    </div>
  );
}

function AuthGate({ status, onReady }) {
  const needsUser = !status?.settings?.userConfigured;
  const needsLogin = status?.settings?.userConfigured && !status?.authenticated;
  const needsConfig = status?.settings?.userConfigured && status?.authenticated && !status?.settings?.caddyConfigured;
  const discovered = status?.discovered || { caddyfiles: [], logfiles: [] };
  const [userForm, setUserForm] = useState({ username: '', password: '', setupToken: '' });
  const [configForm, setConfigForm] = useState({
    caddyfilePath: discovered.caddyfiles?.[0]?.path || '',
    logPaths: (discovered.logfiles || []).map((f) => f.path).join('\n'),
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitUser = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const path = needsLogin ? '/api/login' : '/api/setup/user';
      const payload = needsLogin
        ? { username: userForm.username, password: userForm.password }
        : userForm;
      const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
      onReady(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitConfig = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/setup/config', {
        method: 'POST',
        body: JSON.stringify({
          caddyfilePath: configForm.caddyfilePath,
          logPaths: configForm.logPaths
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      });
      onReady(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (needsConfig) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submitConfig}>
          <h1>CaddyUI</h1>
          <p>Admin user created. Choose the Caddyfile and log files.</p>
          {error && <Notice type="error">{error}</Notice>}
          <label>
            Caddyfile path
            <input
              value={configForm.caddyfilePath}
              onChange={(e) => setConfigForm({ ...configForm, caddyfilePath: e.target.value })}
            />
          </label>
          {discovered.caddyfiles?.length > 0 && (
            <div className="discover">
              <b>Discovered Caddyfiles</b>
              {discovered.caddyfiles.map((f) => (
                <button
                  type="button"
                  key={f.path}
                  onClick={() => setConfigForm({ ...configForm, caddyfilePath: f.path })}
                >
                  {f.path}
                </button>
              ))}
            </div>
          )}
          <label>
            Log paths, one per line
            <textarea
              rows="5"
              value={configForm.logPaths}
              placeholder="/var/log/caddy/access.log"
              onChange={(e) => setConfigForm({ ...configForm, logPaths: e.target.value })}
            />
          </label>
          {discovered.logfiles?.length > 0 && (
            <div className="discover">
              <b>Discovered log files</b>
              {discovered.logfiles.map((f) => (
                <button
                  type="button"
                  key={f.path}
                  onClick={() => {
                    const lines = new Set(
                      configForm.logPaths
                        .split('\n')
                        .map((x) => x.trim())
                        .filter(Boolean)
                    );
                    lines.add(f.path);
                    setConfigForm({ ...configForm, logPaths: [...lines].join('\n') });
                  }}
                >
                  {f.path}
                </button>
              ))}
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? <Loader2 className="spin" /> : <FileCode2 size={16} />}
            Save Caddy configuration
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submitUser}>
        <h1>CaddyUI</h1>
        <p>
          {needsLogin
            ? 'Sign in to continue.'
            : 'First create the admin user. Caddy configuration is selected in the next step.'}
        </p>
        {error && <Notice type="error">{error}</Notice>}
        <label>
          Username
          <input
            value={userForm.username}
            onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            minLength={8}
            value={userForm.password}
            onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
          />
        </label>
        {!needsLogin && status?.settings?.setupTokenRequired && (
          <label>
            Setup token
            <input
              value={userForm.setupToken}
              onChange={(e) => setUserForm({ ...userForm, setupToken: e.target.value })}
            />
          </label>
        )}
        <button className="primary" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : <KeyRound size={16} />}
          {needsLogin ? 'Login' : 'Create admin account'}
        </button>
      </form>
    </div>
  );
}

function ConfirmModal({ confirm, onCancel, onConfirm }) {
  if (!confirm) return null;
  return (
    <div className="confirm-layer" onMouseDown={onCancel}>
      <div
        className="confirm-popover"
        style={{ left: confirm.x, top: confirm.y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{confirm.title}</h3>
        <p>{confirm.message}</p>
        <div className="confirm-actions">
          <button className="danger" onClick={onConfirm}>
            Delete
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ReloadConfirmModal({ open, busy, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="edit-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Reload Caddy</h3>
        </div>
        <p>Apply current configuration and reload now?</p>
        <div className="toolbar">
          <button className="primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Reloading...' : 'Reload'}
          </button>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const deleteConfirm = (event, title, message, action) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    title,
    message,
    action,
    x: Math.min(rect.left, window.innerWidth - 430),
    y: Math.min(rect.bottom + 8, window.innerHeight - 170),
  };
};

function StatCards({ parsed }) {
  const stats = parsed?.summary || {};
  return (
    <div className="stats">
      <div>
        <b>{stats.sites || 0}</b>
        <span>Sites</span>
      </div>
      <div>
        <b>{stats.proxies || 0}</b>
        <span>Reverse proxies</span>
      </div>
      <div>
        <b>{stats.snippets || 0}</b>
        <span>Snippets</span>
      </div>
      <div>
        <b>{stats.middleware || 0}</b>
        <span>Imports used</span>
      </div>
    </div>
  );
}

const rootDomain = (address = '') => {
  const host = address.replace(/^https?:\/\//, '').replace(/:.*/, '').trim();
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : host || 'Other';
};

const selectedImportNames = (value) =>
  String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const normalizeLogging = (logging = {}) => ({
  mode: logging?.mode || 'none',
  path: logging?.path || '',
});

const findBlockRange = (content, line) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Number(line) - 1;
  if (start < 0 || start >= lines.length) return null;
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
  return { lines, start, end };
};

const replaceBlockAtLine = (content, line, blockText) => {
  const range = findBlockRange(content, line);
  if (!range) return content;
  range.lines.splice(
    range.start,
    range.end - range.start + 1,
    ...String(blockText || '').replace(/\r\n/g, '\n').split('\n')
  );
  return range.lines.join('\n');
};

const readBlockAtLine = (content, line) => {
  const range = findBlockRange(content, line);
  return range ? range.lines.slice(range.start, range.end + 1).join('\n') : '';
};

const previewProxyBlock = (content, draft) => {
  try {
    const next = updateSimpleProxy(content, {
      siteLine: draft.line,
      host: draft.host,
      upstream: draft.upstream,
      imports: selectedImportNames(draft.imports),
      logging: { mode: draft.logMode, path: draft.logPath },
    });
    return readBlockAtLine(next, draft.line) || draft.rawBlock || '';
  } catch {
    return draft.rawBlock || '';
  }
};

function MiddlewarePicker({ snippets, value, onChange }) {
  const selected = selectedImportNames(value);
  const [open, setOpen] = useState(false);
  if (!snippets.length) return null;
  const toggle = (name) => {
    const set = new Set(selected);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    onChange([...set].join(', '));
  };
  return (
    <div className="import-dropdown">
      <button type="button" className="import-dropdown-trigger" onClick={() => setOpen((v) => !v)}>
        {selected.length ? selected.length + ' selected' : 'Select imports'}
      </button>
      {open && (
        <div className="import-dropdown-menu">
          {snippets.map((s) => (
            <label key={s.name} className="import-option">
              <input
                type="checkbox"
                checked={selected.includes(s.name)}
                onChange={() => toggle(s.name)}
              />
              <span>{s.name}</span>
              <small>{s.inferredType}</small>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const StatusDot = ({ check }) => (
  <span className={`status-dot ${check?.online ? 'online' : 'offline'}`}>
    {check?.online ? 'online' : 'offline'}
  </span>
);

function Proxies({ config, refresh, setConfig, canEdit, theme }) {
  const empty = { host: '', upstream: '', imports: '', logMode: 'none', logPath: '' };
  const [form, setForm] = useState(empty);
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [collapsedDomains, setCollapsedDomains] = useState({});
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const sites = config?.parsed?.sites || [];
  const snippets = config?.parsed?.snippets || [];
  const query = search.trim().toLowerCase();

  const filteredSites = useMemo(
    () =>
      query
        ? sites.filter((site) =>
            [
              site.addresses.join(' '),
              site.proxies.map((proxy) => proxy.upstreams.join(' ')).join(' '),
              site.imports.map((i) => i.name).join(' '),
              (site.proxies[0]?.imports || []).map((i) => i.name).join(' '),
              rootDomain(site.addresses?.[0]),
            ]
              .join(' ')
              .toLowerCase()
              .includes(query)
          )
        : sites,
    [query, sites]
  );

  const groups = useMemo(
    () =>
      filteredSites.reduce((acc, site) => {
        const key = rootDomain(site.addresses?.[0]);
        (acc[key] ||= []).push(site);
        return acc;
      }, {}),
    [filteredSites]
  );

  const domains = useMemo(
    () => [...new Set(sites.map((site) => rootDomain(site.addresses?.[0])).filter(Boolean))].sort(),
    [sites]
  );

  const applyLocal = (content) =>
    setConfig({
      path: config?.path || 'Caddyfile',
      content,
      parsed: parseCaddyfile(content),
      health: config?.health || {},
    });

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        applyLocal(
          appendSimpleProxy(config.content, {
            host: form.host,
            upstream: form.upstream,
            imports: selectedImportNames(form.imports),
            logging: { mode: form.logMode, path: form.logPath },
          })
        );
        setForm(empty);
        return;
      }
      const data = await api('/api/proxies', {
        method: 'POST',
        body: JSON.stringify({
          host: form.host,
          upstream: form.upstream,
          imports: selectedImportNames(form.imports),
          logging: { mode: form.logMode, path: form.logPath },
        }),
      });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
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
        setEdit(null);
        return;
      }

      if (localTest) {
        applyLocal(
          updateSimpleProxy(config.content, {
            siteLine: edit.line,
            host: edit.host,
            upstream: edit.upstream,
            imports: selectedImportNames(edit.imports),
            logging: { mode: edit.logMode, path: edit.logPath },
          })
        );
        setEdit(null);
        return;
      }

      const data = await api(`/api/proxies/${edit.line}`, {
        method: 'PUT',
        body: JSON.stringify({
          host: edit.host,
          upstream: edit.upstream,
          imports: selectedImportNames(edit.imports),
          logging: { mode: edit.logMode, path: edit.logPath },
        }),
      });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
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
      imports: [...new Set(names)].join(', '),
      logMode: logging.mode,
      logPath: logging.path,
      rawOpen: false,
      rawBlock: readBlockAtLine(config.content, site.line),
    });
  };


  const deleteProxy = async (site) => {
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        const range = findBlockRange(config.content, site.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) lines.splice(range.start, range.end - range.start + 1);
        applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
        return;
      }
      const data = await api(`/api/proxies/${site.line}`, { method: 'DELETE' });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed, health: data.health || current.health }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Proxies</h2>
          <p>Grouped by domain.</p>
        </div>
        <div className="toolbar">
          <button onClick={refresh}>
            <RefreshCw size={16} /> Refresh
          </button>
          
        </div>
      </div>

      <StatCards parsed={config?.parsed} />
      {result && <Notice type={result.ok ? 'success' : 'error'}>{result.ok ? result.stdout || 'Command succeeded' : result.stderr || 'Command failed'}</Notice>}
      <div className="proxy-search">
        <input placeholder="Search proxies" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span>{filteredSites.length} shown</span>
      </div>
      {error && <Notice type="error">{error}</Notice>}

      {canEdit && (
        <form className="quick-add" onSubmit={add}>
          <input
            list="proxy-domain-suggestions"
            placeholder="new.example.com"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
          />
          <datalist id="proxy-domain-suggestions">
            {domains
              .flatMap((domain) => [`caddyui.${domain}`, `app.${domain}`, domain])
              .map((host) => (
                <option key={host} value={host} />
              ))}
          </datalist>
          <input
            placeholder="http://10.0.0.10:3000"
            value={form.upstream}
            onChange={(e) => setForm({ ...form, upstream: e.target.value })}
          />
          <select value={form.logMode} onChange={(e) => setForm({ ...form, logMode: e.target.value })}>
            <option value="none">No access log</option>
            <option value="default">Default log</option>
            <option value="stdout">Log to stdout</option>
            <option value="stderr">Log to stderr</option>
            <option value="file">Log to file</option>
          </select>
          {form.logMode === 'file' && (
            <input
              placeholder="/var/log/caddy/site.access.log"
              value={form.logPath}
              onChange={(e) => setForm({ ...form, logPath: e.target.value })}
            />
          )}
          <button className="primary" disabled={busy}>
            {busy ? <Loader2 className="spin" /> : <Wand2 size={16} />}
            Add proxy
          </button>
          <MiddlewarePicker snippets={snippets} value={form.imports} onChange={(imports) => setForm({ ...form, imports })} />
        </form>
      )}

      {edit && (
        <div className="modal-backdrop" onMouseDown={() => setEdit(null)}>
          <form className="edit-modal" onSubmit={saveEdit} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit proxy</h3>
              <button type="button" onClick={() => setEdit(null)}>Close</button>
            </div>
            <label>
              Host
              <input
                value={edit.host}
                onChange={(e) => {
                  const next = { ...edit, host: e.target.value };
                  if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                  setEdit(next);
                }}
              />
            </label>
            <label>
              Upstream
              <input
                value={edit.upstream}
                onChange={(e) => {
                  const next = { ...edit, upstream: e.target.value };
                  if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                  setEdit(next);
                }}
              />
            </label>
            <label>
              Logging
              <select
                value={edit.logMode}
                onChange={(e) => {
                  const next = { ...edit, logMode: e.target.value };
                  if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                  setEdit(next);
                }}
              >
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
                <input
                  value={edit.logPath}
                  onChange={(e) => {
                    const next = { ...edit, logPath: e.target.value };
                    if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                    setEdit(next);
                  }}
                />
              </label>
            )}
            <MiddlewarePicker
              snippets={snippets}
              value={edit.imports}
              onChange={(imports) => {
                const next = { ...edit, imports };
                if (next.rawOpen) next.rawBlock = previewProxyBlock(config.content, next);
                setEdit(next);
              }}
            />
            <button
              type="button"
              className="expand-toggle"
              onClick={() => {
                const nextOpen = !edit.rawOpen;
                const next = { ...edit, rawOpen: nextOpen };
                if (nextOpen) next.rawBlock = previewProxyBlock(config.content, next);
                setEdit(next);
              }}
            >
              {edit.rawOpen ? 'Hide raw config' : 'Edit raw config'}
            </button>
            {edit.rawOpen && (
              <div className="raw-proxy-editor">
                <Editor
                  height="360px"
                  defaultLanguage="caddyfile"
                  theme={theme === 'light' ? 'light' : 'vs-dark'}
                  value={edit.rawBlock}
                  onChange={(value) => setEdit({ ...edit, rawBlock: value || '' })}
                  options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }}
                />
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
        {Object.entries(groups)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([domain, items]) => (
            <details
              className="proxy-group"
              key={domain}
              open={!collapsedDomains[domain]}
              onToggle={(e) => {
                const isOpen = e.currentTarget?.open ?? true;
                setCollapsedDomains((current) => ({ ...current, [domain]: !isOpen }));
              }}
            >
              <summary className="proxy-group-head">
                <h3>{domain}</h3>
                <span>{items.length} entries</span>
              </summary>
              <div className="proxy-table-head">
                <span>Host</span>
                <span>Upstream</span>
                <span>Local</span>
                <span>Middlewares</span>
                <span>Actions</span>
              </div>
              {items.map((site) => (
                <div className="proxy-row" key={site.id}>
                  <div className="proxy-row-main">
                    <span className="proxy-host">{site.addresses.join(', ')}</span>
                    <span className="proxy-target">{site.proxies[0]?.upstreams?.join(' ') || 'no upstream'}</span>
                    <StatusDot check={config?.health?.[site.id]?.local} />
                    <span className="proxy-mw">
                      {[...site.imports.map((i) => i.name), ...(site.proxies[0]?.imports?.map((i) => i.name) || [])].join(', ') || 'none'}
                    </span>
                    <div className="row-actions">
                      {canEdit && (
                        <>
                          <button type="button" onClick={() => startEdit(site)}>Edit</button>
                          <button
                            type="button"
                            className="danger"
                            onClick={(e) =>
                              setConfirmDelete(deleteConfirm(e, 'Delete proxy', site.addresses[0], () => deleteProxy(site)))
                            }
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </details>
          ))}
      </div>
    </section>
  );
}

function Middlewares({ config, setConfig, canEdit, theme }) {
  const snippets = config?.parsed?.snippets || [];
  const empty = { name: '', body: '' };
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const applyLocal = (content) => setConfig({ path: config?.path || 'Caddyfile', content, parsed: parseCaddyfile(content), health: config?.health || {} });

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        applyLocal(`${config.content.trimEnd()}\n\n(${form.name}) {\n${form.body.split('\n').filter(Boolean).map((line) => `\t${line.trim()}`).join('\n')}\n}\n`);
        setForm(empty);
        return;
      }
      const data = await api('/api/middlewares', { method: 'POST', body: JSON.stringify(form) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      setForm(empty);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        const range = findBlockRange(config.content, edit.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) {
          lines.splice(
            range.start,
            range.end - range.start + 1,
            ...`(${edit.name}) {\n${edit.body.split('\n').filter(Boolean).map((line) => `\t${line.trim()}`).join('\n')}\n}`.split('\n')
          );
        }
        applyLocal(lines.join('\n'));
        setEdit(null);
        return;
      }
      const data = await api(`/api/middlewares/${edit.line}`, { method: 'PUT', body: JSON.stringify(edit) });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      setEdit(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteMiddleware = async (item) => {
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        const range = findBlockRange(config.content, item.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) lines.splice(range.start, range.end - range.start + 1);
        applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
        return;
      }
      const data = await api(`/api/middlewares/${item.line}`, { method: 'DELETE' });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Middlewares</h2>
          <p>Snippets and imports.</p>
        </div>
      </div>
      {error && <Notice type="error">{error}</Notice>}

      {canEdit && (
        <form className="middleware-form" onSubmit={add}>
          <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="middleware-editor">
            <Editor
              height="180px"
              defaultLanguage="caddyfile"
              theme={theme === 'light' ? 'light' : 'vs-dark'}
              value={form.body}
              onChange={(value) => setForm({ ...form, body: value || '' })}
              options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }}
            />
          </div>
          <button className="primary" disabled={busy}>Add middleware</button>
        </form>
      )}

      <div className="middleware-list">
        {snippets.map((snippet) => (
          <div className="middleware-row" key={snippet.name}>
            <span className="proxy-host">({snippet.name})</span>
            <span className="status-dot online">{snippet.inferredType}</span>
            <span className="proxy-mw">{snippet.usedBy?.join(', ') || 'unused'}</span>
            <div className="row-actions">
              {canEdit && (
                <>
                  <button type="button" onClick={() => setEdit({ line: snippet.line, name: snippet.name, body: snippet.body })}>Edit</button>
                  <button
                    type="button"
                    className="danger"
                    onClick={(e) => setConfirmDelete(deleteConfirm(e, 'Delete middleware', snippet.name, () => deleteMiddleware(snippet)))}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div className="modal-backdrop" onMouseDown={() => setEdit(null)}>
          <form className="edit-modal" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit middleware</h3>
              <button type="button" onClick={() => setEdit(null)}>Close</button>
            </div>
            <label>
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <div className="middleware-editor">
              <Editor
                height="260px"
                defaultLanguage="caddyfile"
                theme={theme === 'light' ? 'light' : 'vs-dark'}
                value={edit.body}
                onChange={(value) => setEdit({ ...edit, body: value || '' })}
                options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }}
              />
            </div>
            <div className="toolbar">
              <button className="primary" disabled={busy}>Save</button>
              <button type="button" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmModal confirm={confirmDelete} onCancel={() => setConfirmDelete(null)} onConfirm={() => confirmDelete?.action()} />
    </section>
  );
}

function Configuration({ config, setConfig, refresh, canEdit, theme }) {
  const [draft, setDraft] = useState(config?.content || '');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(config?.content || ''), [config?.content]);


  const save = async () => {
    if (!canEdit) return;
    if (localTest) {
      setConfig((c) => ({ ...c, content: draft, parsed: parseCaddyfile(draft) }));
      setResult({ ok: true, stdout: 'Saved in browser only' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ content: draft, validate: true }) });
      setConfig((c) => ({ ...c, content: draft, parsed: r.parsed }));
      setResult({ ok: true, stdout: `Saved. Backup: ${r.backup}` });
    } catch (e) {
      setResult({ ok: false, stderr: e.message });
    } finally {
      setBusy(false);
    }
  };


  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Configuration editor</h2>
          <p>Edit the live Caddyfile.</p>
        </div>
        <div className="toolbar">
          <button onClick={refresh}>Reload file</button>
          {canEdit && (
            <>
              <button className="primary" onClick={save} disabled={busy}>
                <Save size={16} />
                Save
              </button>
            </>
          )}
        </div>
      </div>
      {result && <Notice type={result.ok ? 'success' : 'error'}>{result.ok ? result.stdout || 'Command succeeded' : result.stderr || 'Command failed'}</Notice>}
      <div className="editor-wrap">
        <Editor
          height="68vh"
          defaultLanguage="caddyfile"
          theme={theme === 'light' ? 'light' : 'vs-dark'}
          value={draft}
          onChange={(v) => setDraft(v || '')}
          options={{ minimap: { enabled: false }, fontSize: 14, wordWrap: 'on', scrollBeyondLastLine: false, readOnly: !canEdit }}
        />
      </div>
    </section>
  );
}

function Logs() {
  const [logs, setLogs] = useState(localTest ? [{ source: 'local-test', content: 'Local test mode' }] : []);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState(250);

  const load = async () => {
    if (localTest) return;
    setBusy(true);
    try {
      setLogs((await api(`/api/logs?lines=${lines}`)).logs);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
    if (localTest) return undefined;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [lines]);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Logs</h2>
          <p>Auto-refresh every 10 seconds.</p>
        </div>
        <div className="toolbar">
          <label>
            Lines
            <select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </label>
          <button onClick={load}>{busy ? <Loader2 className="spin" /> : <RefreshCw size={16} />}Refresh</button>
        </div>
      </div>
      {logs.map((l) => (
        <article className="log-card" key={l.source}>
          <h3>{l.source}</h3>
          <pre>{l.content}</pre>
        </article>
      ))}
    </section>
  );
}

function SettingsPage({ settings, setSettings, canEdit, canAdmin }) {
  const [form, setForm] = useState({ caddyfilePath: settings.caddyfilePath || '', logPaths: (settings.logPaths || []).join('\n') });
  const [msg, setMsg] = useState('');
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState({ username: '', password: '', role: 'view' });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });

  useEffect(() => {
    setForm({ caddyfilePath: settings.caddyfilePath || '', logPaths: (settings.logPaths || []).join('\n') });
  }, [settings.caddyfilePath, settings.logPaths]);

  useEffect(() => {
    if (!canAdmin || localTest) return;
    api('/api/users').then((res) => setUsers(res.users)).catch(() => {});
  }, [canAdmin]);

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    if (!canEdit) return;
    if (localTest) {
      setSettings({
        ...settings,
        caddyfilePath: form.caddyfilePath,
        logPaths: form.logPaths.split('\n').map((x) => x.trim()).filter(Boolean),
      });
      setMsg('Saved in browser only.');
      return;
    }
    try {
      const r = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          caddyfilePath: form.caddyfilePath,
          logPaths: form.logPaths.split('\n').map((x) => x.trim()).filter(Boolean),
        }),
      });
      setSettings(r.settings);
      setMsg('Settings saved.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const addUser = async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/users', { method: 'POST', body: JSON.stringify(userForm) });
      setUsers(res.users);
      setUserForm({ username: '', password: '', role: 'view' });
      setMsg('User added.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const updateUserRole = async (username, role) => {
    try {
      const res = await api(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        body: JSON.stringify({ role }),
      });
      setUsers(res.users);
    } catch (err) {
      setMsg(err.message);
    }
  };

  const removeUser = async (username) => {
    try {
      const res = await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      setUsers(res.users);
      setMsg('User deleted.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify(passwordForm) });
      setPasswordForm({ currentPassword: '', newPassword: '' });
      setMsg('Password updated.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  return (
    <section>
      <h2>Settings</h2>
      <form className="settings-form" onSubmit={save}>
        <label>
          Caddyfile path
          <input value={form.caddyfilePath} onChange={(e) => setForm({ ...form, caddyfilePath: e.target.value })} readOnly={!canEdit} />
        </label>
        <label>
          Log paths
          <textarea rows="8" value={form.logPaths} onChange={(e) => setForm({ ...form, logPaths: e.target.value })} readOnly={!canEdit} />
        </label>
        {canEdit && <button className="primary">Save settings</button>}
      </form>

      <form className="settings-form" onSubmit={changePassword}>
        <h3>Password</h3>
        <label>
          Current password
          <input type="password" value={passwordForm.currentPassword} onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} />
        </label>
        <label>
          New password
          <input type="password" minLength={8} value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} />
        </label>
        <button className="primary">Change password</button>
      </form>

      {canAdmin && (
        <div className="settings-form">
          <h3>Users</h3>
          <form className="users-add" onSubmit={addUser}>
            <input placeholder="username" value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} />
            <input placeholder="password" type="password" minLength={8} value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} />
            <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
              <option value="view">view</option>
              <option value="edit">edit</option>
              <option value="admin">admin</option>
            </select>
            <button className="primary">Add user</button>
          </form>
          <div className="users-table">
            {users.map((user) => (
              <div key={user.username} className="users-row">
                <span>{user.username}</span>
                <select value={user.role} onChange={(e) => updateUserRole(user.username, e.target.value)}>
                  <option value="view">view</option>
                  <option value="edit">edit</option>
                  <option value="admin">admin</option>
                </select>
                <button className="danger" type="button" onClick={() => removeUser(user.username)} disabled={user.username === settings.username}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {msg && <p>{msg}</p>}
    </section>
  );
}

function App() {
  const [status, setStatus] = useState(localTest ? { settings: localSettings, authenticated: true, discovered: { caddyfiles: [], logfiles: [] } } : null);
  const [settings, setSettings] = useState(localTest ? localSettings : null);
  const [config, setConfig] = useState(localTest ? emptyConfig : null);
  const [page, setPage] = useState('proxies');
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('caddyui-theme') || 'dark');
  const [error, setError] = useState('');
  const [appInfo, setAppInfo] = useState({ version: APP_VERSION, updateAvailable: false });
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [caddyBusy, setCaddyBusy] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [actionResult, setActionResult] = useState(null);

  const role = settings?.role || '';
  const canEdit = canEditRole(role) || localTest;
  const canAdmin = canAdminRole(role) || localTest;

  const refreshHealth = async () => {
    if (localTest) return;
    try {
      const data = await api('/api/proxies/health');
      setConfig((current) => (current ? { ...current, health: data.health || {} } : current));
    } catch {}
  };

  const refreshConfig = async () => {
    if (localTest) return;
    setError('');
    try {
      const data = await api('/api/config');
      setConfig((current) => ({ ...current, ...data, health: current?.health || {} }));
      refreshHealth();
    } catch (e) {
      setError(e.message);
    }
  };

  const refreshAppStatus = async (check = false) => {
    if (localTest) return;
    try {
      const endpoint = check ? '/api/app/check-updates' : '/api/app/status';
      const opts = check ? { method: 'POST' } : {};
      setAppInfo(await api(endpoint, opts));
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('caddyui-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (localTest) {
      fetch('/local-test/Caddyfile')
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('Missing local test Caddyfile'))))
        .then((content) => {
          const parsed = parseCaddyfile(content);
          const health = Object.fromEntries(parsed.sites.map((site) => [site.id, { local: { online: false }, domain: { online: false } }]));
          setConfig({ path: 'Caddyfile', content, parsed, health });
        })
        .catch(() => {});
      return;
    }
    api('/api/status')
      .then((s) => {
        setStatus(s);
        setSettings(s.settings);
        if (s.settings.configured) {
          refreshConfig();
          refreshAppStatus(false);
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (localTest || !settings?.configured) return undefined;
    const healthTimer = setInterval(() => {
      refreshHealth();
    }, 15000);
    return () => clearInterval(healthTimer);
  }, [localTest, settings?.configured]);

  if (!status) {
    return (
      <div className="loading">
        <Loader2 className="spin" /> Loading CaddyUI...
      </div>
    );
  }

  if (!localTest && (!status.authenticated || !settings?.configured)) {
    return (
      <AuthGate
        status={status}
        onReady={(data) => {
          setStatus((prev) => ({
            ...prev,
            ...data,
            settings: data.settings,
            authenticated: true,
            discovered: data.discovered || prev?.discovered,
          }));
          setSettings(data.settings);
          if (data.settings.configured) {
            refreshConfig();
            refreshAppStatus(false);
          }
        }}
      />
    );
  }

  const logout = async () => {
    if (localTest) {
      location.reload();
      return;
    }
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };

  const checkUpdates = async () => {
    setCheckingUpdates(true);
    try {
      await refreshAppStatus(true);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const validateCaddyGlobal = async () => {
    if (!canEdit) return;
    if (localTest) {
      setActionResult({ ok: true, message: 'Local test mode' });
      return;
    }
    setCaddyBusy(true);
    setError('');
    try {
      const result = await api('/api/config/validate', { method: 'POST', body: JSON.stringify({ content: config?.content || '' }) });
      setActionResult({ ok: result.ok, message: result.ok ? (result.stdout || 'Validation passed') : (result.stderr || 'Validation failed') });
    } catch (e) {
      setActionResult({ ok: false, message: e.message });
    } finally {
      setCaddyBusy(false);
    }
  };

  const reloadCaddyGlobal = async () => {
    if (!canEdit) return;
    if (localTest) {
      setActionResult({ ok: true, message: 'Local test mode' });
      setReloadConfirmOpen(false);
      return;
    }
    setCaddyBusy(true);
    setError('');
    try {
      const result = await api('/api/config/reload', { method: 'POST' });
      setActionResult({ ok: result.ok, message: result.ok ? (result.stdout || 'Reloaded Caddy') : (result.stderr || 'Reload failed') });
      setReloadConfirmOpen(false);
    } catch (e) {
      setActionResult({ ok: false, message: e.message });
    } finally {
      setCaddyBusy(false);
    }
  };

  const runUpdate = async () => {
    setUpdating(true);
    setError('');
    try {
      await api('/api/app/update', { method: 'POST' });
      setTimeout(() => {
        location.reload();
      }, 8000);
    } catch (e) {
      setError(e.message);
      setUpdating(false);
    }
  };

  return (
    <Shell
      page={page}
      setPage={setPage}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      user={settings.username}
      onLogout={logout}
      theme={theme}
      setTheme={setTheme}
      appInfo={appInfo}
      onCheckUpdates={checkUpdates}
      onRunUpdate={runUpdate}
      canUpdate={canAdmin}
      checkingUpdates={checkingUpdates}
      updating={updating}
      canEdit={canEdit}
      onValidateCaddy={validateCaddyGlobal}
      onConfirmReloadCaddy={() => setReloadConfirmOpen(true)}
      caddyBusy={caddyBusy}
    >
      {error && <Notice type="error">{error}</Notice>}
      {actionResult && <Notice type={actionResult.ok ? 'success' : 'error'}>{actionResult.message}</Notice>}
      {page === 'proxies' && <Proxies config={config} refresh={refreshConfig} setConfig={setConfig} canEdit={canEdit} theme={theme} />}
      {page === 'middlewares' && <Middlewares config={config} setConfig={setConfig} canEdit={canEdit} theme={theme} />}
      {page === 'configuration' && <Configuration config={config} setConfig={setConfig} refresh={refreshConfig} canEdit={canEdit} theme={theme} />}
      {page === 'logs' && <Logs />}
      {page === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} canEdit={canEdit} canAdmin={canAdmin} />}
      <ReloadConfirmModal open={reloadConfirmOpen} busy={caddyBusy} onCancel={() => setReloadConfirmOpen(false)} onConfirm={reloadCaddyGlobal} />
    </Shell>
  );
}

createRoot(document.getElementById('root')).render(<App />);
