import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns/promises';
import { parseCaddyfile, appendSimpleProxy, updateSimpleProxy, appendSnippet, updateSnippet, deleteBlockAtLine } from './caddyParser.js';

const app = express();
const PORT = Number(process.env.CADDY_UI_PORT || process.env.PORT || 8787);
const ROOT = process.cwd();
const DATA_DIR = process.env.CADDY_UI_DATA_DIR || path.join(ROOT, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const JWT_SECRET = process.env.CADDY_UI_SECRET || 'dev-change-me-caddy-ui';
const COOKIE_NAME = 'caddyui_token';
const COMMON_CADDYFILES = [
  path.join(ROOT, 'Caddyfile'),
  '/etc/caddy/Caddyfile',
  '/config/Caddyfile',
  '/data/caddy/Caddyfile',
  '/srv/caddy/Caddyfile',
  '/usr/local/etc/caddy/Caddyfile',
];
const COMMON_LOGS = [
  process.env.CADDY_LOG_PATH,
  '/var/log/caddy/access.log',
  '/var/log/caddy/error.log',
  '/var/log/caddy/caddy.log',
  '/data/caddy/logs/access.log',
  '/config/log/caddy.log',
].filter(Boolean);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

async function ensureDataDir() { await fs.mkdir(DATA_DIR, { recursive: true }); }
async function loadSettings() {
  await ensureDataDir();
  try { return JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8')); }
  catch { return { configured: false, caddyfilePath: '', logPaths: COMMON_LOGS, user: null }; }
}
async function saveSettings(settings) {
  await ensureDataDir();
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
const publicSettings = (s) => ({ userConfigured: Boolean(s.user), caddyConfigured: Boolean(s.configured && s.caddyfilePath), configured: Boolean(s.configured && s.user && s.caddyfilePath), caddyfilePath: s.caddyfilePath || '', logPaths: s.logPaths || COMMON_LOGS, username: s.user?.username || '' });

function sign(username) { return jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' }); }
function auth(req, res, next) {
  const token = req.cookies[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired' }); }
}
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}
async function scanExistingFiles(candidates) {
  const found = [];
  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) found.push({ path: candidate, size: stat.size, modified: stat.mtimeMs });
    } catch {}
  }
  return found;
}
async function scanCaddyfiles() { return scanExistingFiles(COMMON_CADDYFILES); }
async function scanLogfiles(settings = {}) { return scanExistingFiles([...(settings.logPaths || []), ...COMMON_LOGS]); }
function authenticatedUser(req) {
  const token = req.cookies?.[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
async function readConfiguredCaddyfile() {
  const settings = await loadSettings();
  if (!settings.caddyfilePath) throw new Error('No Caddyfile path configured.');
  const content = await fs.readFile(settings.caddyfilePath, 'utf8');
  return { settings, content };
}
async function tailFile(filePath, lines = 200) {
  const content = await fs.readFile(filePath, 'utf8');
  return content.split('\n').slice(-lines).join('\n');
}

function splitHostPort(value = '') {
  const clean = String(value).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const [host, port] = clean.split(':');
  return { host, port: Number(port || 80) };
}
function tcpCheck(host, port, timeout = 1800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (online, error = '') => { socket.destroy(); resolve({ online, error }); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}
async function checkProxyHealth(parsed) {
  const results = {};
  await Promise.all((parsed.sites || []).map(async (site) => {
    const domain = site.addresses?.[0] || '';
    const upstream = site.proxies?.[0]?.upstreams?.[0] || '';
    const target = splitHostPort(upstream);
    const domainHost = splitHostPort(domain).host;
    const [local, domainResult] = await Promise.all([
      target.host ? tcpCheck(target.host, target.port) : { online: false, error: 'missing' },
      domainHost ? dns.lookup(domainHost).then(() => tcpCheck(domainHost, 443)).catch((err) => ({ online: false, error: err.code || err.message })) : { online: false, error: 'missing' },
    ]);
    results[site.id] = { local: { ...local, host: target.host, port: target.port }, domain: { ...domainResult, host: domainHost, port: 443 } };
  }));
  return results;
}

async function collectLogs(settings, lines = 200) {
  const paths = [...new Set([...(settings.logPaths || []), ...COMMON_LOGS])].filter(Boolean);
  const entries = [];
  for (const logPath of paths) {
    try {
      const stat = await fs.stat(logPath);
      if (stat.isFile()) entries.push({ source: logPath, content: await tailFile(logPath, lines), ok: true });
    } catch {}
  }
  if (entries.length === 0) {
    entries.push({ source: 'not-found', ok: false, content: 'No Caddy log files found. Configure a log path in Settings or mount Caddy logs into this container.' });
  }
  return entries;
}

app.get('/api/status', async (req, res) => {
  const settings = await loadSettings();
  res.json({ settings: publicSettings(settings), authenticated: Boolean(authenticatedUser(req)), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(settings) } });
});
app.post('/api/setup/user', async (req, res) => {
  const settings = await loadSettings();
  if (settings.user) return res.status(409).json({ error: 'Admin user is already configured.' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Username and a password of at least 8 characters are required.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const next = { ...settings, configured: false, user: { username, passwordHash } };
  await saveSettings(next);
  res.cookie(COOKIE_NAME, sign(username), { httpOnly: true, sameSite: 'lax', secure: false });
  res.json({ settings: publicSettings(next), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) } });
});
app.post('/api/setup/config', auth, async (req, res) => {
  const settings = await loadSettings();
  const { caddyfilePath, logPaths = [] } = req.body || {};
  if (!caddyfilePath || !fssync.existsSync(caddyfilePath)) return res.status(400).json({ error: 'A readable Caddyfile path is required.' });
  const next = { ...settings, configured: true, caddyfilePath, logPaths: [...new Set([...logPaths, ...COMMON_LOGS].filter(Boolean))] };
  await saveSettings(next);
  res.json({ settings: publicSettings(next), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) } });
});
app.post('/api/onboard', async (req, res) => {
  const settings = await loadSettings();
  if (settings.configured && settings.user) return res.status(409).json({ error: 'CaddyUI is already configured.' });
  const { username, password, caddyfilePath, logPaths = [] } = req.body || {};
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Username and a password of at least 8 characters are required.' });
  if (!caddyfilePath || !fssync.existsSync(caddyfilePath)) return res.status(400).json({ error: 'A readable Caddyfile path is required.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const next = { configured: true, caddyfilePath, logPaths: [...new Set([...logPaths, ...COMMON_LOGS].filter(Boolean))], user: { username, passwordHash } };
  await saveSettings(next);
  res.cookie(COOKIE_NAME, sign(username), { httpOnly: true, sameSite: 'lax', secure: false });
  res.json({ settings: publicSettings(next), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) } });
});
app.post('/api/login', async (req, res) => {
  const settings = await loadSettings();
  const { username, password } = req.body || {};
  if (!settings.user || username !== settings.user.username || !(await bcrypt.compare(password || '', settings.user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  res.cookie(COOKIE_NAME, sign(username), { httpOnly: true, sameSite: 'lax', secure: false });
  res.json({ settings: publicSettings(settings) });
});
app.post('/api/logout', (_req, res) => { res.clearCookie(COOKIE_NAME); res.json({ ok: true }); });
app.get('/api/config', auth, async (_req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const parsed = parseCaddyfile(content);
    res.json({ path: settings.caddyfilePath, content, parsed, health: await checkProxyHealth(parsed) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/config', auth, async (req, res) => {
  try {
    const settings = await loadSettings();
    const { content, validate = true } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'Config content is required.' });
    if (validate) {
      const validation = await validateConfig(content);
      if (!validation.ok) return res.status(400).json({ error: 'Caddy validation failed.', validation, parsed: parseCaddyfile(content) });
    }
    const backup = `${settings.caddyfilePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    try { await fs.copyFile(settings.caddyfilePath, backup); } catch {}
    await fs.writeFile(settings.caddyfilePath, content, 'utf8');
    res.json({ ok: true, backup, parsed: parseCaddyfile(content) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
async function validateConfig(content) {
  const tmp = path.join(os.tmpdir(), `caddyui-${Date.now()}.Caddyfile`);
  await fs.writeFile(tmp, content, 'utf8');
  const result = await run('caddy', ['validate', '--config', tmp, '--adapter', 'caddyfile']);
  await fs.rm(tmp, { force: true });
  if (result.code === -1) return { ok: false, unavailable: true, stdout: result.stdout, stderr: 'Caddy binary is not available in this container. Install/mount caddy or disable validation for development.' };
  return result;
}
app.get('/api/proxies/health', auth, async (_req, res) => {
  try {
    const { content } = await readConfiguredCaddyfile();
    const parsed = parseCaddyfile(content);
    res.json({ health: await checkProxyHealth(parsed) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/config/validate', auth, async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : (await readConfiguredCaddyfile()).content;
  res.json(await validateConfig(content));
});
app.post('/api/config/reload', auth, async (_req, res) => {
  const settings = await loadSettings();
  const result = await run('caddy', ['reload', '--config', settings.caddyfilePath, '--adapter', 'caddyfile']);
  if (result.code === -1) return res.status(503).json({ ...result, stderr: 'Caddy binary is not available in this container. Run CaddyUI where it can execute caddy reload.' });
  res.status(result.ok ? 200 : 400).json(result);
});
app.post('/api/proxies', auth, async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = appendSimpleProxy(content, req.body || {});
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/proxies/:line', auth, async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = updateSimpleProxy(content, { ...req.body, siteLine: req.params.line });
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});



app.delete('/api/proxies/:line', auth, async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = deleteBlockAtLine(content, req.params.line);
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/middlewares', auth, async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = appendSnippet(content, req.body || {});
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/middlewares/:line', auth, async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = updateSnippet(content, { ...req.body, line: req.params.line });
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});


app.delete('/api/middlewares/:line', auth, async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = deleteBlockAtLine(content, req.params.line);
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/logs', auth, async (req, res) => {
  const settings = await loadSettings();
  res.json({ logs: await collectLogs(settings, Number(req.query.lines || 200)) });
});
app.get('/api/settings', auth, async (_req, res) => { const settings = await loadSettings(); res.json({ settings: publicSettings(settings), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(settings) } }); });
app.post('/api/settings', auth, async (req, res) => {
  const settings = await loadSettings();
  const { caddyfilePath, logPaths } = req.body || {};
  if (caddyfilePath && !fssync.existsSync(caddyfilePath)) return res.status(400).json({ error: 'Caddyfile path does not exist.' });
  const next = { ...settings, caddyfilePath: caddyfilePath || settings.caddyfilePath, logPaths: Array.isArray(logPaths) ? logPaths.filter(Boolean) : settings.logPaths };
  await saveSettings(next);
  res.json({ settings: publicSettings(next) });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.listen(PORT, () => console.log(`CaddyUI API listening on :${PORT}`));
