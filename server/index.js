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
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import {
  parseCaddyfile,
  appendSimpleProxy,
  updateSimpleProxy,
  appendSnippet,
  updateSnippet,
  deleteBlockAtLine,
  setProxyDisabled,
} from './caddyParser.js';
import { createStateStore } from './stateStore.js';

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.CADDY_UI_PORT || process.env.PORT || 8787);
const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const RELEASE_METADATA_PATH = path.join(ROOT, 'release.json');
const APP_PACKAGE_VERSION = JSON.parse(fssync.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
const DATA_DIR = process.env.CADDY_UI_DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.CADDY_UI_DB_PATH || path.join(DATA_DIR, 'caddyui.db');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SESSION_PATH = path.join(DATA_DIR, 'sessions.json');
const DEFAULT_SECRET = 'dev-change-me-caddy-ui';
const JWT_SECRET = process.env.CADDY_UI_SECRET || DEFAULT_SECRET;
const COOKIE_NAME = 'caddyui_token';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SETUP_TOKEN = process.env.CADDY_UI_SETUP_TOKEN || '';
const DEFAULT_CONFIG_MODE = String(process.env.CADDY_UI_CONFIG_MODE || 'api').trim().toLowerCase() === 'file' ? 'file' : 'api';
const DEFAULT_CADDY_API_URL = String(process.env.CADDY_UI_CADDY_API_URL || 'http://127.0.0.1:2019').trim();
const DEFAULT_CADDY_API_TOKEN = String(process.env.CADDY_UI_CADDY_API_TOKEN || '').trim();
const LOGIN_WINDOW_MS = Number(process.env.CADDY_UI_LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.CADDY_UI_LOGIN_MAX_ATTEMPTS || 5);
const LOG_ROOTS = (process.env.CADDY_UI_LOG_ROOTS || ['/var/log/caddy', '/data/caddy/logs', '/config/log'].join(','))
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const ROLE_LEVEL = { view: 0, edit: 1, admin: 2 };
const VALID_ROLES = new Set(['view', 'edit', 'admin']);
const CONFIG_MODE_VALUES = new Set(['file', 'api']);
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;
const MAX_PASSWORD_LENGTH = 72;
const ENV_ALLOWED_ORIGINS = (process.env.CADDY_UI_ALLOWED_ORIGINS || '')
  .split(',')
  .map((x) => normalizedOrigin(x.trim()))
  .filter(Boolean);
const ENV_ALLOW_REMOTE_SETUP = process.env.CADDY_UI_ALLOW_REMOTE_SETUP === '1';
const ENV_SECURE_COOKIE_MODE =
  process.env.CADDY_UI_INSECURE_COOKIE === '1'
    ? 'insecure'
    : process.env.CADDY_UI_SECURE_COOKIE === '1'
      ? 'secure'
      : 'auto';
const TRUST_PROXY_SETTING = String(process.env.CADDY_UI_TRUST_PROXY || '').trim().toLowerCase();
const ENV_TRUST_PROXY_HOPS =
  TRUST_PROXY_SETTING === '1' || TRUST_PROXY_SETTING === 'true'
    ? 1
    : /^\d+$/.test(TRUST_PROXY_SETTING) && Number(TRUST_PROXY_SETTING) > 0
      ? Number(TRUST_PROXY_SETTING)
      : 0;

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
const UPDATE_CHANNELS = new Set(['stable', 'beta', 'dev']);
const UPDATE_BRANCH = {
  stable: 'main',
  beta: 'beta',
  dev: 'dev',
};
const JWT_ALGORITHM = 'HS256';
const COOKIE_MODE_VALUES = new Set(['auto', 'secure', 'insecure']);
let runtimeAllowedOrigins = new Set(ENV_ALLOWED_ORIGINS);
let runtimeAllowRemoteSetup = ENV_ALLOW_REMOTE_SETUP;
let runtimeSecureCookieMode = ENV_SECURE_COOKIE_MODE;
let runtimeTrustProxyHops = ENV_TRUST_PROXY_HOPS;
let runtimeTrustForwardHeaders = ENV_TRUST_PROXY_HOPS > 0;
const stateStore = createStateStore({
  dataDir: DATA_DIR,
  dbPath: DB_PATH,
  settingsPath: SETTINGS_PATH,
  sessionPath: SESSION_PATH,
  fileMode: 0o600,
});

const weakSecretConfigured = JWT_SECRET === DEFAULT_SECRET || JWT_SECRET.length < 32;
if (IS_PRODUCTION && weakSecretConfigured) {
  throw new Error('Set CADDY_UI_SECRET to a strong value (at least 32 characters).');
}
if (!IS_PRODUCTION && weakSecretConfigured) {
  console.warn('[security] Using a weak CADDY_UI_SECRET outside production; set at least 32 characters.');
}

function normalizePatchVersion(value = '') {
  const trimmed = String(value || '').trim();
  return /^\d{8}-\d+$/.test(trimmed) ? trimmed : '';
}

function formatDisplayVersion(version = '', patch = '') {
  const cleanVersion = String(version || '').trim() || APP_PACKAGE_VERSION;
  const cleanPatch = normalizePatchVersion(patch);
  return cleanPatch ? `${cleanVersion}+${cleanPatch}` : cleanVersion;
}

function normalizeReleaseMetadata(raw = {}, fallbackVersion = APP_PACKAGE_VERSION) {
  const version = String(raw?.version || fallbackVersion || APP_PACKAGE_VERSION).trim() || APP_PACKAGE_VERSION;
  const patch = normalizePatchVersion(raw?.patch || '');
  return {
    version,
    patch,
    displayVersion: formatDisplayVersion(version, patch),
  };
}

function readReleaseMetadataSync(filePath, fallbackVersion = APP_PACKAGE_VERSION) {
  try {
    const raw = JSON.parse(fssync.readFileSync(filePath, 'utf8'));
    return normalizeReleaseMetadata(raw, fallbackVersion);
  } catch {
    return normalizeReleaseMetadata({}, fallbackVersion);
  }
}

function readReleaseMetadataFromGit(stdout = '', fallbackVersion = APP_PACKAGE_VERSION) {
  try {
    return normalizeReleaseMetadata(JSON.parse(stdout), fallbackVersion);
  } catch {
    return normalizeReleaseMetadata({}, fallbackVersion);
  }
}

app.set('trust proxy', runtimeTrustProxyHops > 0 ? runtimeTrustProxyHops : false);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (!IS_PRODUCTION) return callback(null, true);
      return callback(null, runtimeAllowedOrigins.has(normalizedOrigin(origin)));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const loginAttempts = new Map();

function normalizedOrigin(origin) {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return '';
  }
}

function forwardedValue(req, headerName) {
  if (!runtimeTrustForwardHeaders) return '';
  const raw = req.headers[headerName];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '')
    .split(',')[0]
    .trim();
}

function requestProto(req) {
  const forwardedProto = forwardedValue(req, 'x-forwarded-proto').toLowerCase();
  if (forwardedProto === 'http' || forwardedProto === 'https') return forwardedProto;
  return req.secure ? 'https' : 'http';
}

function requestHost(req) {
  const host = forwardedValue(req, 'x-forwarded-host') || req.headers.host || '';
  return String(host).trim().toLowerCase();
}

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
  return (
    origin === expectedOrigin(req) ||
    runtimeAllowedOrigins.has(origin) ||
    (!IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))
  );
}

function requireTrustedOrigin(req, res, next) {
  if (originAllowed(req)) return next();
  return res.status(403).json({ error: 'Origin not allowed.' });
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function privateIp(ip) {
  return (
    /^127\./.test(ip) ||
    ip === '::1' ||
    /^::ffff:127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    /^fc|^fd/i.test(ip)
  );
}

function requireSetupOrigin(req, res, next) {
  if (runtimeAllowRemoteSetup || !IS_PRODUCTION || privateIp(clientIp(req))) return next();
  return res.status(403).json({ error: 'Initial setup is blocked from public addresses.' });
}

function cookieOptions(req) {
  const secure = runtimeSecureCookieMode === 'insecure' ? false : runtimeSecureCookieMode === 'secure' || requestProto(req) === 'https';
  return { httpOnly: true, sameSite: 'strict', secure, path: '/' };
}

function tooManyAttempts(key) {
  const now = Date.now();
  pruneLoginAttempts(now);
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedAttempt(key) {
  const now = Date.now();
  pruneLoginAttempts(now);
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearAttempts(key) {
  loginAttempts.delete(key);
}

function pruneLoginAttempts(now = Date.now()) {
  if (loginAttempts.size < 500) return;
  for (const [key, value] of loginAttempts.entries()) {
    if (!value?.resetAt || value.resetAt <= now) loginAttempts.delete(key);
  }
}

function requireRateLimit(namespace, maxAttempts, windowMs = LOGIN_WINDOW_MS) {
  return (req, res, next) => {
    const key = `${namespace}:${clientIp(req)}:${req.user?.username || 'anon'}`;
    const now = Date.now();
    pruneLoginAttempts(now);
    const entry = loginAttempts.get(key);
    if (!entry || now > entry.resetAt) {
      loginAttempts.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxAttempts) {
      return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    }
    entry.count += 1;
    return next();
  };
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeUser(user, fallbackRole = 'view') {
  if (!user) return null;
  return {
    username: String(user.username || '').trim(),
    passwordHash: user.passwordHash || '',
    role: user.role || fallbackRole,
  };
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeCookieMode(value, fallback = 'auto') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return COOKIE_MODE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeAllowedOrigins(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(values.map((item) => normalizedOrigin(String(item || '').trim())).filter(Boolean))];
}

function normalizeTrustProxyHops(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const hops = Math.floor(numeric);
  return hops > 0 ? hops : 0;
}

function normalizeConfigMode(value, fallback = DEFAULT_CONFIG_MODE) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return CONFIG_MODE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeProxyDescription(value = '') {
  return String(value || '')
    .replace(/\r?\n+/g, ' ')
    .trim()
    .slice(0, 280);
}

function normalizeApiUrl(value, fallback = '') {
  const normalized = String(value ?? fallback ?? '').trim();
  if (!normalized) return '';
  return normalized.replace(/\/+$/, '');
}

function applyRuntimeSecurity(settings) {
  runtimeAllowedOrigins = new Set(normalizeAllowedOrigins(settings.allowedOrigins));
  runtimeAllowRemoteSetup = normalizeBoolean(settings.allowRemoteSetup, ENV_ALLOW_REMOTE_SETUP);
  runtimeSecureCookieMode = normalizeCookieMode(settings.secureCookieMode, ENV_SECURE_COOKIE_MODE);
  runtimeTrustProxyHops = normalizeTrustProxyHops(settings.trustProxyHops, ENV_TRUST_PROXY_HOPS);
  runtimeTrustForwardHeaders = runtimeTrustProxyHops > 0;
  app.set('trust proxy', runtimeTrustProxyHops > 0 ? runtimeTrustProxyHops : false);
}

function normalizeSettings(settings) {
  const base = settings && typeof settings === 'object' ? settings : {};
  const users = Array.isArray(base.users)
    ? base.users
        .map((user) => normalizeUser(user, 'view'))
        .filter((user) => user && user.username)
    : base.user
      ? [normalizeUser(base.user, 'admin')]
      : [];
  return {
    configured: Boolean(base.configured),
    configMode: normalizeConfigMode(base.configMode, DEFAULT_CONFIG_MODE),
    caddyfilePath: base.caddyfilePath || '',
    caddyApiUrl: normalizeApiUrl(base.caddyApiUrl, DEFAULT_CADDY_API_URL),
    caddyApiToken: String(base.caddyApiToken ?? DEFAULT_CADDY_API_TOKEN).trim(),
    logPaths: Array.isArray(base.logPaths) ? base.logPaths : COMMON_LOGS,
    updateChannel: UPDATE_CHANNELS.has(base.updateChannel) ? base.updateChannel : 'stable',
    trustProxyHops: normalizeTrustProxyHops(base.trustProxyHops, ENV_TRUST_PROXY_HOPS),
    allowRemoteSetup: normalizeBoolean(base.allowRemoteSetup, ENV_ALLOW_REMOTE_SETUP),
    secureCookieMode: normalizeCookieMode(base.secureCookieMode, ENV_SECURE_COOKIE_MODE),
    allowedOrigins: normalizeAllowedOrigins(base.allowedOrigins ?? ENV_ALLOWED_ORIGINS),
    users,
  };
}

function caddyConfigured(settings) {
  const normalized = normalizeSettings(settings);
  if (normalized.configMode === 'api') return Boolean(normalized.caddyApiUrl);
  return Boolean(normalized.caddyfilePath);
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
    if (!req.user || !hasPermission(req.user.role, required)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}

function setupTokenRequired(settings) {
  return IS_PRODUCTION && normalizeSettings(settings).users.length === 0 && Boolean(SETUP_TOKEN);
}

function validUsername(username) {
  return USERNAME_PATTERN.test(String(username || '').trim());
}

function validPassword(password) {
  const value = String(password || '');
  return value.length >= 8 && value.length <= MAX_PASSWORD_LENGTH;
}

function adminCount(settings) {
  return normalizeSettings(settings).users.filter((user) => user.role === 'admin').length;
}

async function loadSettings() {
  const store = await stateStore;
  const raw = await store.getJson('settings', null);
  const normalized = raw
    ? normalizeSettings(raw)
    : normalizeSettings({ configured: false, configMode: DEFAULT_CONFIG_MODE, caddyfilePath: '', caddyApiUrl: DEFAULT_CADDY_API_URL, logPaths: COMMON_LOGS, users: [] });
  applyRuntimeSecurity(normalized);
  return normalized;
}

async function saveSettings(settings) {
  const store = await stateStore;
  const normalized = normalizeSettings(settings);
  applyRuntimeSecurity(normalized);
  await store.setJson('settings', normalized);
}

function publicSettings(settings, currentUsername = '') {
  const normalized = normalizeSettings(settings);
  const currentUser = currentUserRecord(normalized, currentUsername);
  return {
    userConfigured: normalized.users.length > 0,
    caddyConfigured: Boolean(normalized.configured && caddyConfigured(normalized)),
    configured: Boolean(normalized.configured && normalized.users.length > 0 && caddyConfigured(normalized)),
    configMode: normalized.configMode,
    caddyfilePath: normalized.caddyfilePath || '',
    caddyApiUrl: normalized.caddyApiUrl || '',
    hasCaddyApiToken: Boolean(normalized.caddyApiToken),
    hasCaddyApiSecret: Boolean(normalized.caddyApiToken),
    logPaths: normalized.logPaths || COMMON_LOGS,
    updateChannel: normalized.updateChannel || 'stable',
    trustProxyHops: normalized.trustProxyHops ?? 0,
    allowRemoteSetup: Boolean(normalized.allowRemoteSetup),
    secureCookieMode: normalized.secureCookieMode || 'auto',
    allowedOrigins: normalized.allowedOrigins || [],
    username: currentUser?.username || '',
    role: currentUser?.role || '',
  };
}

function statusSettings(settings, authenticated, currentUsername = '') {
  const normalized = normalizeSettings(settings);
  const currentUser = currentUserRecord(normalized, currentUsername);
  const base = {
    userConfigured: normalized.users.length > 0,
    caddyConfigured: Boolean(normalized.configured && caddyConfigured(normalized)),
    configured: Boolean(normalized.configured && normalized.users.length > 0 && caddyConfigured(normalized)),
    setupTokenRequired: setupTokenRequired(normalized),
    username: authenticated ? currentUser?.username || '' : '',
    role: authenticated ? currentUser?.role || '' : '',
  };
  if (!authenticated) return { ...base, caddyfilePath: '', caddyApiUrl: '', configMode: DEFAULT_CONFIG_MODE, logPaths: [] };
  return {
    ...base,
    configMode: normalized.configMode,
    caddyfilePath: normalized.caddyfilePath || '',
    caddyApiUrl: normalized.caddyApiUrl || '',
    hasCaddyApiToken: Boolean(normalized.caddyApiToken),
    hasCaddyApiSecret: Boolean(normalized.caddyApiToken),
    logPaths: normalized.logPaths || COMMON_LOGS,
    updateChannel: normalized.updateChannel || 'stable',
    trustProxyHops: normalized.trustProxyHops ?? 0,
    allowRemoteSetup: Boolean(normalized.allowRemoteSetup),
    secureCookieMode: normalized.secureCookieMode || 'auto',
    allowedOrigins: normalized.allowedOrigins || [],
  };
}

function updateTargetFromSettings(settings, currentBranch = 'unknown') {
  const normalized = normalizeSettings(settings);
  const channel = normalized.updateChannel || 'stable';
  if (UPDATE_CHANNELS.has(channel)) {
    return { channel, branch: UPDATE_BRANCH[channel] };
  }
  if (currentBranch === 'dev' || currentBranch === 'beta') {
    return { channel: currentBranch, branch: currentBranch };
  }
  return { channel: 'stable', branch: UPDATE_BRANCH.stable };
}

function updateTargetForChannel(channel, fallbackBranch = 'unknown') {
  const normalized = String(channel || '').trim().toLowerCase();
  if (UPDATE_CHANNELS.has(normalized)) {
    return { channel: normalized, branch: UPDATE_BRANCH[normalized] };
  }
  return updateTargetFromSettings({ updateChannel: normalized }, fallbackBranch);
}

async function loadSessionState() {
  const store = await stateStore;
  return (await store.getJson('sessions', { revoked: {} })) || { revoked: {} };
}

async function saveSessionState(state) {
  const store = await stateStore;
  await store.setJson('sessions', state);
}

function summarizeText(value = '', max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function eventActor(req, fallbackUsername = '', fallbackRole = '') {
  return {
    username: String(req?.user?.username || fallbackUsername || 'system').trim() || 'system',
    role: String(req?.user?.role || fallbackRole || '').trim() || 'system',
  };
}

async function recordEvent(req, {
  actorUsername = '',
  actorRole = '',
  kind = 'app',
  action = 'action',
  targetType = '',
  targetId = '',
  status = 'success',
  message = '',
  details = {},
} = {}) {
  const actor = eventActor(req, actorUsername, actorRole);
  const event = {
    id: randomUUID(),
    createdAt: Date.now(),
    actorUsername: actor.username,
    actorRole: actor.role,
    kind: String(kind || 'app').trim(),
    action: String(action || 'action').trim(),
    targetType: String(targetType || '').trim(),
    targetId: String(targetId || '').trim(),
    status: String(status || 'success').trim(),
    message: summarizeText(message || `${action} ${targetType}`),
    details: details && typeof details === 'object' ? details : {},
  };
  const store = await stateStore;
  await store.appendEvent(event);
  void store.pruneEvents(2000).catch(() => {});
  return event;
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

function sign(username) {
  return jwt.sign({ username, jti: randomUUID() }, JWT_SECRET, { algorithm: JWT_ALGORITHM, expiresIn: '4h' });
}

async function auth(req, res, next) {
  const token = req.cookies[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    if (await tokenRevoked(decoded.jti)) return res.status(401).json({ error: 'Session expired' });
    const settings = await loadSettings();
    const user = currentUserRecord(settings, decoded.username);
    if (!user) return res.status(401).json({ error: 'Session expired' });
    req.user = exposeUser(user);
    req.userToken = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

function authenticatedUser(req) {
  const token = req.cookies?.[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
  } catch {
    return null;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
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

async function scanCaddyfiles() {
  return scanExistingFiles(COMMON_CADDYFILES);
}

async function scanLogRoot(root, depth = 0) {
  if (depth > 4) return [];
  const entries = [];
  try {
    const base = await fs.realpath(root);
    for (const item of await fs.readdir(base, { withFileTypes: true })) {
      const nextPath = path.join(base, item.name);
      if (item.isDirectory()) entries.push(...(await scanLogRoot(nextPath, depth + 1)));
      if (item.isFile() && /(caddy|access|error|log)/i.test(item.name)) entries.push(nextPath);
    }
  } catch {}
  return entries;
}

async function scanLogfiles(settings = {}) {
  const discovered = [];
  for (const root of LOG_ROOTS) discovered.push(...(await scanLogRoot(root)));
  return scanExistingFiles([...(settings.logPaths || []), ...COMMON_LOGS, ...discovered]);
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

async function saveWorkingConfig(content = '') {
  const store = await stateStore;
  await store.setJson('working_config', {
    content: String(content || ''),
    updatedAt: new Date().toISOString(),
  });
}

async function readWorkingConfig() {
  const settings = await loadSettings();
  if (settings.configMode === 'api') {
    const store = await stateStore;
    const cached = await store.getJson('working_config', null);
    if (typeof cached?.content === 'string') {
      return { settings, content: cached.content, path: 'caddy://admin-api' };
    }
    if (settings.caddyfilePath) {
      try {
        const content = await fs.readFile(settings.caddyfilePath, 'utf8');
        await saveWorkingConfig(content);
        return { settings, content, path: 'caddy://admin-api' };
      } catch {}
    }
    return { settings, content: '', path: 'caddy://admin-api' };
  }
  if (!settings.caddyfilePath) throw new Error('No Caddyfile path configured.');
  const content = await fs.readFile(settings.caddyfilePath, 'utf8');
  return { settings, content, path: settings.caddyfilePath };
}

function caddyApiAuthorizationValue(token = '') {
  const value = String(token || '').trim();
  if (!value) return '';
  if (/^bearer\s+/i.test(value) || /^basic\s+/i.test(value)) return value;
  return `Bearer ${value}`;
}

async function requestCaddyApi(settings, endpoint, options = {}) {
  const normalized = normalizeSettings(settings);
  const base = normalizeApiUrl(normalized.caddyApiUrl, DEFAULT_CADDY_API_URL);
  if (!base) throw new Error('Caddy API URL is not configured.');
  const url = `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const headers = { ...(options.headers || {}) };
  try {
    if (!headers.Origin) headers.Origin = new URL(base).origin;
  } catch {}
  const authValue = caddyApiAuthorizationValue(normalized.caddyApiToken);
  if (authValue) headers.Authorization = authValue;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || 6000),
  });
  return response;
}

async function testCaddyApiConnection(settingsLike = {}, overrides = {}) {
  const settings = normalizeSettings({
    ...settingsLike,
    configMode: 'api',
    caddyApiUrl: overrides.caddyApiUrl === undefined ? settingsLike.caddyApiUrl : overrides.caddyApiUrl,
    caddyApiToken: overrides.caddyApiToken === undefined ? settingsLike.caddyApiToken : overrides.caddyApiToken,
  });
  const response = await requestCaddyApi(settings, '/config/', { method: 'GET', timeoutMs: 6000 });
  const result = await caddyResponseData(response);
  return {
    ok: result.ok,
    status: result.status,
    message: result.ok ? 'Connected to Caddy Admin API.' : result.raw || `Caddy API request failed (${result.status}).`,
    value: result.data,
  };
}

async function loadResetConfigTemplate() {
  const templatePath = path.join(ROOT, 'Caddyfile.example');
  try {
    return await fs.readFile(templatePath, 'utf8');
  } catch {
    return 'localhost {\n\trespond "Caddy reset placeholder" 200\n}\n';
  }
}

function caddyPathPart(value = '') {
  if (Array.isArray(value)) return value.filter(Boolean).join('/');
  return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

function caddyEndpoint(scope, path = '') {
  const cleaned = caddyPathPart(path);
  return cleaned ? `${scope}/${cleaned}` : `${scope}/`;
}

function caddyPayload(value) {
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

function caddyMutationBody(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    if (Object.prototype.hasOwnProperty.call(req.body, 'value')) return req.body.value;
    if (Object.prototype.hasOwnProperty.call(req.body, 'ifMatch')) {
      const payload = { ...req.body };
      delete payload.ifMatch;
      if (Object.keys(payload).length === 0) return undefined;
      return payload;
    }
    return req.body;
  }
  return req.body;
}

function caddyIfMatch(req) {
  const header = String(req.get('if-match') || '').trim();
  if (header) return header;
  return String(req.body?.ifMatch || '').trim();
}

async function caddyResponseData(response) {
  const text = await response.text();
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const etag = response.headers.get('etag') || '';
  let data = text;
  if (contentType.includes('application/json')) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
  }
  return { status: response.status, ok: response.ok, etag, contentType, raw: text, data };
}

async function applyConfigContent(settings, content, { backup = false } = {}) {
  const normalized = normalizeSettings(settings);
  const configContent = String(content || '');
  if (normalized.configMode === 'api') {
    const response = await requestCaddyApi(normalized, '/load', {
      method: 'POST',
      headers: { 'Content-Type': 'text/caddyfile' },
      body: configContent,
      timeoutMs: 12000,
    });
    if (!response.ok) {
      const message = (await response.text()) || `Caddy API load failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    await saveWorkingConfig(configContent);
    return { backup: '' };
  }

  let backupPath = '';
  if (backup && normalized.caddyfilePath) {
    backupPath = `${normalized.caddyfilePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    try {
      await fs.copyFile(normalized.caddyfilePath, backupPath);
    } catch {}
  }
  if (!normalized.caddyfilePath) throw new Error('No Caddyfile path configured.');
  await fs.writeFile(normalized.caddyfilePath, configContent, 'utf8');
  return { backup: backupPath };
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
    const done = (online, error = '') => {
      socket.destroy();
      resolve({ online, error });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

async function probeHealthTarget(host = '', port = 0, { allowPrivate = false } = {}) {
  const value = String(host || '').trim();
  if (!value) return { online: false, error: 'missing', host: '', port };
  const ipVersion = net.isIP(value);
  if (ipVersion > 0) {
    if (!allowPrivate && privateIp(value)) return { online: false, error: 'blocked-private-address', host: value, port };
    const direct = await tcpCheck(value, port);
    return { ...direct, host: value, port };
  }
  try {
    const resolved = await dns.lookup(value);
    const resolvedAddress = String(resolved.address || '');
    if (!resolvedAddress) return { online: false, error: 'lookup_failed', host: value, port };
    if (!allowPrivate && privateIp(resolvedAddress)) {
      return { online: false, error: 'blocked-private-address', host: value, port };
    }
    const direct = await tcpCheck(resolvedAddress, port);
    return { ...direct, host: value, port };
  } catch (error) {
    return { online: false, error: error.code || error.message || 'lookup_failed', host: value, port };
  }
}

async function checkSiteHealth(site) {
  if (!site) {
    return {
      local: { online: false, error: 'missing', host: '', port: 0 },
      domain: { online: false, error: 'missing', host: '', port: 443 },
    };
  }
  if (site.disabled) {
    return {
      local: { online: false, error: 'disabled', disabled: true, host: '', port: 0 },
      domain: { online: false, error: 'disabled', disabled: true, host: splitHostPort(site.addresses?.[0] || '').host, port: 443 },
    };
  }
  const domain = site.addresses?.[0] || '';
  const upstream = site.proxies?.[0]?.upstreams?.[0] || '';
  const target = splitHostPort(upstream);
  const domainHost = splitHostPort(domain).host;
  const [local, domainResult] = await Promise.all([
    probeHealthTarget(target.host, target.port, { allowPrivate: true }),
    probeHealthTarget(domainHost, 443),
  ]);
  return { local, domain: domainResult };
}

async function checkProxyHealth(parsed) {
  const results = {};
  await Promise.all(
    (parsed.sites || []).map(async (site) => {
      results[site.id] = await checkSiteHealth(site);
    })
  );
  return results;
}

async function collectLogs(settings, lines = 200) {
  async function collectJournalLogs(maxLines) {
    if (!fssync.existsSync('/run/systemd/system')) return null;
    const result = await run('journalctl', ['-u', 'caddy', '-n', String(maxLines), '--no-pager', '-o', 'short-iso']);
    if (!result.ok) return null;
    return { source: 'journalctl:caddy', content: result.stdout || '', ok: true };
  }

  const mode = String(settings?.logMode || 'all');
  const discovered = await scanLogfiles(settings);
  const candidatePaths = [...new Set([...(settings.logPaths || []), ...COMMON_LOGS, ...discovered.map((x) => x.path)])];
  const paths = [];
  for (const candidate of candidatePaths) {
    if (await allowedLogPath(candidate)) paths.push(candidate);
  }

  const entries = [];
  if (mode !== 'journal') {
    for (const logPath of paths) {
      try {
        const stat = await fs.stat(logPath);
        if (stat.isFile()) {
          entries.push({ source: logPath, content: await tailFile(logPath, lines), ok: true });
        }
      } catch {}
    }
  }
  if (mode !== 'files') {
    const journalEntry = await collectJournalLogs(lines);
    if (journalEntry) entries.push(journalEntry);
  }

  if (entries.length === 0) {
    entries.push({
      source: 'not-found',
      ok: false,
      content: 'No Caddy log files found. Configure a log path in Settings or mount Caddy logs into this container.',
    });
  }
  return entries;
}

async function validateConfig(content) {
  const tmp = path.join(os.tmpdir(), `caddyui-${process.pid}-${Date.now()}-${randomUUID()}.Caddyfile`);
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let result;
  try {
    result = await run('caddy', ['validate', '--config', tmp, '--adapter', 'caddyfile']);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  if (result.code === -1) {
    return {
      ok: false,
      unavailable: true,
      stdout: result.stdout,
      stderr: 'Caddy binary is not available in this container. Install/mount caddy or disable validation for development.',
    };
  }
  return result;
}

async function formatConfig(content) {
  const input = String(content || '');
  const tmp = path.join(os.tmpdir(), `caddyui-fmt-${process.pid}-${Date.now()}-${randomUUID()}.Caddyfile`);
  await fs.writeFile(tmp, input, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let result;
  let formatted = input;
  try {
    result = await run('caddy', ['fmt', '--overwrite', tmp]);
    try {
      formatted = await fs.readFile(tmp, 'utf8');
    } catch {}
  } finally {
    await fs.rm(tmp, { force: true });
  }
  if (result.code === -1) {
    return {
      ok: false,
      unavailable: true,
      code: -1,
      stdout: result.stdout,
      stderr: 'Caddy binary is not available in this container. Install/mount caddy to run caddy fmt.',
      content: input,
      changed: false,
    };
  }
  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    content: formatted,
    changed: formatted !== input,
  };
}

async function validateConfigForSettings(settings, content) {
  const normalized = normalizeSettings(settings);
  if (normalized.configMode !== 'api') {
    return validateConfig(content);
  }
  try {
    const response = await requestCaddyApi(normalized, '/adapt', {
      method: 'POST',
      headers: { 'Content-Type': 'text/caddyfile' },
      body: String(content || ''),
      timeoutMs: 12000,
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        code: response.status,
        stdout: '',
        stderr: body || `Caddy API adapt failed (${response.status}).`,
      };
    }
    return { ok: true, code: 0, stdout: body, stderr: '' };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      code: -1,
      stdout: '',
      stderr: error.message || 'Caddy API is unavailable.',
    };
  }
}


async function parseConfigCached(content) {
  const hash = createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
  const store = await stateStore;
  const cached = await store.getParsed(hash);
  if (cached) return cached;
  const parsed = parseCaddyfile(content);
  await store.setParsed(hash, parsed);
  if (Math.random() < 0.05) await store.pruneParsed(300);
  return parsed;
}

function normalizeProxyTags(tags = []) {
  const values = Array.isArray(tags)
    ? tags
    : String(tags || '')
        .split(',')
        .map((x) => x.trim());
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const tag = String(value || '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

function normalizeProxyCategory(value = '') {
  return String(value || '')
    .split(',')[0]
    .trim();
}

function proxyMetaKeyFromParts(host = '', upstream = '') {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedUpstream = String(upstream || '').trim();
  return normalizedHost && normalizedUpstream ? `${normalizedHost}|${normalizedUpstream}` : '';
}

function proxyMetaKeyFromSite(site) {
  const host = site?.addresses?.[0] || '';
  const upstream = site?.proxies?.[0]?.upstreams?.[0] || '';
  return proxyMetaKeyFromParts(host, upstream);
}

function mergeProxyMeta(parsed, metaMap = {}) {
  if (!parsed?.sites?.length) return parsed;
  const sites = parsed.sites.map((site) => {
    const key = proxyMetaKeyFromSite(site);
    const meta = key ? metaMap[key] : null;
    return {
      ...site,
      tags: normalizeProxyTags(meta?.tags?.length ? meta.tags : site.tags || []),
      category: normalizeProxyCategory(meta?.category || site.category || ''),
      description: normalizeProxyDescription(meta?.description || site.description || ''),
    };
  });
  return { ...parsed, sites };
}

async function parseConfigWithMeta(content) {
  const parsed = await parseConfigCached(content);
  const store = await stateStore;
  const metaMap = await store.getProxyMetaMap();
  const migrations = [];
  for (const site of parsed?.sites || []) {
    const key = proxyMetaKeyFromSite(site);
    if (!key || metaMap[key]) continue;
    const tags = normalizeProxyTags(site.tags || []);
    const category = normalizeProxyCategory(site.category || '');
    const description = normalizeProxyDescription(site.description || '');
    if (!tags.length && !category && !description) continue;
    migrations.push({ key, tags, category, description });
  }
  if (migrations.length) {
    for (const entry of migrations) {
      await store.setProxyMeta(entry.key, entry.tags, entry.category, entry.description);
      metaMap[entry.key] = { tags: entry.tags, category: entry.category, description: entry.description };
    }
  }
  const merged = mergeProxyMeta(parsed, metaMap);
  return merged;
}

async function pruneProxyMetaForParsed(parsed) {
  const store = await stateStore;
  const keys = (parsed?.sites || []).map(proxyMetaKeyFromSite).filter(Boolean);
  await store.pruneProxyMeta(keys);
}

async function saveProxyMetaByParts(host, upstream, tags = [], category = '', description = '') {
  const store = await stateStore;
  const key = proxyMetaKeyFromParts(host, upstream);
  if (!key) return;
  const normalizedTags = normalizeProxyTags(tags);
  const normalizedCategory = normalizeProxyCategory(category);
  const normalizedDescription = normalizeProxyDescription(description);
  if (!normalizedTags.length && !normalizedCategory && !normalizedDescription) {
    await store.deleteProxyMeta(key);
    return;
  }
  await store.setProxyMeta(key, normalizedTags, normalizedCategory, normalizedDescription);
}

async function saveProxyMetaForSite(site, tags = [], category = '', description = '') {
  const host = site?.addresses?.[0] || '';
  const upstream = site?.proxies?.[0]?.upstreams?.[0] || '';
  await saveProxyMetaByParts(host, upstream, tags, category, description);
}

async function deleteProxyMetaForSite(site) {
  const store = await stateStore;
  const key = proxyMetaKeyFromSite(site);
  if (!key) return;
  await store.deleteProxyMeta(key);
}

async function appBranch() {
  const result = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT });
  return result.ok ? result.stdout.trim() : 'unknown';
}

async function appUpdateStatus(fetchRemote = false, channelOverride = '') {
  const localRelease = readReleaseMetadataSync(RELEASE_METADATA_PATH, APP_PACKAGE_VERSION);
  const currentBranch = await appBranch();
  const settings = await loadSettings();
  const { channel, branch: targetBranch } = UPDATE_CHANNELS.has(String(channelOverride || '').trim().toLowerCase())
    ? updateTargetForChannel(channelOverride, currentBranch)
    : updateTargetFromSettings(settings, currentBranch);
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  if (fetchRemote && targetBranch !== 'unknown') {
    await run('git', ['fetch', '--quiet', 'origin', targetBranch], { cwd: ROOT });
  }
  const remoteHead = targetBranch === 'unknown' ? { ok: false, stdout: '' } : await run('git', ['rev-parse', `origin/${targetBranch}`], { cwd: ROOT });
  const localCommit = head.ok ? head.stdout.trim() : '';
  const remoteCommit = remoteHead.ok ? remoteHead.stdout.trim() : '';
  let remotePackageVersion = localRelease.version;
  if (targetBranch !== 'unknown') {
    const remotePkg = await run('git', ['show', `origin/${targetBranch}:package.json`], { cwd: ROOT });
    if (remotePkg.ok) {
      try {
        remotePackageVersion = JSON.parse(remotePkg.stdout).version || localRelease.version;
      } catch {}
    }
  }
  let remoteRelease = normalizeReleaseMetadata({}, remotePackageVersion);
  if (targetBranch !== 'unknown') {
    const remoteReleaseResult = await run('git', ['show', `origin/${targetBranch}:release.json`], { cwd: ROOT });
    if (remoteReleaseResult.ok) {
      remoteRelease = readReleaseMetadataFromGit(remoteReleaseResult.stdout, remotePackageVersion);
    }
  }
  const updateAvailable = Boolean(localCommit && remoteCommit && localCommit !== remoteCommit);
  return {
    version: localRelease.displayVersion,
    localVersion: localRelease.displayVersion,
    packageVersion: localRelease.version,
    localPackageVersion: localRelease.version,
    patchVersion: localRelease.patch,
    localPatchVersion: localRelease.patch,
    displayVersion: localRelease.displayVersion,
    localDisplayVersion: localRelease.displayVersion,
    remoteVersion: remoteRelease.displayVersion,
    remotePackageVersion: remoteRelease.version,
    remotePatchVersion: remoteRelease.patch,
    remoteDisplayVersion: remoteRelease.displayVersion,
    availableVersion: updateAvailable ? remoteRelease.displayVersion : localRelease.displayVersion,
    branch: targetBranch,
    updateChannel: channel,
    currentBranch,
    localCommit,
    remoteCommit,
    updateAvailable,
  };
}

app.get('/api/status', async (req, res) => {
  const settings = await loadSettings();
  const decoded = authenticatedUser(req);
  const authenticated = Boolean(decoded);
  const canDiscover = authenticated || normalizeSettings(settings).users.length === 0;
  res.json({
    settings: statusSettings(settings, authenticated, decoded?.username || ''),
    authenticated,
    discovered: canDiscover
      ? { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(settings) }
      : { caddyfiles: [], logfiles: [] },
  });
});

app.post('/api/setup/user', requireTrustedOrigin, requireSetupOrigin, async (req, res) => {
  const settings = await loadSettings();
  if (normalizeSettings(settings).users.length > 0) {
    return res.status(409).json({ error: 'Admin user is already configured.' });
  }
  const { username, password, setupToken } = req.body || {};
  const setupRateKey = `setup:${clientIp(req)}`;
  if (tooManyAttempts(setupRateKey)) {
    return res.status(429).json({ error: 'Too many setup attempts.' });
  }
  if (setupTokenRequired(settings) && !secureEqual(setupToken, SETUP_TOKEN)) {
    recordFailedAttempt(setupRateKey);
    return res.status(403).json({ error: 'Invalid setup token.' });
  }
  if (!validUsername(username) || !validPassword(password)) {
    recordFailedAttempt(setupRateKey);
    return res.status(400).json({ error: `Username format is invalid or password must be 8-${MAX_PASSWORD_LENGTH} characters.` });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const next = { ...settings, configured: false, users: [{ username: String(username).trim(), passwordHash, role: 'admin' }] };
  await saveSettings(next);
  clearAttempts(setupRateKey);
  res.cookie(COOKIE_NAME, sign(String(username).trim()), cookieOptions(req));
  const event = await recordEvent(req, {
    actorUsername: String(username).trim(),
    actorRole: 'admin',
    kind: 'auth',
    action: 'setup-user',
    targetType: 'user',
    targetId: String(username).trim(),
    message: `Created initial admin user ${String(username).trim()}.`,
  });
  res.json({
    event,
    settings: publicSettings(next, String(username).trim()),
    discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) },
  });
});

app.post('/api/setup/config', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  const settings = await loadSettings();
  const { caddyfilePath, logPaths = [], configMode, caddyApiUrl, caddyApiToken, caddyApiSecret, caddyApiTokenClear, caddyApiSecretClear } = req.body || {};
  const nextConfigMode = normalizeConfigMode(configMode, settings.configMode || 'api');
  const requestedCaddyfilePath = String(caddyfilePath || '').trim();
  if (nextConfigMode === 'file' && (!requestedCaddyfilePath || !fssync.existsSync(requestedCaddyfilePath))) {
    return res.status(400).json({ error: 'A readable Caddyfile path is required for file mode.' });
  }
  const nextCaddyApiUrl = normalizeApiUrl(caddyApiUrl, settings.caddyApiUrl || DEFAULT_CADDY_API_URL);
  if (nextConfigMode === 'api' && !nextCaddyApiUrl) {
    return res.status(400).json({ error: 'Caddy API URL is required for API mode.' });
  }

  const allowedLogs = [];
  for (const candidate of [...new Set([...logPaths, ...COMMON_LOGS].filter(Boolean))]) {
    if (await allowedLogPath(candidate)) allowedLogs.push(candidate);
  }

  let nextCaddyApiToken = settings.caddyApiToken || DEFAULT_CADDY_API_TOKEN;
  const providedSecret = typeof caddyApiSecret === 'string' && caddyApiSecret.trim() ? caddyApiSecret.trim() : '';
  const providedToken = typeof caddyApiToken === 'string' && caddyApiToken.trim() ? caddyApiToken.trim() : '';
  if (caddyApiTokenClear === true || caddyApiSecretClear === true) nextCaddyApiToken = '';
  else if (providedSecret) nextCaddyApiToken = providedSecret;
  else if (providedToken) nextCaddyApiToken = providedToken;

  const next = {
    ...settings,
    configured: true,
    configMode: nextConfigMode,
    caddyfilePath: requestedCaddyfilePath || settings.caddyfilePath,
    caddyApiUrl: nextCaddyApiUrl,
    caddyApiToken: nextCaddyApiToken,
    logPaths: allowedLogs,
  };
  await saveSettings(next);
  if (next.configMode === 'api') {
    if (requestedCaddyfilePath && fssync.existsSync(requestedCaddyfilePath)) {
      try {
        await saveWorkingConfig(await fs.readFile(requestedCaddyfilePath, 'utf8'));
      } catch {}
    } else {
      const store = await stateStore;
      const existing = await store.getJson('working_config', null);
      if (typeof existing?.content !== 'string') await saveWorkingConfig('');
    }
  }
  const event = await recordEvent(req, {
    kind: 'setup',
    action: 'setup-config',
    targetType: 'caddy',
    targetId: next.configMode,
    message: `Completed CaddyUI setup in ${next.configMode} mode.`,
    details: {
      configMode: next.configMode,
      caddyfilePath: next.caddyfilePath,
      caddyApiUrl: next.caddyApiUrl,
      logPaths: next.logPaths,
    },
  });
  res.json({
    event,
    settings: publicSettings(next, req.user.username),
    discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(next) },
  });
});

app.post('/api/login', requireTrustedOrigin, async (req, res) => {
  const settings = await loadSettings();
  const { username, password } = req.body || {};
  const normalizedUsername = String(username || '').trim();
  const rateKey = `${clientIp(req)}:${normalizedUsername}`;
  if (tooManyAttempts(rateKey)) return res.status(429).json({ error: 'Too many login attempts.' });

  const user = currentUserRecord(settings, normalizedUsername);
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    recordFailedAttempt(rateKey);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearAttempts(rateKey);
  res.cookie(COOKIE_NAME, sign(user.username), cookieOptions(req));
  const event = await recordEvent(req, {
    actorUsername: user.username,
    actorRole: user.role,
    kind: 'auth',
    action: 'login',
    targetType: 'session',
    targetId: user.username,
    message: `${user.username} signed in.`,
  });
  res.json({ settings: publicSettings(settings, user.username), event });
});

app.post('/api/logout', requireTrustedOrigin, async (req, res) => {
  const token = req.cookies[COOKIE_NAME] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  let decoded = null;
  if (token) {
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
      await revokeToken(decoded);
    } catch {}
  }
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
  const settings = await loadSettings();
  const user = currentUserRecord(settings, decoded?.username || '');
  const event = await recordEvent(req, {
    actorUsername: user?.username || decoded?.username || 'unknown',
    actorRole: user?.role || '',
    kind: 'auth',
    action: 'logout',
    targetType: 'session',
    targetId: user?.username || decoded?.username || '',
    message: `${user?.username || decoded?.username || 'User'} signed out.`,
  });
  res.json({ ok: true, event });
});

app.post('/api/caddy/load', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const contentInput = req.body?.content;
    if (contentInput === undefined) return res.status(400).json({ error: 'Config content is required.' });
    const format = String(req.body?.format || 'caddyfile').trim().toLowerCase();
    const content =
      typeof contentInput === 'string' ? contentInput : format === 'json' || format === 'application/json' ? JSON.stringify(contentInput) : '';
    if (!content.trim()) return res.status(400).json({ error: 'Config content is required.' });
    const contentType =
      format === 'json' || format === 'application/json'
        ? 'application/json'
        : format.includes('/')
          ? format
          : format === 'caddyfile'
            ? 'text/caddyfile'
            : `text/${format}`;
    const headers = { 'Content-Type': contentType };
    if (req.body?.forceReload === true) headers['Cache-Control'] = 'must-revalidate';
    const response = await requestCaddyApi(settings, '/load', {
      method: 'POST',
      headers,
      body: content,
      timeoutMs: 12000,
    });
    const result = await caddyResponseData(response);
    if (response.ok && contentType === 'text/caddyfile') await saveWorkingConfig(content);
    if (result.etag) res.setHeader('ETag', result.etag);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      etag: result.etag,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

app.post('/api/caddy/stop', requireTrustedOrigin, auth, requirePermission('admin'), async (_req, res) => {
  try {
    const settings = await loadSettings();
    const response = await requestCaddyApi(settings, '/stop', { method: 'POST', timeoutMs: 8000 });
    const result = await caddyResponseData(response);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

app.post('/api/caddy/adapt', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const contentInput = req.body?.content;
    if (contentInput === undefined) return res.status(400).json({ error: 'Config content is required.' });
    const format = String(req.body?.format || 'caddyfile').trim().toLowerCase();
    const content =
      typeof contentInput === 'string' ? contentInput : format === 'json' || format === 'application/json' ? JSON.stringify(contentInput) : '';
    if (!content.trim()) return res.status(400).json({ error: 'Config content is required.' });
    const contentType =
      format === 'json' || format === 'application/json'
        ? 'application/json'
        : format.includes('/')
          ? format
          : format === 'caddyfile'
            ? 'text/caddyfile'
            : `text/${format}`;
    const response = await requestCaddyApi(settings, '/adapt', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: content,
      timeoutMs: 12000,
    });
    const result = await caddyResponseData(response);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

const caddyConfigRoutes = ['/api/caddy/config', '/api/caddy/config/{*path}'];
const caddyIdRoutes = ['/api/caddy/id/:id', '/api/caddy/id/:id/{*path}'];

app.get(caddyConfigRoutes, auth, requirePermission('view'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const scope = caddyPathPart(req.params.path || req.query.path || '');
    const response = await requestCaddyApi(settings, caddyEndpoint('/config', scope), { method: 'GET', timeoutMs: 8000 });
    const result = await caddyResponseData(response);
    if (result.etag) res.setHeader('ETag', result.etag);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      etag: result.etag,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

for (const method of ['post', 'put', 'patch', 'delete']) {
  app[method](caddyConfigRoutes, requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
    try {
      const settings = await loadSettings();
      const scope = caddyPathPart(req.params.path || req.query.path || '');
      const payload = caddyMutationBody(req);
      const headers = { 'Content-Type': 'application/json' };
      const ifMatch = caddyIfMatch(req);
      if (ifMatch) headers['If-Match'] = ifMatch;
      const response = await requestCaddyApi(settings, caddyEndpoint('/config', scope), {
        method: method.toUpperCase(),
        headers,
        body: method === 'delete' && payload === undefined ? undefined : caddyPayload(payload),
        timeoutMs: 12000,
      });
      const result = await caddyResponseData(response);
      if (result.etag) res.setHeader('ETag', result.etag);
      return res.status(result.status).json({
        ok: result.ok,
        status: result.status,
        etag: result.etag,
        value: result.data,
        error: result.ok ? '' : result.raw,
      });
    } catch (error) {
      return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
    }
  });
}

app.get(caddyIdRoutes, auth, requirePermission('view'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const id = caddyPathPart(req.params.id || req.query.id || '');
    if (!id) return res.status(400).json({ error: 'ID path is required.' });
    const tail = caddyPathPart(req.params.path || req.query.path || '');
    const endpoint = tail ? `/id/${id}/${tail}` : `/id/${id}`;
    const response = await requestCaddyApi(settings, endpoint, { method: 'GET', timeoutMs: 8000 });
    const result = await caddyResponseData(response);
    if (result.etag) res.setHeader('ETag', result.etag);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      etag: result.etag,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

for (const method of ['post', 'put', 'patch', 'delete']) {
  app[method](caddyIdRoutes, requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
    try {
      const settings = await loadSettings();
      const id = caddyPathPart(req.params.id || req.query.id || '');
      if (!id) return res.status(400).json({ error: 'ID path is required.' });
      const tail = caddyPathPart(req.params.path || req.query.path || '');
      const endpoint = tail ? `/id/${id}/${tail}` : `/id/${id}`;
      const payload = caddyMutationBody(req);
      const headers = { 'Content-Type': 'application/json' };
      const ifMatch = caddyIfMatch(req);
      if (ifMatch) headers['If-Match'] = ifMatch;
      const response = await requestCaddyApi(settings, endpoint, {
        method: method.toUpperCase(),
        headers,
        body: method === 'delete' && payload === undefined ? undefined : caddyPayload(payload),
        timeoutMs: 12000,
      });
      const result = await caddyResponseData(response);
      if (result.etag) res.setHeader('ETag', result.etag);
      return res.status(result.status).json({
        ok: result.ok,
        status: result.status,
        etag: result.etag,
        value: result.data,
        error: result.ok ? '' : result.raw,
      });
    } catch (error) {
      return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
    }
  });
}

app.get('/api/caddy/pki/ca/:id', auth, requirePermission('view'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const id = encodeURIComponent(String(req.params.id || '').trim());
    if (!id) return res.status(400).json({ error: 'CA ID is required.' });
    const response = await requestCaddyApi(settings, `/pki/ca/${id}`, { method: 'GET', timeoutMs: 8000 });
    const result = await caddyResponseData(response);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

app.get('/api/caddy/pki/ca/:id/certificates', auth, requirePermission('view'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const id = encodeURIComponent(String(req.params.id || '').trim());
    if (!id) return res.status(400).json({ error: 'CA ID is required.' });
    const response = await requestCaddyApi(settings, `/pki/ca/${id}/certificates`, { method: 'GET', timeoutMs: 8000 });
    const result = await caddyResponseData(response);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

app.get('/api/caddy/reverse_proxy/upstreams', auth, requirePermission('view'), async (_req, res) => {
  try {
    const settings = await loadSettings();
    const response = await requestCaddyApi(settings, '/reverse_proxy/upstreams', { method: 'GET', timeoutMs: 8000 });
    const result = await caddyResponseData(response);
    return res.status(result.status).json({
      ok: result.ok,
      status: result.status,
      value: result.data,
      error: result.ok ? '' : result.raw,
    });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Caddy API is unavailable.' });
  }
});

app.get('/api/config', auth, requirePermission('view'), async (req, res) => {
  try {
    const { content, path } = await readWorkingConfig();
    const parsed = await parseConfigWithMeta(content);
    const wantsHealth = String(req.query.health || '0') === '1';
    if (wantsHealth && !hasPermission(req.user?.role, 'edit')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({
      path,
      content,
      parsed,
      health: wantsHealth ? await checkProxyHealth(parsed) : {},
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const settings = await loadSettings();
    const { content, validate = true } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'Config content is required.' });

    if (validate) {
      const validation = await validateConfigForSettings(settings, content);
      if (!validation.ok) {
        return res.status(400).json({ error: 'Caddy validation failed.', validation, parsed: await parseConfigWithMeta(content) });
      }
    }

    const { backup } = await applyConfigContent(settings, content, { backup: true });
    const parsed = await parseConfigWithMeta(content);
    await pruneProxyMetaForParsed(parsed);
    const event = await recordEvent(req, {
      kind: 'config',
      action: 'save',
      targetType: 'config',
      targetId: settings.configMode,
      message: `Saved Caddy configuration in ${settings.configMode} mode.`,
      details: { backup, configMode: settings.configMode, path: settings.caddyfilePath || 'caddy://admin-api' },
    });
    res.json({ ok: true, backup, parsed, content, event });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/proxies/health', auth, requirePermission('edit'), async (_req, res) => {
  try {
    const { content } = await readWorkingConfig();
    const parsed = await parseConfigWithMeta(content);
    res.json({ health: await checkProxyHealth(parsed) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config/validate', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  const settings = await loadSettings();
  const content = typeof req.body?.content === 'string' ? req.body.content : (await readWorkingConfig()).content;
  const result = await validateConfigForSettings(settings, content);
  const event = await recordEvent(req, {
    kind: 'config',
    action: 'validate',
    targetType: 'config',
    targetId: settings.configMode,
    status: result.ok ? 'success' : 'warning',
    message: result.ok ? 'Validated Caddy configuration.' : summarizeText(result.stderr || 'Caddy validation returned warnings.'),
    details: {
      configMode: settings.configMode,
      ok: result.ok,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    },
  });
  res.json({ ...result, event });
});

app.post('/api/config/format', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : (await readWorkingConfig()).content;
  const result = await formatConfig(content);
  const event = await recordEvent(req, {
    kind: 'config',
    action: 'format',
    targetType: 'config',
    targetId: 'caddyfile',
    status: result.ok ? 'success' : 'error',
    message: result.ok ? (result.changed ? 'Formatted Caddy configuration.' : 'Checked Caddy formatting; no changes needed.') : summarizeText(result.stderr || 'Caddy format failed.'),
    details: {
      ok: result.ok,
      changed: result.changed,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    },
  });
  if (result.ok) return res.json({ ...result, event });
  return res.status(result.unavailable ? 503 : 400).json({ ...result, event });
});

app.post('/api/config/reload', requireTrustedOrigin, auth, requirePermission('edit'), async (_req, res) => {
  const settings = await loadSettings();
  if (settings.configMode === 'api') {
    try {
      const { content } = await readWorkingConfig();
      if (!content.trim()) {
        return res.status(400).json({ ok: false, code: 400, stdout: '', stderr: 'No config content available to reload.' });
      }
      const response = await requestCaddyApi(settings, '/load', {
        method: 'POST',
        headers: { 'Content-Type': 'text/caddyfile', 'Cache-Control': 'must-revalidate' },
        body: content,
        timeoutMs: 12000,
      });
      if (!response.ok) {
        const stderr = (await response.text()) || `Caddy API reload failed (${response.status}).`;
        const event = await recordEvent(req, {
          kind: 'config',
          action: 'reload',
          targetType: 'caddy',
          targetId: 'admin-api',
          status: 'error',
          message: summarizeText(stderr),
          details: { code: response.status, stdout: '', stderr },
        });
        return res.status(400).json({ ok: false, code: response.status, stdout: '', stderr, event });
      }
      const event = await recordEvent(req, {
        kind: 'config',
        action: 'reload',
        targetType: 'caddy',
        targetId: 'admin-api',
        message: 'Reloaded Caddy via admin API.',
      });
      return res.json({ ok: true, code: 0, stdout: 'Reloaded Caddy via admin API.', stderr: '', event });
    } catch (error) {
      const stderr = error.message || 'Caddy API is unavailable.';
      const event = await recordEvent(req, {
        kind: 'config',
        action: 'reload',
        targetType: 'caddy',
        targetId: 'admin-api',
        status: 'error',
        message: summarizeText(stderr),
        details: { code: -1, stdout: '', stderr },
      });
      return res.status(503).json({ ok: false, code: -1, stdout: '', stderr, event });
    }
  }
  const result = await run('caddy', ['reload', '--config', settings.caddyfilePath, '--adapter', 'caddyfile']);
  if (result.code === -1) {
    const event = await recordEvent(req, {
      kind: 'config',
      action: 'reload',
      targetType: 'caddy',
      targetId: settings.caddyfilePath || 'caddyfile',
      status: 'error',
      message: 'Caddy binary is not available in this container. Run CaddyUI where it can execute caddy reload.',
      details: { ...result },
    });
    return res.status(503).json({
      ...result,
      stderr: 'Caddy binary is not available in this container. Run CaddyUI where it can execute caddy reload.',
      event,
    });
  }
  const event = await recordEvent(req, {
    kind: 'config',
    action: 'reload',
    targetType: 'caddy',
    targetId: settings.caddyfilePath || 'caddyfile',
    status: result.ok ? 'success' : 'error',
    message: summarizeText(result.ok ? (result.stdout || 'Reloaded Caddy.') : (result.stderr || 'Caddy reload failed.')),
    details: result,
  });
  return res.status(result.ok ? 200 : 400).json({ ...result, event });
});

app.post('/api/proxies', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const next = appendSimpleProxy(content, req.body || {});
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    await saveProxyMetaByParts(req.body?.host, req.body?.upstream, req.body?.tags, req.body?.category, req.body?.description);
    const parsed = await parseConfigWithMeta(next);
    const event = await recordEvent(req, {
      kind: 'proxy',
      action: 'create',
      targetType: 'proxy',
      targetId: String(req.body?.host || '').trim(),
      message: `Created proxy ${String(req.body?.host || '').trim()}.`,
      details: {
        host: String(req.body?.host || '').trim(),
        upstream: String(req.body?.upstream || '').trim(),
        mode: settings.configMode,
      },
    });
    res.json({ ok: true, validation, parsed, health: await checkProxyHealth(parsed), content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/proxies/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const previousParsed = await parseConfigCached(content);
    const previousSite = previousParsed.sites.find((site) => String(site.line) === String(req.params.line));
    const previousMetaKey = proxyMetaKeyFromSite(previousSite);
    const next = updateSimpleProxy(content, { ...req.body, siteLine: req.params.line });
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    const nextMetaKey = proxyMetaKeyFromParts(req.body?.host, req.body?.upstream);
    if (previousMetaKey && nextMetaKey && previousMetaKey !== nextMetaKey) {
      const store = await stateStore;
      await store.deleteProxyMeta(previousMetaKey);
    }
    await saveProxyMetaByParts(req.body?.host, req.body?.upstream, req.body?.tags, req.body?.category, req.body?.description);
    const parsed = await parseConfigWithMeta(next);
    const event = await recordEvent(req, {
      kind: 'proxy',
      action: 'update',
      targetType: 'proxy',
      targetId: String(req.body?.host || previousSite?.addresses?.[0] || '').trim(),
      message: `Updated proxy ${String(req.body?.host || previousSite?.addresses?.[0] || '').trim()}.`,
      details: {
        previousHost: previousSite?.addresses?.[0] || '',
        host: String(req.body?.host || '').trim(),
        upstream: String(req.body?.upstream || '').trim(),
      },
    });
    res.json({ ok: true, validation, parsed, health: await checkProxyHealth(parsed), content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/proxies/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const previousParsed = await parseConfigCached(content);
    const previousSite = previousParsed.sites.find((site) => String(site.line) === String(req.params.line));
    const next = deleteBlockAtLine(content, req.params.line);
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    await deleteProxyMetaForSite(previousSite);
    const parsed = await parseConfigWithMeta(next);
    const event = await recordEvent(req, {
      kind: 'proxy',
      action: 'delete',
      targetType: 'proxy',
      targetId: String(previousSite?.addresses?.[0] || req.params.line).trim(),
      message: `Deleted proxy ${String(previousSite?.addresses?.[0] || req.params.line).trim()}.`,
      details: {
        host: previousSite?.addresses?.[0] || '',
        upstream: previousSite?.proxies?.[0]?.upstreams?.[0] || '',
      },
    });
    res.json({ ok: true, validation, parsed, health: await checkProxyHealth(parsed), content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/proxies/:line/disabled', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const disabled = req.body?.disabled !== false;
    const next = setProxyDisabled(content, { siteLine: req.params.line, disabled });
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    const parsed = await parseConfigWithMeta(next);
    const targetSite = parsed.sites.find((site) => String(site.line) === String(req.params.line));
    const event = await recordEvent(req, {
      kind: 'proxy',
      action: disabled ? 'disable' : 'enable',
      targetType: 'proxy',
      targetId: String(targetSite?.addresses?.[0] || req.params.line).trim(),
      message: `${disabled ? 'Disabled' : 'Enabled'} proxy ${String(targetSite?.addresses?.[0] || req.params.line).trim()}.`,
      details: { disabled, host: targetSite?.addresses?.[0] || '' },
    });
    const health = targetSite ? { [targetSite.id]: await checkSiteHealth(targetSite) } : {};
    res.json({ ok: true, validation, parsed, health, content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/middlewares', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const next = appendSnippet(content, req.body || {});
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    const parsed = await parseConfigWithMeta(next);
    const event = await recordEvent(req, {
      kind: 'middleware',
      action: 'create',
      targetType: 'middleware',
      targetId: String(req.body?.name || '').trim(),
      message: `Created middleware ${String(req.body?.name || '').trim()}.`,
      details: { name: String(req.body?.name || '').trim() },
    });
    res.json({ ok: true, validation, parsed, content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/middlewares/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const next = updateSnippet(content, { ...req.body, line: req.params.line });
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    const parsed = await parseConfigWithMeta(next);
    const event = await recordEvent(req, {
      kind: 'middleware',
      action: 'update',
      targetType: 'middleware',
      targetId: String(req.body?.name || req.params.line).trim(),
      message: `Updated middleware ${String(req.body?.name || req.params.line).trim()}.`,
      details: { name: String(req.body?.name || '').trim(), line: req.params.line },
    });
    res.json({ ok: true, validation, parsed, content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/middlewares/:line', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  try {
    const { settings, content } = await readWorkingConfig();
    const previousParsed = await parseConfigCached(content);
    const previousSnippet = previousParsed.snippets.find((snippet) => String(snippet.line) === String(req.params.line));
    const next = deleteBlockAtLine(content, req.params.line);
    const validation = await validateConfigForSettings(settings, next);
    if (!validation.ok && !validation.unavailable) {
      return res.status(400).json({ error: 'Generated Caddyfile did not validate.', validation, parsed: await parseConfigWithMeta(next) });
    }
    await applyConfigContent(settings, next);
    const parsed = await parseConfigWithMeta(next);
    const event = await recordEvent(req, {
      kind: 'middleware',
      action: 'delete',
      targetType: 'middleware',
      targetId: String(previousSnippet?.name || req.params.line).trim(),
      message: `Deleted middleware ${String(previousSnippet?.name || req.params.line).trim()}.`,
      details: { name: previousSnippet?.name || '', line: req.params.line },
    });
    res.json({ ok: true, validation, parsed, content: next, event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/logs', auth, requirePermission('view'), async (req, res) => {
  const settings = await loadSettings();
  const requested = Number(req.query.lines || 200);
  const bounded = Number.isFinite(requested) ? Math.max(10, Math.min(2000, Math.floor(requested))) : 200;
  const mode = ['all', 'files', 'journal'].includes(String(req.query.mode || 'all')) ? String(req.query.mode || 'all') : 'all';
  res.json({ logs: await collectLogs({ ...settings, logMode: mode }, bounded) });
});

app.get('/api/events', auth, requirePermission('view'), async (req, res) => {
  const store = await stateStore;
  const limit = Number(req.query.limit || 200);
  res.json({ events: await store.listEvents({ limit }) });
});

app.get('/api/settings', auth, requirePermission('view'), async (req, res) => {
  const settings = await loadSettings();
  res.json({
    settings: publicSettings(settings, req.user.username),
    discovered: { caddyfiles: await scanCaddyfiles(), logfiles: await scanLogfiles(settings) },
  });
});

app.post('/api/settings', requireTrustedOrigin, auth, requirePermission('edit'), async (req, res) => {
  const settings = await loadSettings();
  const {
    configMode,
    caddyfilePath,
    caddyApiUrl,
    caddyApiToken,
    caddyApiSecret,
    caddyApiTokenClear,
    caddyApiSecretClear,
    logPaths,
    trustProxyHops,
    allowRemoteSetup,
    secureCookieMode,
    allowedOrigins,
  } = req.body || {};
  const requestedMode = configMode === undefined ? settings.configMode : normalizeConfigMode(configMode, settings.configMode || 'api');
  const requestedCaddyfilePath = String(caddyfilePath || '').trim();
  const requestedCaddyApiUrl = caddyApiUrl === undefined ? settings.caddyApiUrl : normalizeApiUrl(caddyApiUrl, settings.caddyApiUrl);
  const changingCaddyfilePath = requestedCaddyfilePath !== String(settings.caddyfilePath || '');
  if (requestedMode === 'file' && requestedCaddyfilePath && !fssync.existsSync(requestedCaddyfilePath)) {
    return res.status(400).json({ error: 'Caddyfile path does not exist.' });
  }
  if (requestedMode === 'file' && !requestedCaddyfilePath) {
    return res.status(400).json({ error: 'Caddyfile path is required in file mode.' });
  }
  if (requestedMode === 'api' && !requestedCaddyApiUrl) {
    return res.status(400).json({ error: 'Caddy API URL is required in API mode.' });
  }
  if (changingCaddyfilePath && !hasPermission(req.user?.role, 'admin')) {
    return res.status(403).json({ error: 'Admin permission required to change Caddyfile path.' });
  }
  const updatingSecuritySettings =
    trustProxyHops !== undefined ||
    allowRemoteSetup !== undefined ||
    secureCookieMode !== undefined ||
    allowedOrigins !== undefined;
  if (updatingSecuritySettings && !hasPermission(req.user?.role, 'admin')) {
    return res.status(403).json({ error: 'Admin permission required for security settings.' });
  }

  const nextLogPaths = [];
  for (const candidate of Array.isArray(logPaths) ? logPaths.filter(Boolean) : settings.logPaths) {
    if (await allowedLogPath(candidate)) nextLogPaths.push(candidate);
  }

  let nextCaddyApiToken = settings.caddyApiToken || DEFAULT_CADDY_API_TOKEN;
  const providedSecret = typeof caddyApiSecret === 'string' && caddyApiSecret.trim() ? caddyApiSecret.trim() : '';
  const providedToken = typeof caddyApiToken === 'string' && caddyApiToken.trim() ? caddyApiToken.trim() : '';
  if (caddyApiTokenClear === true || caddyApiSecretClear === true) nextCaddyApiToken = '';
  else if (providedSecret) nextCaddyApiToken = providedSecret;
  else if (providedToken) nextCaddyApiToken = providedToken;

  const next = {
    ...settings,
    configMode: requestedMode,
    caddyfilePath: requestedMode === 'file' ? requestedCaddyfilePath : settings.caddyfilePath,
    caddyApiUrl: requestedCaddyApiUrl,
    caddyApiToken: nextCaddyApiToken,
    logPaths: nextLogPaths,
    trustProxyHops:
      trustProxyHops === undefined ? settings.trustProxyHops : normalizeTrustProxyHops(trustProxyHops, settings.trustProxyHops),
    allowRemoteSetup:
      allowRemoteSetup === undefined ? settings.allowRemoteSetup : normalizeBoolean(allowRemoteSetup, settings.allowRemoteSetup),
    secureCookieMode:
      secureCookieMode === undefined ? settings.secureCookieMode : normalizeCookieMode(secureCookieMode, settings.secureCookieMode),
    allowedOrigins:
      allowedOrigins === undefined ? settings.allowedOrigins : normalizeAllowedOrigins(allowedOrigins),
  };
  await saveSettings(next);
  if (next.configMode === 'api') {
    const store = await stateStore;
    const existing = await store.getJson('working_config', null);
    if (typeof existing?.content !== 'string') {
      if (settings.caddyfilePath && fssync.existsSync(settings.caddyfilePath)) {
        try {
          await saveWorkingConfig(await fs.readFile(settings.caddyfilePath, 'utf8'));
        } catch {
          await saveWorkingConfig('');
        }
      } else {
        await saveWorkingConfig('');
      }
    }
  }
  const event = await recordEvent(req, {
    kind: 'settings',
    action: 'update',
    targetType: 'settings',
    targetId: next.configMode,
    message: `Updated settings and switched to ${next.configMode} mode.`,
    details: {
      configMode: next.configMode,
      caddyfilePath: next.caddyfilePath,
      caddyApiUrl: next.caddyApiUrl,
    },
  });
  res.json({ settings: publicSettings(next, req.user.username), event });
});

app.post('/api/settings/test-api', requireTrustedOrigin, auth, requirePermission('edit'), requireRateLimit('test-api', 20, 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const providedUrl = normalizeApiUrl(req.body?.caddyApiUrl, settings.caddyApiUrl || DEFAULT_CADDY_API_URL);
  const providedSecret =
    typeof req.body?.caddyApiSecret === 'string' && req.body.caddyApiSecret.trim()
      ? req.body.caddyApiSecret.trim()
      : typeof req.body?.caddyApiToken === 'string' && req.body.caddyApiToken.trim()
        ? req.body.caddyApiToken.trim()
        : settings.caddyApiToken;
  if (!providedUrl) return res.status(400).json({ error: 'Caddy API URL is required.' });
  try {
    const result = await testCaddyApiConnection(settings, { caddyApiUrl: providedUrl, caddyApiToken: providedSecret });
    const event = await recordEvent(req, {
      kind: 'settings',
      action: 'test-api',
      targetType: 'caddy-api',
      targetId: providedUrl,
      status: result.ok ? 'success' : 'error',
      message: result.message || (result.ok ? 'Connected to Caddy API.' : 'Caddy API test failed.'),
      details: { url: providedUrl, status: result.status, ok: result.ok },
    });
    return res.status(result.ok ? 200 : 400).json({ ...result, event });
  } catch (error) {
    const message = error.message || 'Caddy API is unavailable.';
    const event = await recordEvent(req, {
      kind: 'settings',
      action: 'test-api',
      targetType: 'caddy-api',
      targetId: providedUrl,
      status: 'error',
      message,
      details: { url: providedUrl, ok: false },
    });
    return res.status(503).json({ ok: false, message, event });
  }
});

app.post('/api/settings/reset-caddy-config', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('reset-caddy-config', 4, 15 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const confirmationUsername = String(req.body?.username || '').trim();
  if (!secureEqual(confirmationUsername, req.user.username)) {
    return res.status(400).json({ error: 'Confirmation username did not match your account.' });
  }
  const template = await loadResetConfigTemplate();
  const { backup } = await applyConfigContent(settings, template, { backup: true });
  await saveWorkingConfig(template);
  const parsed = await parseConfigWithMeta(template);
  await pruneProxyMetaForParsed(parsed);
  const event = await recordEvent(req, {
    kind: 'settings',
    action: 'reset-config',
    targetType: 'config',
    targetId: settings.configMode,
    message: 'Reset Caddy configuration to the template.',
    details: { backup, configMode: settings.configMode },
  });
  return res.json({ ok: true, backup, content: template, parsed, event });
});

app.post('/api/settings/reset-onboarding', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('reset-onboarding', 3, 15 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const confirmationUsername = String(req.body?.username || '').trim();
  if (!secureEqual(confirmationUsername, req.user.username)) {
    return res.status(400).json({ error: 'Confirmation username did not match your account.' });
  }
  const next = normalizeSettings({
    configured: false,
    configMode: 'api',
    caddyfilePath: '',
    caddyApiUrl: settings.caddyApiUrl || DEFAULT_CADDY_API_URL,
    caddyApiToken: '',
    logPaths: settings.logPaths || COMMON_LOGS,
    updateChannel: settings.updateChannel || 'stable',
    trustProxyHops: settings.trustProxyHops,
    allowRemoteSetup: settings.allowRemoteSetup,
    secureCookieMode: settings.secureCookieMode,
    allowedOrigins: settings.allowedOrigins,
    users: [],
  });
  await saveSettings(next);
  const store = await stateStore;
  await store.setJson('working_config', { content: '', updatedAt: new Date().toISOString() });
  await store.setJson('sessions', { revoked: {} });
  await store.pruneProxyMeta([]);
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
  const event = await recordEvent(req, {
    kind: 'settings',
    action: 'reset-onboarding',
    targetType: 'app',
    targetId: 'onboarding',
    message: 'Reset CaddyUI to onboarding.',
  });
  return res.json({ ok: true, settings: statusSettings(next, false, ''), event });
});

app.put('/api/settings/update-channel', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('update-channel', 10, 5 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const channel = String(req.body?.updateChannel || '').trim().toLowerCase();
  if (!UPDATE_CHANNELS.has(channel)) {
    return res.status(400).json({ error: 'Invalid update channel.' });
  }
  const next = {
    ...settings,
    updateChannel: channel,
  };
  await saveSettings(next);
  const event = await recordEvent(req, {
    kind: 'settings',
    action: 'update-channel',
    targetType: 'updates',
    targetId: channel,
    message: `Changed update channel to ${channel}.`,
  });
  res.json({ settings: publicSettings(next, req.user.username), event });
});

app.get('/api/users', auth, requirePermission('admin'), async (_req, res) => {
  const settings = await loadSettings();
  res.json({ users: normalizeSettings(settings).users.map(exposeUser) });
});

app.post('/api/users', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('create-user', 12, 15 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  const { username, password, role } = req.body || {};
  if (!validUsername(username) || !validPassword(password)) {
    return res.status(400).json({ error: `Username format is invalid or password must be 8-${MAX_PASSWORD_LENGTH} characters.` });
  }
  if (!VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  if (currentUserRecord(normalized, username)) {
    return res.status(409).json({ error: 'User already exists.' });
  }

  normalized.users.push({
    username: String(username).trim(),
    passwordHash: await bcrypt.hash(password, 12),
    role,
  });
  await saveSettings(normalized);
  const event = await recordEvent(req, {
    kind: 'user',
    action: 'create',
    targetType: 'user',
    targetId: String(username).trim(),
    message: `Created user ${String(username).trim()} with role ${role}.`,
    details: { username: String(username).trim(), role },
  });
  res.json({ users: normalized.users.map(exposeUser), event });
});

app.put('/api/users/:username', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('update-user', 20, 15 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  const user = currentUserRecord(normalized, req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { role, password } = req.body || {};
  if (role && !VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  if (role) {
    if (user.role === 'admin' && role !== 'admin' && adminCount(normalized) <= 1) {
      return res.status(400).json({ error: 'At least one admin user is required.' });
    }
    user.role = role;
  }

  if (password) {
    if (!validPassword(password)) {
      return res.status(400).json({ error: `Password must be 8-${MAX_PASSWORD_LENGTH} characters.` });
    }
    user.passwordHash = await bcrypt.hash(password, 12);
  }

  await saveSettings(normalized);
  const event = await recordEvent(req, {
    kind: 'user',
    action: 'update',
    targetType: 'user',
    targetId: user.username,
    message: `Updated user ${user.username}.`,
    details: { username: user.username, role: user.role, passwordChanged: Boolean(password) },
  });
  res.json({ users: normalized.users.map(exposeUser), event });
});

app.delete('/api/users/:username', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('delete-user', 12, 15 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  if (req.user.username === req.params.username) {
    return res.status(400).json({ error: 'Cannot delete current user.' });
  }
  const target = currentUserRecord(normalized, req.params.username);
  if (target?.role === 'admin' && adminCount(normalized) <= 1) {
    return res.status(400).json({ error: 'At least one admin user is required.' });
  }

  normalized.users = normalized.users.filter((user) => user.username !== req.params.username);
  await saveSettings(normalized);
  const event = await recordEvent(req, {
    kind: 'user',
    action: 'delete',
    targetType: 'user',
    targetId: req.params.username,
    message: `Deleted user ${req.params.username}.`,
  });
  res.json({ users: normalized.users.map(exposeUser), event });
});

app.post('/api/account/password', requireTrustedOrigin, auth, requirePermission('view'), requireRateLimit('change-password', 8, 15 * 60 * 1000), async (req, res) => {
  const settings = await loadSettings();
  const normalized = normalizeSettings(settings);
  const user = currentUserRecord(normalized, req.user.username);
  const { currentPassword, newPassword } = req.body || {};
  if (!user || !(await bcrypt.compare(currentPassword || '', user.passwordHash))) {
    return res.status(401).json({ error: 'Current password is invalid.' });
  }
  if (!validPassword(newPassword)) {
    return res.status(400).json({ error: `New password must be 8-${MAX_PASSWORD_LENGTH} characters.` });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await saveSettings(normalized);
  const event = await recordEvent(req, {
    kind: 'user',
    action: 'change-password',
    targetType: 'user',
    targetId: req.user.username,
    message: `Changed password for ${req.user.username}.`,
  });
  res.json({ ok: true, event });
});

app.get('/api/app/status', auth, requirePermission('view'), async (_req, res) => {
  res.json(await appUpdateStatus(false));
});

app.post('/api/app/check-updates', requireTrustedOrigin, auth, requirePermission('view'), async (req, res) => {
  const override = String(req.body?.updateChannel || '').trim().toLowerCase();
  const channelOverride = UPDATE_CHANNELS.has(override) ? override : '';
  res.json(await appUpdateStatus(true, channelOverride));
});

app.post('/api/app/update', requireTrustedOrigin, auth, requirePermission('admin'), requireRateLimit('app-update', 4, 30 * 60 * 1000), async (req, res) => {
  const currentBranch = await appBranch();
  const settings = await loadSettings();
  const override = String(req.body?.updateChannel || '').trim().toLowerCase();
  const { branch } = UPDATE_CHANNELS.has(override)
    ? updateTargetForChannel(override, currentBranch)
    : updateTargetFromSettings(settings, currentBranch);
  const scriptPath = path.join(ROOT, 'scripts', 'install.sh');
  if (!fssync.existsSync(scriptPath)) {
    return res.status(500).json({ error: 'Installer script not found.' });
  }
  const child = spawn('bash', [scriptPath], {
    cwd: ROOT,
    env: { ...process.env, CADDYUI_BRANCH: branch, CADDYUI_ASSUME_YES: '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const event = await recordEvent(req, {
    kind: 'app',
    action: 'update',
    targetType: 'branch',
    targetId: branch,
    message: `Started app update from ${currentBranch} to ${branch}.`,
    details: { currentBranch, targetBranch: branch },
  });
  res.json({ ok: true, started: true, event });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

loadSettings().catch(() => {});

app.listen(PORT, () => {
  console.log(`CaddyUI API listening on :${PORT}`);
});
