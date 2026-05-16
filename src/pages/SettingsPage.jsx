import React, { useEffect, useState } from 'react';
import { Notice, TypedConfirmModal } from '../components/common.jsx';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';
const sectionItems = [
  ['connection', 'Connection'],
  ['security', 'Security'],
  ['account', 'Account'],
  ['users', 'Users'],
  ['updates', 'Updates'],
  ['danger', 'Danger'],
];

export default function SettingsPage({ settings, setSettings, canEdit, canAdmin, api, notify, refreshConfig, setStatus }) {
  const [activeSection, setActiveSection] = useState('connection');
  const [form, setForm] = useState({
    configMode: settings.configMode || 'api',
    caddyfilePath: settings.caddyfilePath || '',
    caddyApiUrl: settings.caddyApiUrl || 'http://127.0.0.1:2019',
    caddyApiToken: '',
    logPaths: (settings.logPaths || []).join('\n'),
    trustProxyHops: String(settings.trustProxyHops ?? 0),
    allowRemoteSetup: Boolean(settings.allowRemoteSetup),
    secureCookieMode: settings.secureCookieMode || 'auto',
    allowedOrigins: (settings.allowedOrigins || []).join('\n'),
  });
  const [clearCaddyApiSecret, setClearCaddyApiSecret] = useState(false);
  const [updateChannel, setUpdateChannel] = useState(settings.updateChannel || 'stable');
  const [msg, setMsg] = useState('');
  const [users, setUsers] = useState([]);
  const [discovered, setDiscovered] = useState({ caddyfiles: [], logfiles: [] });
  const [scanning, setScanning] = useState(false);
  const [testingApi, setTestingApi] = useState(false);
  const [userForm, setUserForm] = useState({ username: '', password: '', role: 'view' });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [dangerModal, setDangerModal] = useState({ open: false, kind: '', value: '' });
  const [dangerBusy, setDangerBusy] = useState(false);
  const configuredLogCount = form.logPaths
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean).length;

  useEffect(() => {
    setForm({
      configMode: settings.configMode || 'api',
      caddyfilePath: settings.caddyfilePath || '',
      caddyApiUrl: settings.caddyApiUrl || 'http://127.0.0.1:2019',
      caddyApiToken: '',
      logPaths: (settings.logPaths || []).join('\n'),
      trustProxyHops: String(settings.trustProxyHops ?? 0),
      allowRemoteSetup: Boolean(settings.allowRemoteSetup),
      secureCookieMode: settings.secureCookieMode || 'auto',
      allowedOrigins: (settings.allowedOrigins || []).join('\n'),
    });
    setClearCaddyApiSecret(false);
  }, [settings.configMode, settings.caddyfilePath, settings.caddyApiUrl, settings.logPaths, settings.trustProxyHops, settings.allowRemoteSetup, settings.secureCookieMode, settings.allowedOrigins]);

  useEffect(() => {
    setUpdateChannel(settings.updateChannel || 'stable');
  }, [settings.updateChannel]);

  useEffect(() => {
    if (!canAdmin || localTest) return;
    api('/api/users')
      .then((res) => setUsers(res.users))
      .catch(() => {});
  }, [canAdmin]);

  const setNotice = (text = '') => {
    setMsg(text);
    if (text) notify?.({ ok: !/error|invalid|failed|forbidden/i.test(text), level: /error|invalid|failed|forbidden/i.test(text) ? 'error' : 'success', message: text });
  };

  const scanFiles = async () => {
    if (localTest) return;
    setScanning(true);
    setMsg('');
    try {
      const res = await api('/api/settings');
      setDiscovered(res.discovered || { caddyfiles: [], logfiles: [] });
    } catch (err) {
      setMsg(err.message);
    } finally {
      setScanning(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    if (!canEdit) return;
    const nextLogPaths = form.logPaths.split('\n').map((x) => x.trim()).filter(Boolean);
    const nextAllowedOrigins = form.allowedOrigins.split('\n').map((x) => x.trim()).filter(Boolean);
    const nextTrustProxyHops = Number(form.trustProxyHops || 0);

    if (localTest) {
      setSettings({
        ...settings,
        configMode: form.configMode || 'api',
        caddyfilePath: form.caddyfilePath,
        caddyApiUrl: form.caddyApiUrl,
        hasCaddyApiToken: clearCaddyApiSecret ? false : form.caddyApiToken.trim() ? true : Boolean(settings.hasCaddyApiToken),
        hasCaddyApiSecret: clearCaddyApiSecret ? false : form.caddyApiToken.trim() ? true : Boolean(settings.hasCaddyApiSecret || settings.hasCaddyApiToken),
        logPaths: nextLogPaths,
        trustProxyHops: Number.isFinite(nextTrustProxyHops) && nextTrustProxyHops > 0 ? Math.floor(nextTrustProxyHops) : 0,
        allowRemoteSetup: Boolean(form.allowRemoteSetup),
        secureCookieMode: form.secureCookieMode || 'auto',
        allowedOrigins: nextAllowedOrigins,
      });
      setNotice('Saved in browser only.');
      return;
    }

    try {
      const payload = {
        configMode: form.configMode || 'api',
        caddyfilePath: form.caddyfilePath,
        caddyApiUrl: form.caddyApiUrl,
        logPaths: nextLogPaths,
      };
      if (form.caddyApiToken.trim()) payload.caddyApiSecret = form.caddyApiToken.trim();
      if (clearCaddyApiSecret) payload.caddyApiSecretClear = true;
      if (canAdmin) {
        payload.trustProxyHops = Number.isFinite(nextTrustProxyHops) && nextTrustProxyHops > 0 ? Math.floor(nextTrustProxyHops) : 0;
        payload.allowRemoteSetup = Boolean(form.allowRemoteSetup);
        payload.secureCookieMode = form.secureCookieMode || 'auto';
        payload.allowedOrigins = nextAllowedOrigins;
      }
      const r = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setSettings(r.settings);
      setNotice('Settings saved.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const testApiUrl = async () => {
    if (!canEdit) return;
    if (localTest) {
      notify?.({ ok: true, level: 'success', message: 'Local test mode: API URL looks good.' });
      return;
    }
    setTestingApi(true);
    setMsg('');
    try {
      const res = await api('/api/settings/test-api', {
        method: 'POST',
        body: JSON.stringify({
          caddyApiUrl: form.caddyApiUrl,
          caddyApiSecret: form.caddyApiToken.trim(),
        }),
      });
      notify?.({ ok: true, level: 'success', message: res.message || 'Connected to Caddy API.' });
    } catch (err) {
      notify?.({ ok: false, level: 'error', message: err.message || 'Caddy API test failed.' });
      setMsg(err.message);
    } finally {
      setTestingApi(false);
    }
  };

  const saveUpdateChannel = async (e) => {
    e.preventDefault();
    setMsg('');
    if (!canAdmin) return;

    if (localTest) {
      setSettings({ ...settings, updateChannel });
      setNotice('Update channel saved in browser only.');
      return;
    }

    try {
      const r = await api('/api/settings/update-channel', {
        method: 'PUT',
        body: JSON.stringify({ updateChannel }),
      });
      setSettings(r.settings);
      setNotice('Update channel saved.');
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
      setNotice('User added.');
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
      setNotice(`Updated ${username}.`);
    } catch (err) {
      setMsg(err.message);
    }
  };

  const removeUser = async (username) => {
    try {
      const res = await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      setUsers(res.users);
      setNotice('User deleted.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify(passwordForm) });
      setPasswordForm({ currentPassword: '', newPassword: '' });
      setNotice('Password updated.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const runDangerAction = async () => {
    if (!dangerModal.open || dangerModal.value.trim() !== settings.username) return;
    setDangerBusy(true);
    try {
      if (dangerModal.kind === 'reset-config') {
        const res = await api('/api/settings/reset-caddy-config', {
          method: 'POST',
          body: JSON.stringify({ username: dangerModal.value.trim() }),
        });
        setDangerModal({ open: false, kind: '', value: '' });
        setConfigFromReset(res);
        notify?.({ ok: true, level: 'warning', message: 'Caddy config reset to template.' });
        return;
      }
      if (dangerModal.kind === 'reset-onboarding') {
        await api('/api/settings/reset-onboarding', {
          method: 'POST',
          body: JSON.stringify({ username: dangerModal.value.trim() }),
        });
        setDangerModal({ open: false, kind: '', value: '' });
        notify?.({ ok: true, level: 'warning', message: 'CaddyUI reset to onboarding.' });
        window.location.reload();
      }
    } catch (err) {
      setMsg(err.message);
    } finally {
      setDangerBusy(false);
    }
  };

  const setConfigFromReset = (res) => {
    if (!res?.parsed || !refreshConfig) return;
    refreshConfig();
  };

  const openDangerModal = (kind) => setDangerModal({ open: true, kind, value: '' });

  return (
    <section>
      <div className="settings-page-head">
        <h2>Settings</h2>
        <p>Connection, security, users, updates, and recovery tools.</p>
      </div>

      <div className="settings-overview">
        <div><span>Role</span><b>{settings.role || 'view'}</b></div>
        <div><span>Mode</span><b>{settings.configMode || 'api'}</b></div>
        <div><span>Caddy API URL</span><b>{settings.caddyApiUrl || 'not set'}</b></div>
        <div><span>Caddyfile</span><b>{settings.caddyfilePath || 'not set'}</b></div>
        <div><span>API secret</span><b>{(settings.hasCaddyApiSecret || settings.hasCaddyApiToken) ? 'configured' : 'not set'}</b></div>
        <div><span>Log paths</span><b>{configuredLogCount}</b></div>
        <div><span>Trusted proxy hops</span><b>{settings.trustProxyHops ?? 0}</b></div>
        <div><span>Update channel</span><b>{settings.updateChannel || 'stable'}</b></div>
      </div>

      <div className="settings-layout">
        <aside className="settings-subnav">
          {sectionItems.map(([id, label]) => (
            <button key={id} type="button" className={activeSection === id ? 'active' : ''} onClick={() => setActiveSection(id)}>
              {label}
            </button>
          ))}
        </aside>

        <div className="settings-panels">
          {msg && <Notice type={/error|invalid|failed|forbidden/i.test(msg) ? 'error' : 'success'}>{msg}</Notice>}

          {activeSection === 'connection' && (
            <form className="settings-form settings-card-grid" onSubmit={save}>
              <div className="settings-section-head">
                <h3>Connection</h3>
                <p>API mode is the default. File mode stays available when you want direct Caddyfile writes.</p>
              </div>
              <div className="settings-card">
                <h4>Config source</h4>
                <label>
                  Config mode
                  <select value={form.configMode} onChange={(e) => setForm({ ...form, configMode: e.target.value })} disabled={!canEdit}>
                    <option value="api">api</option>
                    <option value="file">file</option>
                  </select>
                </label>
                <label>
                  Caddyfile path
                  <input value={form.caddyfilePath} onChange={(e) => setForm({ ...form, caddyfilePath: e.target.value })} readOnly={!canEdit || form.configMode === 'api'} />
                </label>
                <div className="toolbar">
                  <button type="button" onClick={scanFiles} disabled={scanning}>{scanning ? 'Scanning...' : 'Scan Caddyfiles'}</button>
                  {discovered.caddyfiles.length > 0 && (
                    <select value="" onChange={(e) => e.target.value && setForm({ ...form, caddyfilePath: e.target.value })}>
                      <option value="">Select discovered Caddyfile</option>
                      {discovered.caddyfiles.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
                    </select>
                  )}
                </div>
              </div>

              <div className="settings-card">
                <h4>Caddy Admin API</h4>
                <label>
                  Caddy API URL
                  <div className="settings-inline-action">
                    <input value={form.caddyApiUrl} onChange={(e) => setForm({ ...form, caddyApiUrl: e.target.value })} readOnly={!canEdit} placeholder="http://127.0.0.1:2019" />
                    <button type="button" onClick={testApiUrl} disabled={!canEdit || testingApi}>{testingApi ? 'Testing...' : 'Test URL'}</button>
                  </div>
                </label>
                <label>
                  Caddy API secret
                  <input
                    type="password"
                    value={form.caddyApiToken}
                    onChange={(e) => {
                      setClearCaddyApiSecret(false);
                      setForm({ ...form, caddyApiToken: e.target.value });
                    }}
                    readOnly={!canEdit}
                    placeholder={(settings.hasCaddyApiSecret || settings.hasCaddyApiToken) ? 'Stored secret is set. Enter a new value to rotate it.' : 'Optional bearer secret'}
                  />
                </label>
                {(settings.hasCaddyApiSecret || settings.hasCaddyApiToken) && (
                  <label className="settings-toggle">
                    <input type="checkbox" checked={clearCaddyApiSecret} onChange={(e) => { setClearCaddyApiSecret(e.target.checked); if (e.target.checked) setForm({ ...form, caddyApiToken: '' }); }} disabled={!canEdit} />
                    Clear stored Caddy API secret on save
                  </label>
                )}
              </div>

              <div className="settings-card settings-card-wide">
                <h4>Logs</h4>
                <label>
                  Log paths
                  <textarea rows="8" value={form.logPaths} onChange={(e) => setForm({ ...form, logPaths: e.target.value })} readOnly={!canEdit} />
                </label>
                <div className="toolbar">
                  <button type="button" onClick={scanFiles} disabled={scanning}>{scanning ? 'Scanning...' : 'Scan log files'}</button>
                  {discovered.logfiles.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        const lines = new Set(form.logPaths.split('\n').map((x) => x.trim()).filter(Boolean));
                        lines.add(e.target.value);
                        setForm({ ...form, logPaths: [...lines].join('\n') });
                      }}
                    >
                      <option value="">Add discovered log file</option>
                      {discovered.logfiles.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
                    </select>
                  )}
                </div>
              </div>

              {canEdit && <button className="primary">Save connection settings</button>}
            </form>
          )}

          {activeSection === 'security' && (
            <form className="settings-form settings-card-grid" onSubmit={save}>
              <div className="settings-section-head">
                <h3>Security</h3>
                <p>Trusted proxy handling, cookies, setup exposure, and extra origins.</p>
              </div>
              <div className="settings-card">
                <h4>Proxy and cookies</h4>
                <label>
                  Trust proxy hops
                  <input type="number" min="0" value={form.trustProxyHops} onChange={(e) => setForm({ ...form, trustProxyHops: e.target.value })} readOnly={!canAdmin} />
                </label>
                <label>
                  Cookie mode
                  <select value={form.secureCookieMode} onChange={(e) => setForm({ ...form, secureCookieMode: e.target.value })} disabled={!canAdmin}>
                    <option value="auto">auto</option>
                    <option value="secure">secure</option>
                    <option value="insecure">insecure</option>
                  </select>
                </label>
              </div>
              <div className="settings-card">
                <h4>Origin controls</h4>
                <label className="settings-toggle">
                  <input type="checkbox" checked={Boolean(form.allowRemoteSetup)} onChange={(e) => setForm({ ...form, allowRemoteSetup: e.target.checked })} disabled={!canAdmin} />
                  Allow first-time setup from public IPs
                </label>
                <label>
                  Additional allowed origins
                  <textarea rows="6" value={form.allowedOrigins} onChange={(e) => setForm({ ...form, allowedOrigins: e.target.value })} readOnly={!canAdmin} />
                </label>
              </div>
              {canEdit && <button className="primary">Save security settings</button>}
            </form>
          )}

          {activeSection === 'account' && (
            <form className="settings-form" onSubmit={changePassword}>
              <div className="settings-section-head">
                <h3>Password</h3>
                <p>Change your current account password.</p>
              </div>
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
          )}

          {activeSection === 'users' && canAdmin && (
            <div className="settings-form">
              <div className="settings-section-head">
                <h3>Users</h3>
                <p>Add users and control permissions.</p>
              </div>
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
                    <button className="danger" type="button" onClick={() => removeUser(user.username)} disabled={user.username === settings.username}>Delete</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'updates' && canAdmin && (
            <form className="settings-form" onSubmit={saveUpdateChannel}>
              <div className="settings-section-head">
                <h3>Updates</h3>
                <p>Choose which branch channel powers update checks and installs.</p>
              </div>
              <label>
                Update channel
                <select value={updateChannel} onChange={(e) => { setUpdateChannel(e.target.value); setSettings((current) => ({ ...(current || {}), updateChannel: e.target.value })); }}>
                  <option value="stable">stable</option>
                  <option value="beta">beta</option>
                  <option value="dev">dev</option>
                </select>
              </label>
              <button className="primary">Save update channel</button>
            </form>
          )}

          {activeSection === 'danger' && canAdmin && (
            <div className="settings-form settings-danger">
              <div className="settings-section-head">
                <h3>Danger zone</h3>
                <p>These actions are destructive. You will need to type your username to continue.</p>
              </div>
              <div className="settings-danger-actions">
                <div className="settings-danger-card">
                  <h4>Reset Caddy config</h4>
                  <p>Replaces the current config with the template config and keeps a backup when possible.</p>
                  <button type="button" className="danger" onClick={() => openDangerModal('reset-config')}>Reset Caddy config</button>
                </div>
                <div className="settings-danger-card">
                  <h4>Reset CaddyUI onboarding</h4>
                  <p>Clears users and returns the app to first-run onboarding.</p>
                  <button type="button" className="danger" onClick={() => openDangerModal('reset-onboarding')}>Reset CaddyUI</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <TypedConfirmModal
        open={dangerModal.open}
        busy={dangerBusy}
        title={dangerModal.kind === 'reset-config' ? 'Reset Caddy config' : 'Reset CaddyUI to onboarding'}
        message={dangerModal.kind === 'reset-config' ? 'This will overwrite the current config with the reset template.' : 'This will remove users and send the app back to onboarding.'}
        username={settings.username || ''}
        typedValue={dangerModal.value}
        onTypedValueChange={(value) => setDangerModal((current) => ({ ...current, value }))}
        confirmLabel={dangerModal.kind === 'reset-config' ? 'Reset config' : 'Reset CaddyUI'}
        onCancel={() => setDangerModal({ open: false, kind: '', value: '' })}
        onConfirm={runDangerAction}
      />
    </section>
  );
}
