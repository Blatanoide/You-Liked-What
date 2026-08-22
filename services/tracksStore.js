/**
 * Catalogue de morceaux pour SoundGuess (titres + artistes, preview résolu à la volée).
 */

const fs = require('fs');
const path = require('path');
const likesStore = require('./likesStore');

let schemaReady = false;

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
    seedIfEmpty(db);
    syncPreviewUrlsFromSeed(db);
    schemaReady = true;
  }
  return db;
}

function seedIfEmpty(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM catalog_tracks').get();
  if (row && row.c > 0) return;
  const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
  if (!fs.existsSync(seedPath)) return;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch {
    return;
  }
  const ins = db.prepare('INSERT OR IGNORE INTO catalog_tracks (title, artist, preview_url) VALUES (?, ?, ?)');
  for (const t of list) {
    if (!t?.title || !t?.artist) continue;
    ins.run(String(t.title).trim(), String(t.artist).trim(), t.preview_url || null);
  }
}

function syncPreviewUrlsFromSeed(db) {
  const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
  if (!fs.existsSync(seedPath)) return;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch {
    return;
  }
  const upd = db.prepare(
    `UPDATE catalog_tracks SET preview_url = ?
     WHERE title = ? AND artist = ? AND (preview_url IS NULL OR preview_url = '')`
  );
  for (const t of list) {
    if (!t?.title || !t?.artist || !t.preview_url) continue;
    upd.run(String(t.preview_url), String(t.title).trim(), String(t.artist).trim());
  }
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
};
