import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const RELEASE_PATH = path.join(ROOT, 'release.json');

function formatDatePatchKey(date = new Date()) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${day}${month}${year}`;
}

function normalizePatchId(value = '') {
  const trimmed = String(value || '').trim();
  return /^\d{8}-\d+$/.test(trimmed) ? trimmed : '';
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const packageJson = await readJson(PACKAGE_JSON_PATH, {});
const release = await readJson(RELEASE_PATH, {});
const packageVersion = String(packageJson.version || '').trim() || '0.0.0-dev';
const today = normalizePatchId(process.env.CADDYUI_PATCH_ID || '')
  || `${process.env.CADDYUI_PATCH_DATE || formatDatePatchKey()}-1`;
const todayMatch = /^(\d{8})-(\d+)$/.exec(today);

if (!todayMatch) {
  console.error('Invalid patch id/date. Use DDMMYYYY-N or set CADDYUI_PATCH_DATE=DDMMYYYY.');
  process.exit(1);
}

const currentPatch = normalizePatchId(release.patch);
const currentMatch = /^(\d{8})-(\d+)$/.exec(currentPatch);
const requestedDate = todayMatch[1];
const requestedOrdinal = Number(todayMatch[2]);

let nextOrdinal = requestedOrdinal;
if (!process.env.CADDYUI_PATCH_ID) {
  nextOrdinal = currentMatch && currentMatch[1] === requestedDate ? Number(currentMatch[2]) + 1 : 1;
}

const nextPatch = `${requestedDate}-${nextOrdinal}`;
const nextRelease = {
  version: packageVersion,
  patch: nextPatch,
};

await fs.writeFile(RELEASE_PATH, `${JSON.stringify(nextRelease, null, 2)}\n`, 'utf8');
process.stdout.write(`${packageVersion}+${nextPatch}\n`);
