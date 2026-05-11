import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { parseCaddyfile } from '../server/caddyParser.js';
import pkg from '../package.json';
import './styles.css';
import Proxies from './pages/Proxies.jsx';
import Middlewares from './pages/Middlewares.jsx';
import Configuration from './pages/Configuration.jsx';
import Logs from './pages/Logs.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import { AuthGate, Notice, ReloadConfirmModal, Shell } from './components/common.jsx';

const APP_VERSION = pkg.version;
const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';
const emptyConfig = { path: 'Caddyfile', content: '', parsed: parseCaddyfile(''), health: {} };
const localSettings = { userConfigured: true, caddyConfigured: true, configured: true, caddyfilePath: 'Caddyfile', logPaths: ['/var/log/caddy/access.log'], updateChannel: 'stable', username: 'local', role: 'admin' };

const api = async (path, options = {}) => {
  const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.stderr || `Request failed: ${res.status}`);
  return data;
};

const canEditRole = (role) => role === 'edit' || role === 'admin';
const canAdminRole = (role) => role === 'admin';

export default function App() {
  const [status, setStatus] = useState(localTest ? { settings: localSettings, authenticated: true, discovered: { caddyfiles: [], logfiles: [] } } : null);
  const [settings, setSettings] = useState(localTest ? localSettings : null);
  const [config, setConfig] = useState(localTest ? emptyConfig : null);
  const [health, setHealth] = useState(localTest ? {} : {});
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
  const [configLoading, setConfigLoading] = useState(false);

  const role = settings?.role || '';
  const canEdit = canEditRole(role) || localTest;
  const canAdmin = canAdminRole(role) || localTest;

  const refreshHealth = async () => {
    if (localTest) return;
    try { const data = await api('/api/proxies/health'); setHealth(data.health || {}); } catch {}
  };

  const refreshConfig = async () => {
    if (localTest) return;
    setError(''); setConfigLoading(true);
    try { const data = await api('/api/config'); setConfig((current) => ({ ...current, ...data })); refreshHealth(); }
    catch (e) { setError(e.message); }
    finally { setConfigLoading(false); }
  };

  const refreshAppStatus = async (check = false) => {
    if (localTest) return;
    try { const endpoint = check ? '/api/app/check-updates' : '/api/app/status'; const opts = check ? { method: 'POST' } : {}; setAppInfo(await api(endpoint, opts)); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('caddyui-theme', theme); }, [theme]);
  useEffect(() => {
    if (localTest) {
      fetch('/local-test/Caddyfile').then((r) => (r.ok ? r.text() : Promise.reject(new Error('Missing local test Caddyfile')))).then((content) => { const parsed = parseCaddyfile(content); const h = Object.fromEntries(parsed.sites.map((site) => [site.id, { local: { online: false }, domain: { online: false } }])); setConfig({ path: 'Caddyfile', content, parsed, health: h }); setHealth(h); }).catch(() => {});
      return;
    }
    api('/api/status').then((s) => { setStatus(s); setSettings(s.settings); if (s.settings.configured) { refreshConfig(); refreshAppStatus(false); } }).catch((e) => setError(e.message));
  }, []);

  const validateCaddyGlobal = async () => {
    if (!canEdit) return;
    if (localTest) { setActionResult({ ok: true, message: 'Local test mode' }); return; }
    setCaddyBusy(true); setError('');
    try { const result = await api('/api/config/validate', { method: 'POST', body: JSON.stringify({ content: config?.content || '' }) }); setActionResult({ ok: result.ok, message: result.ok ? (result.stdout || 'Validation passed') : (result.stderr || 'Validation failed') }); }
    catch (e) { setActionResult({ ok: false, message: e.message }); }
    finally { setCaddyBusy(false); }
  };

  const reloadCaddyGlobal = async () => {
    if (!canEdit) return;
    if (localTest) { setActionResult({ ok: true, message: 'Local test mode' }); setReloadConfirmOpen(false); return; }
    setCaddyBusy(true); setError('');
    try { const result = await api('/api/config/reload', { method: 'POST' }); setActionResult({ ok: result.ok, message: result.ok ? (result.stdout || 'Reloaded Caddy') : (result.stderr || 'Reload failed') }); setReloadConfirmOpen(false); }
    catch (e) { setActionResult({ ok: false, message: e.message }); }
    finally { setCaddyBusy(false); }
  };

  if (!status) return <div className="loading"><Loader2 className="spin" /> Loading CaddyUI...</div>;
  if (!localTest && (!status.authenticated || !settings?.configured)) return <AuthGate status={status} onReady={(data) => { setStatus((prev) => ({ ...prev, ...data, settings: data.settings, authenticated: true, discovered: data.discovered || prev?.discovered })); setSettings(data.settings); if (data.settings.configured) { refreshConfig(); refreshAppStatus(false); } }} api={api} />;

  const logout = async () => { if (localTest) { location.reload(); return; } await api('/api/logout', { method: 'POST' }); location.reload(); };
  const checkUpdates = async () => { setCheckingUpdates(true); try { await refreshAppStatus(true); } finally { setCheckingUpdates(false); } };
  const runUpdate = async () => {
    setUpdating(true);
    setError('');
    try {
      await api('/api/app/update', { method: 'POST' });
      const started = Date.now();
      while (Date.now() - started < 120000) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        try {
          const status = await api('/api/app/status');
          setAppInfo(status);
          if (!status.updateAvailable) {
            setUpdating(false);
            setActionResult({ ok: true, message: 'Updated successfully. Reloading...' });
            setTimeout(() => location.reload(), 1500);
            return;
          }
        } catch {}
      }
      setUpdating(false);
      setActionResult({ ok: false, message: 'Update did not finish in time. Check install log.' });
    } catch (e) {
      setError(e.message);
      setUpdating(false);
    }
  };

  return <Shell page={page} setPage={setPage} collapsed={collapsed} setCollapsed={setCollapsed} user={settings.username} onLogout={logout} theme={theme} setTheme={setTheme} appInfo={appInfo} onCheckUpdates={checkUpdates} onRunUpdate={runUpdate} canUpdate={canAdmin} checkingUpdates={checkingUpdates} updating={updating} canEdit={canEdit} onValidateCaddy={validateCaddyGlobal} onConfirmReloadCaddy={() => setReloadConfirmOpen(true)} caddyBusy={caddyBusy} appVersion={APP_VERSION}>{error && <Notice type="error">{error}</Notice>}{actionResult && <Notice type={actionResult.ok ? 'success' : 'error'}>{actionResult.message}</Notice>}{page === 'proxies' && <Proxies config={config} refresh={refreshConfig} setConfig={setConfig} canEdit={canEdit} theme={theme} health={health} loading={configLoading} api={api} />}{page === 'middlewares' && <Middlewares config={config} setConfig={setConfig} canEdit={canEdit} theme={theme} api={api} />}{page === 'configuration' && <Configuration config={config} setConfig={setConfig} refresh={refreshConfig} canEdit={canEdit} theme={theme} api={api} />}{page === 'logs' && <Logs api={api} />}{page === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} canEdit={canEdit} canAdmin={canAdmin} api={api} />}<ReloadConfirmModal open={reloadConfirmOpen} busy={caddyBusy} onCancel={() => setReloadConfirmOpen(false)} onConfirm={reloadCaddyGlobal} /></Shell>;
}
