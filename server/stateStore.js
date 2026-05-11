import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function createStateStore({ dataDir, dbPath, settingsPath, sessionPath, fileMode = 0o600 }) {
  await fs.mkdir(dataDir, { recursive: true });
  const databasePath = dbPath || path.join(dataDir, 'caddyui.db');
  const db = await open({ filename: databasePath, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS parse_cache (
      content_hash TEXT PRIMARY KEY,
      parsed_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  if (settingsPath && fssync.existsSync(settingsPath)) {
    const existing = await db.get('SELECT key FROM kv_store WHERE key = ?', 'settings');
    if (!existing) {
      const settings = await readJsonFile(settingsPath);
      if (settings) {
        const now = Date.now();
        await db.run(
          'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)',
          'settings',
          JSON.stringify(settings),
          now
        );
      }
    }
  }

  if (sessionPath && fssync.existsSync(sessionPath)) {
    const existing = await db.get('SELECT key FROM kv_store WHERE key = ?', 'sessions');
    if (!existing) {
      const sessions = await readJsonFile(sessionPath);
      if (sessions) {
        const now = Date.now();
        await db.run(
          'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)',
          'sessions',
          JSON.stringify(sessions),
          now
        );
      }
    }
  }

  try {
    await fs.chmod(databasePath, fileMode);
  } catch {}

  return {
    async getJson(key, fallbackValue) {
      const row = await db.get('SELECT value FROM kv_store WHERE key = ?', key);
      if (!row?.value) return fallbackValue;
      try {
        return JSON.parse(row.value);
      } catch {
        return fallbackValue;
      }
    },

    async setJson(key, value) {
      const now = Date.now();
      const payload = JSON.stringify(value);
      await db.run(
        `
          INSERT INTO kv_store (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE
          SET value = excluded.value,
              updated_at = excluded.updated_at
        `,
        key,
        payload,
        now
      );
    },

    async getParsed(contentHash) {
      const row = await db.get('SELECT parsed_json FROM parse_cache WHERE content_hash = ?', contentHash);
      if (!row?.parsed_json) return null;
      try {
        return JSON.parse(row.parsed_json);
      } catch {
        return null;
      }
    },

    async setParsed(contentHash, parsed) {
      const now = Date.now();
      await db.run(
        `
          INSERT INTO parse_cache (content_hash, parsed_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(content_hash) DO UPDATE
          SET parsed_json = excluded.parsed_json,
              updated_at = excluded.updated_at
        `,
        contentHash,
        JSON.stringify(parsed),
        now
      );
    },

    async pruneParsed(limit = 300) {
      await db.run(
        `
          DELETE FROM parse_cache
          WHERE content_hash IN (
            SELECT content_hash
            FROM parse_cache
            ORDER BY updated_at DESC
            LIMIT -1 OFFSET ?
          )
        `,
        Math.max(50, Number(limit) || 300)
      );
    },
  };
}
