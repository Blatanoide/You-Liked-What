/**
 * Jetons à usage unique pour transférer une session entre origines (ex. Vercel → Render).
 * Contourne le partitionnement des cookies tiers (CHIPS).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TTL_SEC = 5 * 60;

let db;

function getDb() {
  if (db) return db;
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_handoff (
      token TEXT PRIMARY KEY,
      sess_json TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * @param {string} token
 * @param {{ user: object, loginMethod: string|null }} payload
 */
function createToken(token, payload) {
  const d = getDb();
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  d.prepare('INSERT INTO auth_handoff (token, sess_json, expires) VALUES (?, ?, ?)').run(
    token,
    JSON.stringify(payload),
    exp
  );
}

/**
 * @param {string} token
 * @returns {{ user: object, loginMethod: string|null } | null}
 */
function takeToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = d
    .prepare('SELECT sess_json FROM auth_handoff WHERE token = ? AND expires > ?')
    .get(token, now);
  if (!row) return null;
  d.prepare('DELETE FROM auth_handoff WHERE token = ?').run(token);
  try {
    const o = JSON.parse(row.sess_json);
    if (!o || !o.user || !o.user.id) return null;
    return o;
  } catch {
    return null;
  }
}

function prune() {
  try {
    getDb()
      .prepare('DELETE FROM auth_handoff WHERE expires < ?')
      .run(Math.floor(Date.now() / 1000));
  } catch (_) {
    /* ignore */
  }
}

module.exports = { createToken, takeToken, prune, TTL_SEC };
