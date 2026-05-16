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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_meta (
      proxy_key TEXT PRIMARY KEY,
      tags_json TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    await db.exec(`ALTER TABLE proxy_meta ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  } catch {}

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

    async getProxyMetaMap() {
      const rows = await db.all('SELECT proxy_key, tags_json, category, description FROM proxy_meta');
      const result = {};
      for (const row of rows || []) {
        let tags = [];
        try {
          const parsed = JSON.parse(String(row.tags_json || '[]'));
          if (Array.isArray(parsed)) tags = parsed.map((x) => String(x || '').trim()).filter(Boolean);
        } catch {}
        result[row.proxy_key] = {
          tags,
          category: String(row.category || '').trim(),
          description: String(row.description || '').trim(),
        };
      }
      return result;
    },

    async setProxyMeta(proxyKey, tags = [], category = '', description = '') {
      const key = String(proxyKey || '').trim();
      if (!key) return;
      const cleanedTags = [...new Set((Array.isArray(tags) ? tags : []).map((x) => String(x || '').trim()).filter(Boolean))];
      const cleanedCategory = String(category || '').trim();
      const cleanedDescription = String(description || '').trim();
      const now = Date.now();
      await db.run(
        `
          INSERT INTO proxy_meta (proxy_key, tags_json, category, description, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(proxy_key) DO UPDATE
          SET tags_json = excluded.tags_json,
              category = excluded.category,
              description = excluded.description,
              updated_at = excluded.updated_at
        `,
        key,
        JSON.stringify(cleanedTags),
        cleanedCategory,
        cleanedDescription,
        now
      );
    },

    async deleteProxyMeta(proxyKey) {
      const key = String(proxyKey || '').trim();
      if (!key) return;
      await db.run('DELETE FROM proxy_meta WHERE proxy_key = ?', key);
    },

    async pruneProxyMeta(validKeys = []) {
      const keys = [...new Set((Array.isArray(validKeys) ? validKeys : []).map((x) => String(x || '').trim()).filter(Boolean))];
      if (keys.length === 0) {
        await db.run('DELETE FROM proxy_meta');
        return;
      }
      const placeholders = keys.map(() => '?').join(', ');
      await db.run(`DELETE FROM proxy_meta WHERE proxy_key NOT IN (${placeholders})`, ...keys);
    },
  };
}
