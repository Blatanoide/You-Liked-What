/**
 * Blind test SoundGuess — normalisation des titres, correspondance, previews iTunes.
 */

const axios = require('axios');

const previewCache = new Map();

const HTTP_OPTS = {
  timeout: Number(process.env.MUSIC_SEARCH_MS) || 8000,
  validateStatus: () => true,
  headers: {
    'User-Agent': 'SoundGuess/1.0 (preview resolver)',
    Accept: 'application/json',
  },
};

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

async function searchItunesPreview(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`);
  const { data } = await axios.get(
    `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=8`,
    HTTP_OPTS
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  const normTitle = normalizeGuess(title);
  const pick =
    results.find((r) => r.previewUrl && normalizeGuess(r.trackName) === normTitle) ||
    results.find((r) => r.previewUrl) ||
    null;
  return pick?.previewUrl || null;
}

async function searchDeezerPreview(artist, title) {
  const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
  const { data } = await axios.get(`https://api.deezer.com/search?q=${q}&limit=8`, HTTP_OPTS);
  const results = Array.isArray(data?.data) ? data.data : [];
  const normTitle = normalizeGuess(title);
  const normArtist = normalizeGuess(artist);
  const pick =
    results.find(
      (r) =>
        r.preview &&
        normalizeGuess(r.title) === normTitle &&
        normalizeGuess(r.artist?.name || '') === normArtist
    ) ||
    results.find(
      (r) =>
        r.preview &&
        normalizeGuess(r.title) === normTitle &&
        normalizeGuess(r.artist?.name || '').includes(normArtist)
    ) ||
    results.find((r) => r.preview) ||
    null;
  return pick?.preview || null;
}

async function resolvePreviewUrl(artist, title) {
  const key = `${artist}|${title}`.toLowerCase();
  if (previewCache.has(key)) return previewCache.get(key);

  let url = null;
  try {
    url = await searchItunesPreview(artist, title);
  } catch (_) {}
  if (!url) {
    try {
      url = await searchDeezerPreview(artist, title);
    } catch (_) {}
  }
  if (!url) {
    try {
      url = await searchDeezerPreview(artist, title.split('(')[0].trim());
    } catch (_) {}
  }

  previewCache.set(key, url);
  return url;
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
