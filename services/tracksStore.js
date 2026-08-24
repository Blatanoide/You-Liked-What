/**
 * Catalogue de morceaux pour SoundGuess (titres + artistes, preview résolu à la volée).
 */

const fs = require('fs');
const path = require('path');
const likesStore = require('./likesStore');

let schemaReady = false;

function syncCatalogFromSeed(db) {
  const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
  if (!fs.existsSync(seedPath)) return { inserted: 0, updated: 0, seedTotal: 0 };
  let list;
  try {
    list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch {
    return { inserted: 0, updated: 0, seedTotal: 0 };
  }
  if (!Array.isArray(list)) return { inserted: 0, updated: 0, seedTotal: 0 };

  const before = db.prepare('SELECT COUNT(*) AS c FROM catalog_tracks').get()?.c || 0;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO catalog_tracks (title, artist, preview_url) VALUES (?, ?, ?)'
  );
  const upd = db.prepare(
    `UPDATE catalog_tracks SET preview_url = ?
     WHERE title = ? AND artist = ? AND (preview_url IS NULL OR preview_url = '')`
  );
  for (const t of list) {
    if (!t?.title || !t?.artist) continue;
    const title = String(t.title).trim();
    const artist = String(t.artist).trim();
    ins.run(title, artist, t.preview_url || null);
    if (t.preview_url) upd.run(String(t.preview_url), title, artist);
  }
  const after = db.prepare('SELECT COUNT(*) AS c FROM catalog_tracks').get()?.c || 0;
  return { inserted: after - before, updated: 0, seedTotal: list.length, catalogTotal: after };
}

function getDb() {
  const db = likesStore.getDb();
  if (!schemaReady) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        preview_url TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(title, artist)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_tracks_title ON catalog_tracks(title);
    `);
    syncCatalogFromSeed(db);
    schemaReady = true;
  }
  return db;
}

function catalogStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS c FROM catalog_tracks').get()?.c || 0;
  const withPreview =
    db.prepare(
      "SELECT COUNT(*) AS c FROM catalog_tracks WHERE preview_url IS NOT NULL AND preview_url != ''"
    ).get()?.c || 0;
  let seedTotal = 0;
  const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
  if (fs.existsSync(seedPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      seedTotal = Array.isArray(list) ? list.length : 0;
    } catch (_) {}
  }
  return { catalogTotal: total, withPreview, seedTotal };
}

function listAll() {
  return getDb()
    .prepare('SELECT id, title, artist, preview_url FROM catalog_tracks ORDER BY id ASC')
    .all();
}

function getById(id) {
  return getDb()
    .prepare('SELECT id, title, artist, preview_url FROM catalog_tracks WHERE id = ?')
    .get(Number(id));
}

function setPreviewUrl(id, url) {
  getDb().prepare('UPDATE catalog_tracks SET preview_url = ? WHERE id = ?').run(url || null, Number(id));
}

function pickRandomTrack(excludeIds = new Set()) {
  const all = listAll().filter((t) => !excludeIds.has(t.id));
  if (!all.length) return null;
  return all[Math.floor(Math.random() * all.length)];
}

module.exports = {
  listAll,
  getById,
  setPreviewUrl,
  pickRandomTrack,
  catalogStats,
};
