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
const localSettings = {
  userConfigured: true,
  caddyConfigured: true,
  configured: true,
  caddyfilePath: 'Caddyfile',
  logPaths: ['/var/log/caddy/access.log'],
  updateChannel: 'stable',
  trustProxyHops: 0,
  allowRemoteSetup: false,
  secureCookieMode: 'auto',
  allowedOrigins: [],
  username: 'local',
  role: 'admin',
};

const api = async (path, options = {}) => {
  const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.stderr || `Request failed: ${res.status}`);
  return data;
};

const canEditRole = (role) => role === 'edit' || role === 'admin';
const canAdminRole = (role) => role === 'admin';

function parseValidationWarning(result = {}) {
  const raw = String(result?.stderr || '').trim();
  if (!raw) return { message: 'Validation failed.', canFormat: false };
  let message = raw;
  let canFormat = /not formatted/i.test(raw) && /caddy fmt/i.test(raw);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.warnings) && parsed.warnings.length) {
      message = parsed.warnings
        .map((warning) => {
          const file = warning?.file ? String(warning.file) : 'Caddyfile';
          const line = warning?.line ? `:${warning.line}` : '';
          return `${file}${line} ${String(warning?.message || 'Validation warning.')}`;
        })
        .join(' | ');
      canFormat = canFormat || parsed.warnings.some((warning) => /not formatted/i.test(String(warning?.message || '')));
    }
  } catch {}
  return { message, canFormat };
}

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
  const [updateMessage, setUpdateMessage] = useState('');
  const [caddyBusy, setCaddyBusy] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [actionResult, setActionResult] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const role = settings?.role || '';
  const canEdit = canEditRole(role) || localTest;
  const canAdmin = canAdminRole(role) || localTest;

  const notifyConfigChangedNeedsReload = (prefix = 'Changes saved.') => {
    if (localTest) return;
    if ((settings?.configMode || 'file') === 'api') return;
    setActionResult({
      ok: false,
      level: 'warning',
      message: `${prefix} Caddy has not been reloaded, so changes are not live yet.`,
      actionId: 'reload-caddy',
      actionLabel: 'Reload Caddy',
      actionBusy: false,
    });
  };

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

  const refreshAppStatus = async (check = false, updateChannel = '') => {
    if (localTest) return;
    try {
      const endpoint = check ? '/api/app/check-updates' : '/api/app/status';
      const opts = check
        ? { method: 'POST', body: JSON.stringify({ updateChannel: updateChannel || settings?.updateChannel || '' }) }
        : {};
      setAppInfo(await api(endpoint, opts));
    }
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
    try {
      const result = await api('/api/config/validate', { method: 'POST', body: JSON.stringify({ content: config?.content || '' }) });
      if (result.ok) {
        setActionResult({ ok: true, level: 'success', message: result.stdout || 'Validation passed.' });
      } else {
        const parsedWarning = parseValidationWarning(result);
        setActionResult({
          ok: false,
          level: parsedWarning.canFormat ? 'warning' : 'error',
          message: parsedWarning.message || 'Validation failed.',
          actionId: parsedWarning.canFormat ? 'format-config' : '',
          actionLabel: parsedWarning.canFormat ? 'Run caddy fmt --overwrite' : '',
          actionBusy: false,
        });
      }
    }
    catch (e) { setActionResult({ ok: false, message: e.message }); }
    finally { setCaddyBusy(false); }
  };

  const runFormatFixGlobal = async () => {
    if (!canEdit || actionBusy) return;
    if (localTest) {
      setActionResult({ ok: false, level: 'error', message: 'Formatting fix is not available in local test mode.' });
      return;
    }
    setActionBusy(true);
    setActionResult((current) => (current ? { ...current, actionBusy: true } : current));
    setError('');
    try {
      const formatResult = await api('/api/config/format', {
        method: 'POST',
        body: JSON.stringify({ content: config?.content || '' }),
      });
      if (!formatResult.changed) {
        setActionResult({ ok: true, level: 'success', message: 'Config is already formatted.' });
        return;
      }
      const nextContent = String(formatResult.content || '');
      const saved = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ content: nextContent, validate: true }),
      });
      setConfig((current) => ({ ...current, content: nextContent, parsed: saved.parsed, health: saved.health || current.health }));
      if ((settings?.configMode || 'file') === 'api') {
        setActionResult({ ok: true, level: 'success', message: 'Formatted and saved config.' });
      } else {
        notifyConfigChangedNeedsReload('Formatted and saved config.');
      }
    } catch (e) {
      setActionResult({ ok: false, level: 'error', message: e.message || 'Formatting fix failed.' });
    } finally {
      setActionBusy(false);
    }
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
  const checkUpdates = async () => {
    setCheckingUpdates(true);
    try {
      await refreshAppStatus(true, settings?.updateChannel || '');
    } finally {
      setCheckingUpdates(false);
    }
  };
  const runUpdate = async () => {
    setUpdating(true);
    setUpdateMessage('Preparing update...');
    setError('');
    try {
      const updateChannel = settings?.updateChannel || '';
      let baseline = appInfo;
      try {
        baseline = await api('/api/app/check-updates', {
          method: 'POST',
          body: JSON.stringify({ updateChannel }),
        });
        setAppInfo(baseline);
      } catch {}
      const baselineCommit = baseline?.localCommit || '';
      const baselineVersion = baseline?.version || baseline?.localVersion || APP_VERSION;
      const targetVersion = baseline?.availableVersion || baseline?.remoteVersion || '';
      setUpdateMessage(targetVersion ? `Updating to ${targetVersion}...` : 'Updating...');

      await api('/api/app/update', {
        method: 'POST',
        body: JSON.stringify({ updateChannel }),
      });
      const started = Date.now();
      let confirmedReadyCount = 0;
      while (Date.now() - started < 240000) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        try {
          const status = await api('/api/app/check-updates', {
            method: 'POST',
            body: JSON.stringify({ updateChannel }),
          });
          setAppInfo(status);
          const commitChanged = Boolean(
            baselineCommit &&
            status.localCommit &&
            baselineCommit !== status.localCommit
          );
          const versionChanged = Boolean(
            baselineVersion &&
            status.version &&
            baselineVersion !== status.version
          );
          const branchAligned = !status.branch || !status.currentBranch || status.branch === status.currentBranch;
          const upToDate =
            status.updateAvailable === false &&
            Boolean(status.localCommit) &&
            Boolean(status.remoteCommit) &&
            status.localCommit === status.remoteCommit;
          if (upToDate && branchAligned && (commitChanged || versionChanged || !baseline?.updateAvailable)) {
            confirmedReadyCount += 1;
          } else {
            confirmedReadyCount = 0;
          }
          if (status.updateAvailable) {
            setUpdateMessage(`Installing update ${status.availableVersion || status.remoteVersion || ''}...`);
          } else {
            setUpdateMessage('Waiting for updated app to come online...');
          }
          if (confirmedReadyCount >= 2) {
            const nextVersion = status.version || status.localVersion || targetVersion || baselineVersion;
            setAppInfo((prev) => ({
              ...prev,
              ...status,
              version: nextVersion,
              localVersion: nextVersion,
              availableVersion: nextVersion,
              remoteVersion: status.remoteVersion || nextVersion,
              updateAvailable: false,
            }));
            setUpdating(false);
            setUpdateMessage('');
            setActionResult({ ok: true, message: `Updated to ${nextVersion}. Reloading...` });
            const url = new URL(window.location.href);
            url.searchParams.set('v', String(Date.now()));
            setTimeout(() => window.location.replace(url.toString()), 600);
            return;
          }
        } catch {
          confirmedReadyCount = 0;
          setUpdateMessage('Restarting service...');
        }
      }
      setUpdating(false);
      setUpdateMessage('');
      setActionResult({ ok: false, message: 'Update is still running or not ready yet. Check install log.' });
    } catch (e) {
      setError(e.message);
      setUpdating(false);
      setUpdateMessage('');
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
      appVersion={APP_VERSION}
      actionResult={actionResult}
      onDismissActionResult={() => setActionResult(null)}
      onActionResultAction={() => {
        if (actionResult?.actionId === 'format-config') runFormatFixGlobal();
        if (actionResult?.actionId === 'reload-caddy') setReloadConfirmOpen(true);
      }}
    >
      {error && <Notice type="error">{error}</Notice>}
      {updating && (
        <div className="updating-screen">
          <div className="updating-card">
            <Loader2 className="spin" />
            <h3>Updating CaddyUI</h3>
            <p>{updateMessage || 'Please wait...'}</p>
          </div>
        </div>
      )}
      {page === 'proxies' && (
        <Proxies
          config={config}
          refresh={refreshConfig}
          setConfig={setConfig}
          canEdit={canEdit}
          theme={theme}
          health={health}
          loading={configLoading}
          api={api}
          onConfigChanged={notifyConfigChangedNeedsReload}
        />
      )}
      {page === 'middlewares' && (
        <Middlewares
          config={config}
          setConfig={setConfig}
          canEdit={canEdit}
          theme={theme}
          api={api}
          onConfigChanged={notifyConfigChangedNeedsReload}
        />
      )}
      {page === 'configuration' && (
        <Configuration
          config={config}
          setConfig={setConfig}
          refresh={refreshConfig}
          canEdit={canEdit}
          theme={theme}
          api={api}
          onConfigChanged={notifyConfigChangedNeedsReload}
        />
      )}
      {page === 'logs' && <Logs api={api} />}
      {page === 'settings' && (
        <SettingsPage settings={settings} setSettings={setSettings} canEdit={canEdit} canAdmin={canAdmin} api={api} />
      )}
      <ReloadConfirmModal
        open={reloadConfirmOpen}
        busy={caddyBusy}
        onCancel={() => setReloadConfirmOpen(false)}
        onConfirm={reloadCaddyGlobal}
      />
    </Shell>
  );
}
