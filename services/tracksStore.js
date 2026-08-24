/**
 * Catalogue de morceaux pour SoundGuess (titres + artistes avec extrait audio).
 */

const fs = require('fs');
const path = require('path');
const likesStore = require('./likesStore');

const PREVIEW_WHERE = "preview_url IS NOT NULL AND trim(preview_url) != ''";

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
  let seedWithPreview = 0;
  for (const t of list) {
    if (!t?.title || !t?.artist) continue;
    const preview = t.preview_url ? String(t.preview_url).trim() : '';
    if (!preview) continue;
    seedWithPreview += 1;
    const title = String(t.title).trim();
    const artist = String(t.artist).trim();
    ins.run(title, artist, preview);
    upd.run(preview, title, artist);
  }
  const purged =
    db
      .prepare(
        "DELETE FROM catalog_tracks WHERE preview_url IS NULL OR trim(preview_url) = ''"
      )
      .run().changes || 0;
  const after = db.prepare('SELECT COUNT(*) AS c FROM catalog_tracks').get()?.c || 0;
  return {
    inserted: after - before,
    updated: 0,
    purged,
    seedTotal: seedWithPreview,
    catalogTotal: after,
  };
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
  const total =
    db.prepare(`SELECT COUNT(*) AS c FROM catalog_tracks WHERE ${PREVIEW_WHERE}`).get()?.c || 0;
  let seedTotal = 0;
  const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
  if (fs.existsSync(seedPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      seedTotal = Array.isArray(list)
        ? list.filter((t) => t?.preview_url && String(t.preview_url).trim()).length
        : 0;
    } catch (_) {}
  }
  return { catalogTotal: total, withPreview: total, seedTotal };
}

function listAll() {
  return getDb()
    .prepare(
      `SELECT id, title, artist, preview_url FROM catalog_tracks WHERE ${PREVIEW_WHERE} ORDER BY id ASC`
    )
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
  const all = listAll().filter((t) => !excludeIds.has(t.id) && t.preview_url);
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
