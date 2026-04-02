/**
 * Stockage des sessions express-session dans SQLite (même fichier que likes / users si SQLITE_PATH identique).
 * Évite la perte de session au redémarrage ou au réveil Render (MemoryStore = RAM uniquement).
 */

const fs = require('fs');
const path = require('path');
const Store = require('express-session').Store;
const Database = require('better-sqlite3');

function sessionExpiryMs(sess) {
  if (!sess || !sess.cookie) {
    return Date.now() + 7 * 24 * 60 * 60 * 1000;
  }
  if (sess.cookie.expires) {
    const t = new Date(sess.cookie.expires).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (typeof sess.cookie.originalMaxAge === 'number') {
    return Date.now() + sess.cookie.originalMaxAge;
  }
  if (typeof sess.cookie.maxAge === 'number') {
    return Date.now() + sess.cookie.maxAge;
  }
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}

class SessionSqliteStore extends Store {
  /**
   * @param {{ dbPath?: string }} [options]
   */
  constructor(options = {}) {
    super();
    this.dbPath =
      options.dbPath ||
      process.env.SQLITE_PATH ||
      path.join(__dirname, '..', 'data', 'app.db');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS express_session (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_express_session_expired ON express_session(expired);
    `);
    this._get = this.db.prepare(
      'SELECT sess FROM express_session WHERE sid = ? AND expired > ?'
    );
    this._set = this.db.prepare(
      'INSERT OR REPLACE INTO express_session (sid, sess, expired) VALUES (?, ?, ?)'
    );
    this._destroy = this.db.prepare('DELETE FROM express_session WHERE sid = ?');
    this._touch = this.db.prepare(
      'UPDATE express_session SET expired = ? WHERE sid = ?'
    );
    this._prune = this.db.prepare('DELETE FROM express_session WHERE expired < ?');
  }

  get(sid, callback) {
    if (!callback) return;
    try {
      const row = this._get.get(sid, Date.now());
      if (!row) {
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    if (!callback) return;
    try {
      const expired = sessionExpiryMs(sess);
      this._set.run(sid, JSON.stringify(sess), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this._destroy.run(sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid, sess, callback) {
    if (!callback) return;
    try {
      const expired = sessionExpiryMs(sess);
      const info = this._touch.run(expired, sid);
      if (info.changes === 0) {
        this.set(sid, sess, callback);
        return;
      }
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  prune(callback) {
    try {
      this._prune.run(Date.now());
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }
}

module.exports = SessionSqliteStore;
