/**
 * Jetons à usage unique pour transférer une session entre origines (ex. Vercel → Render).
 */

const likesStore = require('./likesStore');
const { scheduleTursoPush } = require('./openDatabase');

const TTL_SEC = 5 * 60;

/**
 * @param {string} token
 * @param {{ user: object, loginMethod: string|null }} payload
 */
function createToken(token, payload) {
  const d = likesStore.getDb();
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  d.prepare('INSERT INTO auth_handoff (token, sess_json, expires) VALUES (?, ?, ?)').run(
    token,
    JSON.stringify(payload),
    exp
  );
  scheduleTursoPush(d);
}

/**
 * @param {string} token
 * @returns {{ user: object, loginMethod: string|null } | null}
 */
function takeToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const d = likesStore.getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = d
    .prepare('SELECT sess_json FROM auth_handoff WHERE token = ? AND expires > ?')
    .get(token, now);
  if (!row) return null;
  d.prepare('DELETE FROM auth_handoff WHERE token = ?').run(token);
  scheduleTursoPush(d);
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
    const d = likesStore.getDb();
    d.prepare('DELETE FROM auth_handoff WHERE expires < ?').run(Math.floor(Date.now() / 1000));
  } catch (_) {
    /* ignore */
  }
}

module.exports = { createToken, takeToken, prune, TTL_SEC };
