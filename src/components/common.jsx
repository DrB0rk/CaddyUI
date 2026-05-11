import React, { memo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileCode2, KeyRound, Layers3, Loader2, Menu, Moon, ScrollText, ServerCog, Settings, Shield, SidebarClose, Sun } from 'lucide-react';
import { updateSimpleProxy } from '../../server/caddyParser.js';

export const pageItems = [
  ['proxies', ServerCog, 'Proxies'],
  ['middlewares', Layers3, 'Middlewares'],
  ['configuration', FileCode2, 'Configuration'],
  ['logs', ScrollText, 'Logs'],
  ['settings', Settings, 'Settings'],
];

export function Notice({ type = 'info', children }) {
  return <div className={`notice ${type}`}>{type === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}<span>{children}</span></div>;
}

export function Shell({ children, page, setPage, collapsed, setCollapsed, user, onLogout, theme, setTheme, appInfo, onCheckUpdates, onRunUpdate, canUpdate, checkingUpdates, updating, canEdit, onValidateCaddy, onConfirmReloadCaddy, caddyBusy, appVersion, actionResult, onDismissActionResult }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button className="icon-button" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <Menu /> : <SidebarClose />}
          </button>
          <span className="logo">CaddyUI</span>
          <span className="app-version">v{appVersion}</span>
        </div>
        <div className="top-actions">
          {canEdit && (
            <>
              <button onClick={onValidateCaddy} disabled={caddyBusy}>Validate</button>
              <button onClick={onConfirmReloadCaddy} disabled={caddyBusy}>Reload Caddy</button>
            </>
          )}
          <span className="pill"><Shield size={14} />{user || 'user'}</span>
          <button
            className="icon-button"
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            title={theme === 'light' ? 'Dark mode' : 'Light mode'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>
      {actionResult && (
        <div className={`top-feedback ${actionResult.ok ? 'success' : 'error'}`} role="status" aria-live="polite">
          {actionResult.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{actionResult.message}</span>
          <button type="button" className="icon-button top-feedback-close" onClick={onDismissActionResult} aria-label="Dismiss message">×</button>
        </div>
      )}
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
            <span className="sidebar-version">v{appInfo?.version || appVersion}</span>
            <span className={`sidebar-status ${appInfo?.updateAvailable ? 'update' : 'current'}`}>
              {updating ? 'Updating' : appInfo?.updateAvailable ? `Update v${appInfo?.availableVersion || appInfo?.remoteVersion || appInfo?.version || appVersion}` : 'Current'}
            </span>
          </div>
          <div className="sidebar-actions">
            <button type="button" onClick={onCheckUpdates} disabled={checkingUpdates || updating}>
              {checkingUpdates ? 'Checking...' : 'Check updates'}
            </button>
            {canUpdate && appInfo?.updateAvailable && (
              <button type="button" className="primary" onClick={onRunUpdate} disabled={updating}>
                {updating ? 'Updating...' : `Update to v${appInfo?.availableVersion || appInfo?.remoteVersion || appInfo?.version || appVersion}`}
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className={`content ${collapsed ? 'wide' : ''}`}>{children}</main>
      <nav className="mobile-nav">
        {pageItems.map(([id, Icon, label]) => (
          <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export function AuthGate({ status, onReady, api }) {
  const needsLogin = status?.settings?.userConfigured && !status?.authenticated;
  const needsConfig = status?.settings?.userConfigured && status?.authenticated && !status?.settings?.caddyConfigured;
  const discovered = status?.discovered || { caddyfiles: [], logfiles: [] };
  const [userForm, setUserForm] = useState({ username: '', password: '', setupToken: '' });
  const [configForm, setConfigForm] = useState({ caddyfilePath: discovered.caddyfiles?.[0]?.path || '', logPaths: (discovered.logfiles || []).map((f) => f.path).join('\n') });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitUser = async (e) => { e.preventDefault(); setBusy(true); setError(''); try { const path = needsLogin ? '/api/login' : '/api/setup/user'; const payload = needsLogin ? { username: userForm.username, password: userForm.password } : userForm; onReady(await api(path, { method: 'POST', body: JSON.stringify(payload) })); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const submitConfig = async (e) => { e.preventDefault(); setBusy(true); setError(''); try { onReady(await api('/api/setup/config', { method: 'POST', body: JSON.stringify({ caddyfilePath: configForm.caddyfilePath, logPaths: configForm.logPaths.split('\n').map((x) => x.trim()).filter(Boolean) }) })); } catch (err) { setError(err.message); } finally { setBusy(false); } };

  if (needsConfig) return <div className="auth-page"><form className="auth-card" onSubmit={submitConfig}><h1>CaddyUI</h1><p>Admin user created. Choose the Caddyfile and log files.</p>{error && <Notice type="error">{error}</Notice>}<label>Caddyfile path<input value={configForm.caddyfilePath} onChange={(e) => setConfigForm({ ...configForm, caddyfilePath: e.target.value })} /></label>{discovered.caddyfiles?.length > 0 && <div className="discover"><b>Discovered Caddyfiles</b>{discovered.caddyfiles.map((f) => <button type="button" key={f.path} onClick={() => setConfigForm({ ...configForm, caddyfilePath: f.path })}>{f.path}</button>)}</div>}<label>Log paths, one per line<textarea rows="5" value={configForm.logPaths} placeholder="/var/log/caddy/access.log" onChange={(e) => setConfigForm({ ...configForm, logPaths: e.target.value })} /></label>{discovered.logfiles?.length > 0 && <div className="discover"><b>Discovered log files</b>{discovered.logfiles.map((f) => <button type="button" key={f.path} onClick={() => { const lines = new Set(configForm.logPaths.split('\n').map((x) => x.trim()).filter(Boolean)); lines.add(f.path); setConfigForm({ ...configForm, logPaths: [...lines].join('\n') }); }}>{f.path}</button>)}</div>}<button className="primary" disabled={busy}>{busy ? <Loader2 className="spin" /> : <FileCode2 size={16} />}Save Caddy configuration</button></form></div>;

  return <div className="auth-page"><form className="auth-card" onSubmit={submitUser}><h1>CaddyUI</h1><p>{needsLogin ? 'Sign in to continue.' : 'First create the admin user. Caddy configuration is selected in the next step.'}</p>{error && <Notice type="error">{error}</Notice>}<label>Username<input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} /></label><label>Password<input type="password" minLength={8} value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} /></label>{!needsLogin && status?.settings?.setupTokenRequired && <label>Setup token<input value={userForm.setupToken} onChange={(e) => setUserForm({ ...userForm, setupToken: e.target.value })} /></label>}<button className="primary" disabled={busy}>{busy ? <Loader2 className="spin" /> : <KeyRound size={16} />}{needsLogin ? 'Login' : 'Create admin account'}</button></form></div>;
}

export function ConfirmModal({ confirm, onCancel, onConfirm }) {
  if (!confirm) return null;
  return <div className="confirm-layer" onMouseDown={onCancel}><div className="confirm-popover" style={{ left: confirm.x, top: confirm.y }} onMouseDown={(e) => e.stopPropagation()}><h3>{confirm.title}</h3><p>{confirm.message}</p><div className="confirm-actions"><button className="danger" onClick={onConfirm}>Delete</button><button onClick={onCancel}>Cancel</button></div></div></div>;
}

export function ReloadConfirmModal({ open, busy, onCancel, onConfirm }) {
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={onCancel}><div className="edit-modal" onMouseDown={(e) => e.stopPropagation()}><div className="modal-head"><h3>Reload Caddy</h3></div><p>Apply current configuration and reload now?</p><div className="toolbar"><button className="primary" onClick={onConfirm} disabled={busy}>{busy ? 'Reloading...' : 'Reload'}</button><button onClick={onCancel} disabled={busy}>Cancel</button></div></div></div>;
}

export const deleteConfirm = (event, title, message, action) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { title, message, action, x: Math.min(rect.left, window.innerWidth - 430), y: Math.min(rect.bottom + 8, window.innerHeight - 170) };
};

export function StatCards({ parsed }) {
  const stats = parsed?.summary || {};
  return <div className="stats"><div><b>{stats.sites || 0}</b><span>Sites</span></div><div><b>{stats.proxies || 0}</b><span>Reverse proxies</span></div><div><b>{stats.snippets || 0}</b><span>Snippets</span></div><div><b>{stats.middleware || 0}</b><span>Imports used</span></div></div>;
}

export const rootDomain = (address = '') => {
  const host = address.replace(/^https?:\/\//, '').replace(/:.*/, '').trim();
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : host || 'Other';
};

export const selectedImportNames = (value) => String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
export const selectedTagNames = (value) => {
  const seen = new Set();
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};
export const normalizeLogging = (logging = {}) => ({ mode: logging?.mode || 'none', path: logging?.path || '' });

export const findBlockRange = (content, line) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Number(line) - 1;
  if (start < 0 || start >= lines.length) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) { if (ch === '{') depth += 1; if (ch === '}') depth -= 1; }
    if (depth === 0) { end = i; break; }
  }
  return { lines, start, end };
};

export const replaceBlockAtLine = (content, line, blockText) => {
  const range = findBlockRange(content, line);
  if (!range) return content;
  range.lines.splice(range.start, range.end - range.start + 1, ...String(blockText || '').replace(/\r\n/g, '\n').split('\n'));
  return range.lines.join('\n');
};

export const readBlockAtLine = (content, line) => {
  const range = findBlockRange(content, line);
  return range ? range.lines.slice(range.start, range.end + 1).join('\n') : '';
};

export const previewProxyBlock = (content, draft) => {
  try {
    const next = updateSimpleProxy(content, { siteLine: draft.line, host: draft.host, upstream: draft.upstream, imports: selectedImportNames(draft.imports), logging: { mode: draft.logMode, path: draft.logPath }, tags: selectedTagNames(draft.tags), category: draft.category });
    return readBlockAtLine(next, draft.line) || draft.rawBlock || '';
  } catch {
    return draft.rawBlock || '';
  }
};

export function MiddlewarePicker({ snippets, value, onChange }) {
  const selected = selectedImportNames(value);
  const [open, setOpen] = useState(false);
  if (!snippets.length) return null;
  const toggle = (name) => {
    const set = new Set(selected);
    if (set.has(name)) set.delete(name); else set.add(name);
    onChange([...set].join(', '));
  };
  return <div className="import-dropdown"><button type="button" className="import-dropdown-trigger" onClick={() => setOpen((v) => !v)}>{selected.length ? `${selected.length} selected` : 'Select imports'}</button>{open && <div className="import-dropdown-menu">{snippets.map((s) => <label key={s.name} className="import-option"><input type="checkbox" checked={selected.includes(s.name)} onChange={() => toggle(s.name)} /><span>{s.name}</span><small>{s.inferredType}</small></label>)}</div>}</div>;
}

export const StatusDot = ({ check }) => <span className={`status-dot ${check?.online ? 'online' : 'offline'}`}>{check?.online ? 'online' : 'offline'}</span>;

export const ProxyRow = memo(function ProxyRow({ site, healthCheck, canEdit, onEdit, onDelete }) {
  return <div className="proxy-row"><div className="proxy-row-main"><span className="proxy-host">{site.addresses.join(', ')}</span><span className="proxy-target">{site.proxies[0]?.upstreams?.join(' ') || 'no upstream'}</span><StatusDot check={healthCheck} /><span className="proxy-category">{site.category || 'none'}</span><span className="proxy-tags">{(site.tags || []).join(', ') || 'none'}</span><span className="proxy-mw">{[...site.imports.map((i) => i.name), ...(site.proxies[0]?.imports?.map((i) => i.name) || [])].join(', ') || 'none'}</span><div className="row-actions">{canEdit && <><button type="button" onClick={onEdit}>Edit</button><button type="button" className="danger" onClick={onDelete}>Delete</button></>}</div></div></div>;
});
