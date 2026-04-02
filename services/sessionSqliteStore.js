/**
 * Stockage des sessions express-session dans SQLite (même connexion que likes / users).
 */

const Store = require('express-session').Store;
const likesStore = require('./likesStore');
const { scheduleTursoPush } = require('./openDatabase');

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
  constructor() {
    super();
    this._get = null;
    this._set = null;
    this._destroy = null;
    this._touch = null;
    this._prune = null;
  }

  _ensurePrepared() {
    if (this._get) return;
    const db = likesStore.getDb();
    this._get = db.prepare(
      'SELECT sess FROM express_session WHERE sid = ? AND expired > ?'
    );
    this._set = db.prepare(
      'INSERT OR REPLACE INTO express_session (sid, sess, expired) VALUES (?, ?, ?)'
    );
    this._destroy = db.prepare('DELETE FROM express_session WHERE sid = ?');
    this._touch = db.prepare('UPDATE express_session SET expired = ? WHERE sid = ?');
    this._prune = db.prepare('DELETE FROM express_session WHERE expired < ?');
  }

  get(sid, callback) {
    if (!callback) return;
    try {
      this._ensurePrepared();
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
      this._ensurePrepared();
      const db = likesStore.getDb();
      const expired = sessionExpiryMs(sess);
      this._set.run(sid, JSON.stringify(sess), expired);
      scheduleTursoPush(db);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this._ensurePrepared();
      const db = likesStore.getDb();
      this._destroy.run(sid);
      scheduleTursoPush(db);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid, sess, callback) {
    if (!callback) return;
    try {
      this._ensurePrepared();
      const db = likesStore.getDb();
      const expired = sessionExpiryMs(sess);
      const info = this._touch.run(expired, sid);
      if (info.changes === 0) {
        this.set(sid, sess, callback);
        return;
      }
      scheduleTursoPush(db);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  prune(callback) {
    try {
      this._ensurePrepared();
      this._prune.run(Date.now());
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }
}

module.exports = SessionSqliteStore;
