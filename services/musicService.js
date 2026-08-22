/**
 * Blind test SoundGuess — normalisation des titres, correspondance, previews iTunes.
 */

const axios = require('axios');

const previewCache = new Map();

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeGuess(text) {
  return stripAccents(String(text || '').toLowerCase())
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAcceptableAnswers(track) {
  const title = normalizeGuess(track.title);
  const artist = normalizeGuess(track.artist);
  const full = normalizeGuess(`${track.artist} ${track.title}`);
  const fullRev = normalizeGuess(`${track.title} ${track.artist}`);
  const set = new Set([title, full, fullRev]);
  if (artist && title) set.add(`${artist} ${title}`);
  return set;
}

function isGuessCorrect(guessText, track) {
  if (!track || !guessText) return false;
  const g = normalizeGuess(guessText);
  if (!g) return false;
  const acceptable = buildAcceptableAnswers(track);
  if (acceptable.has(g)) return true;
  const titleOnly = normalizeGuess(track.title);
  if (titleOnly && g === titleOnly) return true;
  if (titleOnly && g.includes(titleOnly) && titleOnly.length >= 4) return true;
  return false;
}

async function resolvePreviewUrl(artist, title) {
  const key = `${artist}|${title}`.toLowerCase();
  if (previewCache.has(key)) return previewCache.get(key);

  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const { data } = await axios.get(
      `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`,
      { timeout: Number(process.env.ITUNES_SEARCH_MS) || 6000, validateStatus: () => true }
    );
    const results = Array.isArray(data?.results) ? data.results : [];
    const normTitle = normalizeGuess(title);
    let pick =
      results.find((r) => r.previewUrl && normalizeGuess(r.trackName) === normTitle) ||
      results.find((r) => r.previewUrl) ||
      null;
    const url = pick?.previewUrl || null;
    previewCache.set(key, url);
    return url;
  } catch {
    previewCache.set(key, null);
    return null;
  }
}

function suggestFromCatalog(tracks, query, limit = 8) {
  const q = normalizeGuess(query);
  if (!q || q.length < 2) return [];
  const scored = [];
  for (const t of tracks) {
    const label = `${t.artist} — ${t.title}`;
    const hay = normalizeGuess(label);
    if (!hay.includes(q) && !normalizeGuess(t.title).startsWith(q)) continue;
    let score = 0;
    if (normalizeGuess(t.title).startsWith(q)) score += 3;
    if (hay.includes(q)) score += 1;
    scored.push({ label, title: t.title, artist: t.artist, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ label, title, artist }) => ({ label, title, artist }));
}

module.exports = {
  normalizeGuess,
  isGuessCorrect,
  resolvePreviewUrl,
  suggestFromCatalog,
};
