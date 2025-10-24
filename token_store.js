// token_store.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'stockhub.db');

export async function initDb() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER
    );
  `);
  return db;
}

export async function saveTokens(db, { access_token, refresh_token, expires_in }) {
  const expires_at = Math.floor(Date.now() / 1000) + (expires_in || 3600);
  await db.run(`DELETE FROM tokens`);
  await db.run(
    `INSERT INTO tokens (access_token, refresh_token, expires_at) VALUES (?, ?, ?)`,
    access_token,
    refresh_token || null,
    expires_at
  );
}

export async function loadTokens(db) {
  const row = await db.get(`SELECT * FROM tokens LIMIT 1`);
  return row || null;
}
