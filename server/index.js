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
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { parseCaddyfile, appendSimpleProxy, updateSimpleProxy, appendSnippet, updateSnippet, deleteBlockAtLine } from './caddyParser.js';

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.CADDY_UI_PORT || process.env.PORT || 8787);
const ROOT = process.cwd();
const APP_VERSION = JSON.parse(fssync.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const DATA_DIR = process.env.CADDY_UI_DATA_DIR || path.join(ROOT, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SECRET = 'dev-change-me-caddy-ui';
const JWT_SECRET = process.env.CADDY_UI_SECRET || DEFAULT_SECRET;
const COOKIE_NAME = 'caddyui_token';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_REMOTE_SETUP = process.env.CADDY_UI_ALLOW_REMOTE_SETUP === '1';
const LOGIN_WINDOW_MS = Number(process.env.CADDY_UI_LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.CADDY_UI_LOGIN_MAX_ATTEMPTS || 5);
const SETUP_TOKEN = process.env.CADDY_UI_SETUP_TOKEN || '';
const SESSION_PATH = path.join(DATA_DIR, 'sessions.json');
const ROLE_LEVEL = { view: 0, edit: 1, admin: 2 };
const LOG_ROOTS = (process.env.CADDY_UI_LOG_ROOTS || ['/var/log/caddy','/data/caddy/logs','/config/log'].join(',')).split(',').map((x) => x.trim()).filter(Boolean);
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

app.set('trust proxy', process.env.CADDY_UI_TRUST_PROXY === '0' ? false : 1);
const loginAttempts = new Map();
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!IS_PRODUCTION) return callback(null, true);
    return callback(null, ALLOWED_ORIGINS.has(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

async function ensureDataDir() { await fs.mkdir(DATA_DIR, { recursive: true }); }

function settingsFileMode() { return 0o600; }

function normalizeUser(user, fallbackRole = 'view') {
  if (!user) return null;
  return { username: String(user.username || '').trim(), passwordHash: user.passwordHash || '', role: user.role || fallbackRole };
}
function normalizeSettings(settings) {
  const base = settings && typeof settings === 'object' ? settings : {};
  const users = Array.isArray(base.users)
    ? base.users.map((user) => normalizeUser(user, 'view')).filter((user) => user && user.username)
    : (base.user ? [normalizeUser(base.user, 'admin')] : []);
  return { configured: Boolean(base.configured), caddyfilePath: base.caddyfilePath || '', logPaths: Array.isArray(base.logPaths) ? base.logPaths : COMMON_LOGS, users };
}
function currentUserRecord(settings, username) {
  const normalized = normalizeSettings(settings);
  return normalized.users.find((user) => user.username === username) || null;
}
function exposeUser(user) {
  return user ? { username: user.username, role: user.role } : null;
}
function hasPermission(role, required) {
  return (ROLE_LEVEL[role] ?? -1) >= (ROLE_LEVEL[required] ?? 99);
}
function requirePermission(required) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, required)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function setupTokenRequired(settings) {
  return IS_PRODUCTION && normalizeSettings(settings).users.length === 0 && Boolean(SETUP_TOKEN);
}
async function loadSessionState() {
  await ensureDataDir();
  try { return JSON.parse(await fs.readFile(SESSION_PATH, 'utf8')); }
  catch { return { revoked: {} }; }
}
async function saveSessionState(state) {
  await ensureDataDir();
  await fs.writeFile(SESSION_PATH, JSON.stringify(state, null, 2), { mode: settingsFileMode() });
  try { await fs.chmod(SESSION_PATH, settingsFileMode()); } catch {}
}
function pruneRevoked(state) {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of Object.entries(state.revoked || {})) {
    if (!exp || exp <= now) delete state.revoked[jti];
  }
  return state;
}
async function tokenRevoked(jti) {
  if (!jti) return false;
  const state = pruneRevoked(await loadSessionState());
  return Boolean(state.revoked?.[jti]);
}
async function revokeToken(decoded) {
  if (!decoded?.jti || !decoded?.exp) return;
  const state = pruneRevoked(await loadSessionState());
  state.revoked[decoded.jti] = decoded.exp;
  await saveSessionState(state);
}
async function allowedLogPath(filePath) {
  try {
    const resolved = await fs.realpath(filePath);
    for (const root of LOG_ROOTS) {
      try {
        const base = await fs.realpath(root);
        if (resolved === base || resolved.startsWith(`${base}${path.sep}`)) return true;
      } catch {}
    }
  } catch {}
  return false;
}
async function scanLogRoot(root, depth = 0) {
  if (depth > 3) return [];
  const entries = [];
  try {
    const base = await fs.realpath(root);
    for (const item of await fs.readdir(base, { withFileTypes: true })) {
      const nextPath = path.join(base, item.name);
      if (item.isDirectory()) entries.push(...(await scanLogRoot(nextPath, depth + 1)));
      else if (item.isFile() && /(caddy|access|error|log)/i.test(item.name)) entries.push(nextPath);
    }
  } catch {}
  return entries;
}

function requestProto(req) {
  return req.headers['x-forwarded-proto']?.toString().split(',')[0].trim().toLowerCase() || (req.secure ? 'https' : 'http');
}
function requestHost(req) {
  const forwarded = req.headers['x-forwarded-host'];
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.headers.host || '';
  return String(host).split(',')[0].trim().toLowerCase();
}
function normalizedOrigin(origin) {
  try { return new URL(origin).origin.toLowerCase(); } catch { return ''; }
}
const ALLOWED_ORIGINS = new Set((process.env.CADDY_UI_ALLOWED_ORIGINS || '').split(',').map((x) => normalizedOrigin(x.trim())).filter(Boolean));
function requestOrigin(req) {
  return normalizedOrigin(req.headers.origin || req.headers.referer || '');
}
function expectedOrigin(req) {
  const proto = requestProto(req);
  const host = requestHost(req);
  return host ? `${proto}://${host}`.toLowerCase() : '';
}
function originAllowed(req) {
  const origin = requestOrigin(req);
  if (!origin) return !IS_PRODUCTION;
  return origin === expectedOrigin(req) || ALLOWED_ORIGINS.has(origin) || (!IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin));
}
function requireTrustedOrigin(req, res, next) {
  if (originAllowed(req)) return next();
  return res.status(403).json({ error: 'Origin not allowed.' });
}
function cookieOptions(req) {
  const secure = process.env.CADDY_UI_INSECURE_COOKIE === '1' ? false : (process.env.CADDY_UI_SECURE_COOKIE === '1' || requestProto(req) === 'https');
  return { httpOnly: true, sameSite: 'strict', secure, path: '/' };
}
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
function privateIp(ip) {
  return /^127\./.test(ip) || ip === '::1' || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}
function requireSetupOrigin(req, res, next) {
  if (ALLOW_REMOTE_SETUP || !IS_PRODUCTION || privateIp(clientIp(req))) return next();
  return res.status(403).json({ error: 'Initial setup is blocked from public addresses.' });
}
function tooManyAttempts(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) { loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS }); return false; }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}
function recordFailedAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) { loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS }); return; }
  entry.count += 1;
}
function clearAttempts(key) { loginAttempts.delete(key); }
if (IS_PRODUCTION && (JWT_SECRET === DEFAULT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error('Set CADDY_UI_SECRET to a strong value.');
}
async function loadSettings() {
  await ensureDataDir();
  try { return normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'))); }
  catch { return normalizeSettings({ configured: false, caddyfilePath: '', logPaths: COMMON_LOGS, users: [] }); }
}
async function saveSettings(settings) {
  await ensureDataDir();
  const normalized = normalizeSettings(settings);
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(normalized, null, 2), { mode: settingsFileMode() });
  try { await fs.chmod(SETTINGS_PATH, settingsFileMode()); } catch {}
}
function publicSettings(settings, currentUsername = '') {
  const normalized = normalizeSettings(settings);
  const currentUser = currentUserRecord(normalized, currentUsername);
  return { userConfigured: normalized.users.length > 0, caddyConfigured: Boolean(normalized.configured && normalized.caddyfilePath), configured: Boolean(normalized.configured && normalized.users.length > 0 && normalized.caddyfilePath), caddyfilePath: normalized.caddyfilePath || '', logPaths: normalized.logPaths || COMMON_LOGS, username: currentUser?.username || '', role: currentUser?.role || '' };
}

function statusSettings(settings, authenticated, currentUsername = '') {
  const normalized = normalizeSettings(settings);
  const currentUser = currentUserRecord(normalized, currentUsername);
  const base = { userConfigured: normalized.users.length > 0, caddyConfigured: Boolean(normalized.configured && normalized.caddyfilePath), configured: Boolean(normalized.configured && normalized.users.length > 0 && normalized.caddyfilePath), setupTokenRequired: setupTokenRequired(normalized), username: authenticated ? currentUser?.username || '' : '', role: authenticated ? currentUser?.role || '' : '' };
  if (!authenticated) return { ...base, caddyfilePath: '', logPaths: [] };
  return { ...base, caddyfilePath: normalized.caddyfilePath || '', logPaths: normalized.logPaths || COMMON_LOGS };
}

function sign(username) { return jwt.sign({ username, jti: randomUUID() }, JWT_SECRET, { expiresIn: '4h' }); }
async function auth(req, res, next) {
  const token = req.cookies[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (await tokenRevoked(decoded.jti)) return res.status(401).json({ error: 'Session expired' });
    const settings = await loadSettings();
    const user = currentUserRecord(settings, decoded.username);
    if (!user) return res.status(401).json({ error: 'Session expired' });
    req.user = exposeUser(user);
    req.userToken = decoded;
    next();
  } catch { res.status(401).json({ error: 'Session expired' }); }
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
async function scanLogfiles(settings = {}) { const discovered = []; for (const root of LOG_ROOTS) discovered.push(...(await scanLogRoot(root))); return scanExistingFiles([...(settings.logPaths || []), ...COMMON_LOGS, ...discovered]); }
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
  const rawPaths = [...new Set([...(settings.logPaths || []), ...COMMON_LOGS])].filter(Boolean);
  const paths = [];
  for (const candidate of rawPaths) { if (await allowedLogPath(candidate)) paths.push(candidate); }
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
  const decoded = authenticatedUser(req);
  const authenticated = Boolean(decoded);
  const canDiscover = authenticated || normalizeSettings(settings).users.length === 0;
  res.json({ settings: statusSettings(settings, authenticated, decoded?.username || ''), authenticated, discovered: canDiscover ? { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(settings) } : { caddyfiles: [], logfiles: [] } });
});
app.post('/api/setup/user', requireTrustedOrigin, requireSetupOrigin, async (req, res) => {
  const settings = await loadSettings();
  if (normalizeSettings(settings).users.length > 0) return res.status(409).json({ error: 'Admin user is already configured.' });
  const { username, password, setupToken } = req.body || {};
  if (setupTokenRequired(settings) && setupToken !== SETUP_TOKEN) return res.status(403).json({ error: 'Invalid setup token.' });
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Username and a password of at least 8 characters are required.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const next = { ...settings, configured: false, users: [{ username, passwordHash, role: 'admin' }] };
  await saveSettings(next);
  res.cookie(COOKIE_NAME, sign(username), cookieOptions(req));
  res.json({ settings: publicSettings(next, username), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) } });
});
app.post('/api/setup/config', requireTrustedOrigin, auth, async (req, res) => {
  const settings = await loadSettings();
  const { caddyfilePath, logPaths = [] } = req.body || {};
  if (!caddyfilePath || !fssync.existsSync(caddyfilePath)) return res.status(400).json({ error: 'A readable Caddyfile path is required.' });
  const allowedLogs = [];
  for (const candidate of [...new Set([...logPaths, ...COMMON_LOGS].filter(Boolean))]) { if (await allowedLogPath(candidate)) allowedLogs.push(candidate); }
  const next = { ...settings, configured: true, caddyfilePath, logPaths: allowedLogs };
  await saveSettings(next);
  res.json({ settings: publicSettings(next, username), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) } });
});
app.post('/api/onboard', requireTrustedOrigin, requireSetupOrigin, async (req, res) => {
  const settings = await loadSettings();
  if (settings.configured && settings.user) return res.status(409).json({ error: 'CaddyUI is already configured.' });
  const { username, password, caddyfilePath, logPaths = [], setupToken } = req.body || {};
  if (setupTokenRequired(settings) && setupToken !== SETUP_TOKEN) return res.status(403).json({ error: 'Invalid setup token.' });
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Username and a password of at least 8 characters are required.' });
  if (!caddyfilePath || !fssync.existsSync(caddyfilePath)) return res.status(400).json({ error: 'A readable Caddyfile path is required.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const allowedLogs = [];
  for (const candidate of [...new Set([...logPaths, ...COMMON_LOGS].filter(Boolean))]) { if (await allowedLogPath(candidate)) allowedLogs.push(candidate); }
  const next = { configured: true, caddyfilePath, logPaths: allowedLogs, users: [{ username, passwordHash, role: 'admin' }] };
  await saveSettings(next);
  res.cookie(COOKIE_NAME, sign(username), cookieOptions(req));
  res.json({ settings: publicSettings(next, username), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) } });
});
app.post('/api/login', requireTrustedOrigin, async (req, res) => {
  const settings = await loadSettings();
  const { username, password } = req.body || {};
  const rateKey = `${clientIp(req)}:${String(username || '')}`;
  if (tooManyAttempts(rateKey)) return res.status(429).json({ error: 'Too many login attempts.' });
  const user = currentUserRecord(settings, username);
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    recordFailedAttempt(rateKey);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  clearAttempts(rateKey);
  res.cookie(COOKIE_NAME, sign(user.username), cookieOptions(req));
  res.json({ settings: publicSettings(settings, user.username) });
});
app.post('/api/logout', requireTrustedOrigin, async (req, res) => {
  const token = req.cookies[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) { try { await revokeToken(jwt.verify(token, JWT_SECRET)); } catch {} }
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
  res.json({ ok: true });
});
app.get('/api/config', auth, requirePermission('view'), async (_req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const parsed = parseCaddyfile(content);
    res.json({ path: settings.caddyfilePath, content, parsed, health: await checkProxyHealth(parsed) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/config', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
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
app.get('/api/proxies/health', auth, requirePermission('view'), async (_req, res) => {
  try {
    const { content } = await readConfiguredCaddyfile();
    const parsed = parseCaddyfile(content);
    res.json({ health: await checkProxyHealth(parsed) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/config/validate', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : (await readConfiguredCaddyfile()).content;
  res.json(await validateConfig(content));
});
app.post('/api/config/reload', requireTrustedOrigin, auth, requirePermission('edit'), async (_req, res) => {
  const settings = await loadSettings();
  const result = await run('caddy', ['reload', '--config', settings.caddyfilePath, '--adapter', 'caddyfile']);
  if (result.code === -1) return res.status(503).json({ ...result, stderr: 'Caddy binary is not available in this container. Run CaddyUI where it can execute caddy reload.' });
  res.status(result.ok ? 200 : 400).json(result);
});
app.post('/api/proxies', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = appendSimpleProxy(content, req.body || {});
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/proxies/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = updateSimpleProxy(content, { ...req.body, siteLine: req.params.line });
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});



app.delete('/api/proxies/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = deleteBlockAtLine(content, req.params.line);
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/middlewares', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = appendSnippet(content, req.body || {});
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/middlewares/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = updateSnippet(content, { ...req.body, line: req.params.line });
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});


app.delete('/api/middlewares/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readConfiguredCaddyfile();
    const next = deleteBlockAtLine(content, req.params.line);
    const validation = await validateConfig(next);
    if (!validation.ok && !validation.unavailable) return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: parseCaddyfile(next) });
    await fs.writeFile(settings.caddyfilePath, next, 'utf8');
    res.json({ ok: true, validation, parsed: parseCaddyfile(next), content: next });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/logs', auth, requirePermission('view'), async (req, res) => {
  const settings = await loadSettings();
  res.json({ logs: await collectLogs(settings, Number(req.query.lines || 200)) });
});
app.get('/api/settings', auth, requirePermission('view'), async (req, res) => { const settings = await loadSettings(); res.json({ settings: publicSettings(settings, req.user.username), discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(settings) } }); });
app.post('/api/settings', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  const settings = await loadSettings();
  const { caddyfilePath, logPaths } = req.body || {};
  if (caddyfilePath && !fssync.existsSync(caddyfilePath)) return res.status(400).json({ error: 'Caddyfile path does not exist.' });
  const nextLogPaths = [];
  for (const candidate of (Array.isArray(logPaths) ? logPaths.filter(Boolean) : settings.logPaths)) { if (await allowedLogPath(candidate)) nextLogPaths.push(candidate); }
  const next = { ...settings, caddyfilePath: caddyfilePath || settings.caddyfilePath, logPaths: nextLogPaths };
  await saveSettings(next);
  res.json({ settings: publicSettings(next, req.user.username) });
});


app.get('/api/users', auth, requirePermission('admin'), async (_req, res) => {
  const settings = await loadSettings();
  res.json({ users: normalizeSettings(settings).users.map(exposeUser) });
});
app.post('/api/users', requireTrustedOrigin, auth, requirePermission('admin'), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  const { username, password, role } = req.body || {};
  if (!username || !password || String(password).length < 8) return res.status(400).json({ error: 'Username and password are required.' });
  if (!['view','edit','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (currentUserRecord(normalized, username)) return res.status(409).json({ error: 'User already exists.' });
  normalized.users.push({ username: String(username).trim(), passwordHash: await bcrypt.hash(password, 12), role });
  await saveSettings(normalized);
  res.json({ users: normalized.users.map(exposeUser) });
});
app.put('/api/users/:username', requireTrustedOrigin, auth, requirePermission('admin'), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  const user = currentUserRecord(normalized, req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { role, password } = req.body || {};
  if (role && !['view','edit','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (role) user.role = role;
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    user.passwordHash = await bcrypt.hash(password, 12);
  }
  await saveSettings(normalized);
  res.json({ users: normalized.users.map(exposeUser) });
});
app.delete('/api/users/:username', requireTrustedOrigin, auth, requirePermission('admin'), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  if (req.user.username === req.params.username) return res.status(400).json({ error: 'Cannot delete current user.' });
  normalized.users = normalized.users.filter((user) => user.username !== req.params.username);
  await saveSettings(normalized);
  res.json({ users: normalized.users.map(exposeUser) });
});
app.post('/api/account/password', requireTrustedOrigin, auth, requirePermission('view'), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  const user = currentUserRecord(normalized, req.user.username);
  const { currentPassword, newPassword } = req.body || {};
  if (!user || !(await bcrypt.compare(currentPassword || '', user.passwordHash))) return res.status(401).json({ error: 'Current password is invalid.' });
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await saveSettings(normalized);
  res.json({ ok: true });
});
async function appBranch() {
  const result = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT });
  return result.ok ? result.stdout.trim() : 'unknown';
}
async function appUpdateStatus(fetchRemote = false) {
  const branch = await appBranch();
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  if (fetchRemote) await run('git', ['fetch', '--quiet', 'origin', branch], { cwd: ROOT });
  const remoteHead = await run('git', ['rev-parse', `origin/${branch}`], { cwd: ROOT });
  const localCommit = head.ok ? head.stdout.trim() : '';
  const remoteCommit = remoteHead.ok ? remoteHead.stdout.trim() : '';
  return { version: APP_VERSION, branch, localCommit, remoteCommit, updateAvailable: Boolean(localCommit && remoteCommit && localCommit !== remoteCommit) };
}
app.get('/api/app/status', auth, requirePermission('view'), async (_req, res) => { res.json(await appUpdateStatus(false)); });
app.post('/api/app/check-updates', requireTrustedOrigin, auth, requirePermission('view'), async (_req, res) => { res.json(await appUpdateStatus(true)); });
app.post('/api/app/update', requireTrustedOrigin, auth, requirePermission('admin'), async (_req, res) => {
  const branch = await appBranch();
  const child = spawn('bash', ['scripts/update.sh'], { cwd: ROOT, env: { ...process.env, CADDYUI_BRANCH: branch, CADDYUI_ASSUME_YES: '1' }, detached: true, stdio: 'ignore' });
  child.unref();
  res.json({ ok: true, started: true });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.listen(PORT, () => console.log(`CaddyUI API listening on :${PORT}`));
