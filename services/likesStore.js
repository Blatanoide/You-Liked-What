/**
 * Stockage durable des likes par utilisateur (SQLite).
 * Le jeu utilise les `limit` derniers (par défaut 100), triés par date de like si connue.
 */

const instagramService = require('./instagramService');
const { openPrimaryDatabase, scheduleTursoPush, tursoCreds } = require('./openDatabase');

const GAME_POOL_LIMIT = Math.min(500, Math.max(50, Number(process.env.LIKES_GAME_POOL_LIMIT) || 100));

let db;

function getDb() {
  if (db) return db;
  db = openPrimaryDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_liked_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      post_url TEXT NOT NULL,
      shortcode TEXT,
      liked_at INTEGER,
      source_label TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, post_url)
    );
    CREATE INDEX IF NOT EXISTS idx_user_liked_posts_user ON user_liked_posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_liked_posts_user_liked ON user_liked_posts(user_id, liked_at);
    CREATE TABLE IF NOT EXISTS express_session (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_express_session_expired ON express_session(expired);
    CREATE TABLE IF NOT EXISTS auth_handoff (
      token TEXT PRIMARY KEY,
      sess_json TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);
  return db;
}

function normalizePostUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().split('?')[0].split('#')[0];
  const sc = instagramService.extractShortcode(trimmed);
  if (!sc) return null;
  const reel = /instagram\.com\/(?:reel|reels)\//i.test(trimmed);
  const tv = /instagram\.com\/tv\//i.test(trimmed);
  if (tv) return `https://www.instagram.com/tv/${sc}/`;
  if (reel) return `https://www.instagram.com/reel/${sc}/`;
  return `https://www.instagram.com/p/${sc}/`;
}

/**
 * @param {string} userId
 * @param {number} [limit]
 * @returns {string[]}
 */
function getUrlsForUser(userId, limit = GAME_POOL_LIMIT) {
  if (!userId) return [];
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT post_url FROM user_liked_posts
       WHERE user_id = ?
       ORDER BY (liked_at IS NULL), liked_at DESC, id DESC
       LIMIT ?`
    )
    .all(String(userId), limit);
  return rows.map((r) => r.post_url);
}

function countForUser(userId) {
  if (!userId) return 0;
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM user_liked_posts WHERE user_id = ?').get(String(userId));
  return row ? row.c : 0;
}

function hasPost(userId, postUrl) {
  const n = normalizePostUrl(postUrl);
  if (!n || !userId) return false;
  const row = getDb().prepare('SELECT 1 FROM user_liked_posts WHERE user_id = ? AND post_url = ?').get(String(userId), n);
  return Boolean(row);
}

/**
 * Si la base est vide mais la session contient déjà des URLs (ancien mode session seule), copie unique.
 */
function migrateFromSessionIfEmpty(userId, sessionLikes) {
  if (!userId || countForUser(userId) > 0) return;
  const list = Array.isArray(sessionLikes) ? sessionLikes : [];
  if (list.length === 0) return;
  const entries = [];
  for (const raw of list) {
    const postUrl = normalizePostUrl(raw);
    if (!postUrl) continue;
    entries.push({
      postUrl,
      shortcode: instagramService.extractShortcode(postUrl),
      likedAt: null,
      sourceLabel: 'session_legacy',
    });
  }
  upsertMany(userId, entries);
}

/**
 * @param {string} userId
 * @param {{ postUrl: string, shortcode?: string|null, likedAt?: number|null, sourceLabel?: string }[]} entries
 * @param {{ skipScheduleTurso?: boolean }} [options]
 */
function upsertMany(userId, entries, options = {}) {
  if (!userId || !Array.isArray(entries) || entries.length === 0) {
    return { processed: 0, skippedInvalid: 0 };
  }
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO user_liked_posts (user_id, post_url, shortcode, liked_at, source_label)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, post_url) DO UPDATE SET
      shortcode = COALESCE(excluded.shortcode, user_liked_posts.shortcode),
      liked_at = CASE
        WHEN excluded.liked_at IS NOT NULL AND (user_liked_posts.liked_at IS NULL OR excluded.liked_at > user_liked_posts.liked_at)
        THEN excluded.liked_at
        ELSE user_liked_posts.liked_at
      END,
      source_label = CASE
        WHEN excluded.source_label IS NOT NULL AND excluded.source_label != ''
        THEN excluded.source_label
        ELSE user_liked_posts.source_label
      END
  `);
  let processed = 0;
  let skippedInvalid = 0;
  const txn = d.transaction((items) => {
    for (const e of items) {
      const postUrl = normalizePostUrl(e.postUrl);
      if (!postUrl) {
        skippedInvalid += 1;
        continue;
      }
      const shortcode = e.shortcode || instagramService.extractShortcode(postUrl);
      stmt.run(
        String(userId),
        postUrl,
        shortcode || null,
        e.likedAt != null && Number.isFinite(e.likedAt) ? Math.floor(e.likedAt) : null,
        (e.sourceLabel && String(e.sourceLabel).slice(0, 200)) || null
      );
      processed += 1;
    }
  });
  /** Turso : petites transactions (évite InvalidParserState / WAL). Défaut 50 — mobile / retry : TURSO_UPSERT_CHUNK=30 si besoin. */
  const chunk = tursoCreds().enabled
    ? Math.min(200, Math.max(15, Number(process.env.TURSO_UPSERT_CHUNK) || 35))
    : entries.length;
  for (let i = 0; i < entries.length; i += chunk) {
    txn(entries.slice(i, i + chunk));
  }
  if (!options.skipScheduleTurso) {
    scheduleTursoPush(d);
  }
  return { processed, skippedInvalid };
}

function addOne(userId, postUrl, sourceLabel = 'manual') {
  const normalized = normalizePostUrl(postUrl);
  if (!normalized) return { ok: false, reason: 'invalid_url' };
  upsertMany(userId, [
    {
      postUrl: normalized,
      shortcode: instagramService.extractShortcode(normalized),
      likedAt: Math.floor(Date.now() / 1000),
      sourceLabel,
    },
  ]);
  return { ok: true, postUrl: normalized };
}

function removeOne(userId, postUrl) {
  if (!userId || !postUrl) return { ok: false };
  const d = getDb();
  const normalized = normalizePostUrl(postUrl) || postUrl.split('?')[0];
  const info = d
    .prepare('DELETE FROM user_liked_posts WHERE user_id = ? AND post_url = ?')
    .run(String(userId), normalized);
  if (info.changes === 0) {
    const info2 = d
      .prepare('DELETE FROM user_liked_posts WHERE user_id = ? AND post_url LIKE ?')
      .run(String(userId), `${normalized}%`);
    const ok = info2.changes > 0;
    if (ok) scheduleTursoPush(d);
    return { ok };
  }
  scheduleTursoPush(d);
  return { ok: true };
}

/**
 * Hydrate req.session.simulatedLikes depuis la DB (+ migration session héritée).
 */
function hydrateSession(req) {
  if (!req.session || !req.session.user || !req.session.user.id) return;
  const uid = String(req.session.user.id);
  try {
    migrateFromSessionIfEmpty(uid, req.session.simulatedLikes);
    req.session.simulatedLikes = getUrlsForUser(uid);
  } catch (e) {
    console.error('[likesStore] hydrateSession:', e.message || e);
  }
}

module.exports = {
  getDb,
  normalizePostUrl,
  getUrlsForUser,
  countForUser,
  hasPost,
  upsertMany,
  addOne,
  removeOne,
  migrateFromSessionIfEmpty,
  hydrateSession,
  GAME_POOL_LIMIT,
};
