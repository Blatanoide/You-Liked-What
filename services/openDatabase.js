/**
 * Ouvre une base libSQL : fichier local, ou réplique embarquée synchronisée avec Turso (gratuit).
 * API alignée sur better-sqlite3 (prepare / run / transaction / sync).
 */

const Database = require('libsql');
const path = require('path');
const { ensureSqliteDirectory } = require('../config/sqlitePath');

let syncTimer = null;

/** Évite deux `db.sync()` en parallèle (Timers + import + écritures) → erreur libsql `InvalidParserState`. */
let tursoSyncBusy = false;
let tursoSyncPending = false;

/**
 * Un seul sync à la fois sur la connexion (requis par libsql / réplication).
 * @param {import('libsql').Database} db
 */
function runTursoSyncSerial(db) {
  if (!tursoCreds().enabled || !db || typeof db.sync !== 'function') return;
  if (tursoSyncBusy) {
    tursoSyncPending = true;
    return;
  }
  tursoSyncBusy = true;
  try {
    do {
      tursoSyncPending = false;
      db.sync();
    } while (tursoSyncPending);
  } catch (e) {
    console.warn('[DB] Turso sync :', e.message || e);
  } finally {
    tursoSyncBusy = false;
  }
}

function tursoCreds() {
  const url = (
    process.env.TURSO_DATABASE_URL ||
    process.env.LIBSQL_SYNC_URL ||
    ''
  ).trim();
  const token = (process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '').trim();
  return { url, token, enabled: Boolean(url && token) };
}

function getTursoReplicaFilePath() {
  const parent = path.dirname(ensureSqliteDirectory());
  return path.join(parent, 'turso-replica.db');
}

/**
 * @returns {import('libsql').Database}
 */
function openPrimaryDatabase() {
  const { url, token, enabled } = tursoCreds();
  if (enabled) {
    const file = getTursoReplicaFilePath();
    /** @see https://github.com/tursodatabase/libsql-js — false = écritures locales plus rapides (gros import), puis sync() explicite. */
    const readYourWrites =
      String(process.env.TURSO_READ_YOUR_WRITES || 'true').toLowerCase() !== 'false';
    const db = new Database(file, {
      syncUrl: url,
      authToken: token,
      readYourWrites,
    });
    try {
      runTursoSyncSerial(db);
    } catch (e) {
      console.error('[DB] Turso sync() au démarrage :', e.message || e);
    }
    try {
      db.pragma('journal_mode = WAL');
    } catch (_) {
      /* ignore */
    }
    return db;
  }
  const file = ensureSqliteDirectory();
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Pousse les écritures locales vers Turso (debounce léger).
 * @param {import('libsql').Database} db
 */
function scheduleTursoPush(db) {
  if (!tursoCreds().enabled || !db || typeof db.sync !== 'function') return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    runTursoSyncSerial(db);
  }, 400);
}

/**
 * Sync immédiate vers Turso (après gros import, ou si TURSO_READ_YOUR_WRITES=false).
 * @param {import('libsql').Database} db
 */
function flushTursoSyncNow(db) {
  if (!tursoCreds().enabled || !db || typeof db.sync !== 'function') return;
  clearTimeout(syncTimer);
  syncTimer = null;
  runTursoSyncSerial(db);
}

module.exports = {
  tursoCreds,
  openPrimaryDatabase,
  scheduleTursoPush,
  flushTursoSyncNow,
  syncTursoReplica: runTursoSyncSerial,
  getTursoReplicaFilePath,
};
