import React, { useEffect, useState } from 'react';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

export default function SettingsPage({ settings, setSettings, canEdit, canAdmin, api }) {
  const [form, setForm] = useState({
    caddyfilePath: settings.caddyfilePath || '',
    logPaths: (settings.logPaths || []).join('\n'),
    trustProxyHops: String(settings.trustProxyHops ?? 0),
    allowRemoteSetup: Boolean(settings.allowRemoteSetup),
    secureCookieMode: settings.secureCookieMode || 'auto',
    allowedOrigins: (settings.allowedOrigins || []).join('\n'),
  });
  const [updateChannel, setUpdateChannel] = useState(settings.updateChannel || 'stable');
  const [msg, setMsg] = useState('');
  const [users, setUsers] = useState([]);
  const [discovered, setDiscovered] = useState({ caddyfiles: [], logfiles: [] });
  const [scanning, setScanning] = useState(false);
  const [userForm, setUserForm] = useState({ username: '', password: '', role: 'view' });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const configuredLogCount = form.logPaths
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean).length;

  useEffect(() => {
    setForm({
      caddyfilePath: settings.caddyfilePath || '',
      logPaths: (settings.logPaths || []).join('\n'),
      trustProxyHops: String(settings.trustProxyHops ?? 0),
      allowRemoteSetup: Boolean(settings.allowRemoteSetup),
      secureCookieMode: settings.secureCookieMode || 'auto',
      allowedOrigins: (settings.allowedOrigins || []).join('\n'),
    });
  }, [settings.caddyfilePath, settings.logPaths, settings.trustProxyHops, settings.allowRemoteSetup, settings.secureCookieMode, settings.allowedOrigins]);

  useEffect(() => {
    setUpdateChannel(settings.updateChannel || 'stable');
  }, [settings.updateChannel]);

  const selectUpdateChannel = (nextChannel) => {
    setUpdateChannel(nextChannel);
    setSettings((current) => ({ ...(current || {}), updateChannel: nextChannel }));
  };

  useEffect(() => {
    if (!canAdmin || localTest) return;
    api('/api/users')
      .then((res) => setUsers(res.users))
      .catch(() => {});
  }, [canAdmin]);

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
    const nextLogPaths = form.logPaths
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    const nextAllowedOrigins = form.allowedOrigins
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    const nextTrustProxyHops = Number(form.trustProxyHops || 0);

    if (localTest) {
      setSettings({
        ...settings,
        caddyfilePath: form.caddyfilePath,
        logPaths: nextLogPaths,
        trustProxyHops: Number.isFinite(nextTrustProxyHops) && nextTrustProxyHops > 0 ? Math.floor(nextTrustProxyHops) : 0,
        allowRemoteSetup: Boolean(form.allowRemoteSetup),
        secureCookieMode: form.secureCookieMode || 'auto',
        allowedOrigins: nextAllowedOrigins,
      });
      setMsg('Saved in browser only.');
      return;
    }

    try {
      const payload = {
        caddyfilePath: form.caddyfilePath,
        logPaths: nextLogPaths,
      };
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
      setMsg('Settings saved.');
    } catch (err) {
      setMsg(err.message);
    }
  };

  const saveUpdateChannel = async (e) => {
    e.preventDefault();
    setMsg('');
    if (!canAdmin) return;

    if (localTest) {
      setSettings({ ...settings, updateChannel });
      setMsg('Update channel saved in browser only.');
      return;
    }

    try {
      const r = await api('/api/settings/update-channel', {
        method: 'PUT',
        body: JSON.stringify({ updateChannel }),
      });
      setSettings(r.settings);
      setMsg('Update channel saved.');
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
      <div className="settings-page-head">
        <h2>Settings</h2>
        <p>Configuration, access, and updates.</p>
      </div>

      <div className="settings-overview">
        <div>
          <span>Role</span>
          <b>{settings.role || 'view'}</b>
        </div>
        <div>
          <span>Update channel</span>
          <b>{settings.updateChannel || 'stable'}</b>
        </div>
        <div>
          <span>Caddyfile</span>
          <b>{settings.caddyfilePath || 'not set'}</b>
        </div>
        <div>
          <span>Log paths</span>
          <b>{configuredLogCount}</b>
        </div>
        <div>
          <span>Trusted proxy hops</span>
          <b>{settings.trustProxyHops ?? 0}</b>
        </div>
        <div>
          <span>Cookie mode</span>
          <b>{settings.secureCookieMode || 'auto'}</b>
        </div>
      </div>

      <form className="settings-form" onSubmit={save}>
        <div className="settings-section-head">
          <h3>Caddy configuration</h3>
          <p>Set the Caddyfile path and log locations used by CaddyUI.</p>
        </div>
        <label>
          Caddyfile path
          <input
            value={form.caddyfilePath}
            onChange={(e) => setForm({ ...form, caddyfilePath: e.target.value })}
            readOnly={!canEdit}
          />
        </label>
        <div className="toolbar">
          <button type="button" onClick={scanFiles} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan Caddyfiles'}
          </button>
          {discovered.caddyfiles.length > 0 && (
            <select
              value=""
              onChange={(e) => e.target.value && setForm({ ...form, caddyfilePath: e.target.value })}
            >
              <option value="">Select discovered Caddyfile</option>
              {discovered.caddyfiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          )}
        </div>

        <label>
          Log paths
          <textarea
            rows="8"
            value={form.logPaths}
            onChange={(e) => setForm({ ...form, logPaths: e.target.value })}
            readOnly={!canEdit}
          />
        </label>
        <div className="toolbar">
          <button type="button" onClick={scanFiles} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan log files'}
          </button>
          {discovered.logfiles.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                const lines = new Set(
                  form.logPaths
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean)
                );
                lines.add(e.target.value);
                setForm({ ...form, logPaths: [...lines].join('\n') });
              }}
            >
              <option value="">Add discovered log file</option>
              {discovered.logfiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="settings-section-head">
          <h3>Security</h3>
          <p>Trusted proxy, cookie behavior, setup access, and extra allowed origins.</p>
        </div>
        <label>
          Trust proxy hops
          <input
            type="number"
            min="0"
            value={form.trustProxyHops}
            onChange={(e) => setForm({ ...form, trustProxyHops: e.target.value })}
            readOnly={!canAdmin}
          />
        </label>
        <label>
          Cookie mode
          <select
            value={form.secureCookieMode}
            onChange={(e) => setForm({ ...form, secureCookieMode: e.target.value })}
            disabled={!canAdmin}
          >
            <option value="auto">auto</option>
            <option value="secure">secure</option>
            <option value="insecure">insecure</option>
          </select>
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={Boolean(form.allowRemoteSetup)}
            onChange={(e) => setForm({ ...form, allowRemoteSetup: e.target.checked })}
            disabled={!canAdmin}
          />
          Allow first-time setup from public IPs
        </label>
        <label>
          Additional allowed origins
          <textarea
            rows="4"
            value={form.allowedOrigins}
            onChange={(e) => setForm({ ...form, allowedOrigins: e.target.value })}
            readOnly={!canAdmin}
          />
        </label>
        {canEdit && <button className="primary">Save settings</button>}
      </form>

      <form className="settings-form" onSubmit={changePassword}>
        <div className="settings-section-head">
          <h3>Password</h3>
          <p>Change your current account password.</p>
        </div>
        <label>
          Current password
          <input
            type="password"
            value={passwordForm.currentPassword}
            onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
          />
        </label>
        <label>
          New password
          <input
            type="password"
            minLength={8}
            value={passwordForm.newPassword}
            onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
          />
        </label>
        <button className="primary">Change password</button>
      </form>

      {canAdmin && (
        <div className="settings-form">
          <div className="settings-section-head">
            <h3>Users</h3>
            <p>Add users and control permissions.</p>
          </div>
          <form className="users-add" onSubmit={addUser}>
            <input
              placeholder="username"
              value={userForm.username}
              onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
            />
            <input
              placeholder="password"
              type="password"
              minLength={8}
              value={userForm.password}
              onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
            />
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
                <button
                  className="danger"
                  type="button"
                  onClick={() => removeUser(user.username)}
                  disabled={user.username === settings.username}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {canAdmin && (
        <details className="settings-form settings-danger settings-collapsible">
          <summary>DANGER ZONE</summary>
          <form onSubmit={saveUpdateChannel}>
            <div className="settings-section-head">
              <h3>Danger</h3>
              <p>Set which release channel is used for update checks and installs.</p>
            </div>
            <label>
              Update channel
              <select value={updateChannel} onChange={(e) => selectUpdateChannel(e.target.value)}>
                <option value="stable">stable</option>
                <option value="beta">beta</option>
                <option value="dev">dev</option>
              </select>
            </label>
            <p>Updates and update checks use this channel.</p>
            <button className="danger">Save update channel</button>
          </form>
        </details>
      )}

      {msg && <p className="settings-message">{msg}</p>}
    </section>
  );
}
