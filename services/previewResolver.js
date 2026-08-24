/**
 * Résolution et validation des extraits audio (iTunes en priorité — URLs stables).
 */

const axios = require('axios');

const previewCache = new Map();

function clearPreviewCache() {
  previewCache.clear();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function normalize(text) {
  return stripAccents(String(text || '').toLowerCase())
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreItunesMatch(result, artist, title) {
  let score = 0;
  const normTitle = normalize(title);
  const normArtist = normalize(artist);
  const trackName = normalize(result.trackName);
  const artistName = normalize(result.artistName || '');
  const artistToken = normArtist.split(' ').filter(Boolean)[0] || '';

  if (trackName === normTitle) score += 12;
  else if (trackName.includes(normTitle) || normTitle.includes(trackName)) score += 6;

  if (artistName === normArtist) score += 10;
  else if (artistToken && artistName.includes(artistToken)) score += 5;

  return score;
}

function pickItunesPreview(results, artist, title) {
  const withPreview = (Array.isArray(results) ? results : []).filter((r) => r.previewUrl);
  if (!withPreview.length) return null;
  withPreview.sort(
    (a, b) => scoreItunesMatch(b, artist, title) - scoreItunesMatch(a, artist, title)
  );
  return withPreview[0].previewUrl;
}

async function searchItunesPreview(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, status } = await axios.get(
      `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=12&country=FR`,
      HTTP_OPTS
    );
    if (status === 429) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    const url = pickItunesPreview(data?.results, artist, title);
    if (url) return url;
    break;
  }
  return null;
}

async function searchDeezerPreview(artist, title) {
  const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
  const { data } = await axios.get(`https://api.deezer.com/search?q=${q}&limit=8`, HTTP_OPTS);
  const results = Array.isArray(data?.data) ? data.data : [];
  const normTitle = normalize(title);
  const normArtist = normalize(artist);
  const artistToken = normArtist.split(' ').filter(Boolean)[0] || '';
  const pick =
    results.find(
      (r) =>
        r.preview &&
        normalize(r.title) === normTitle &&
        normalize(r.artist?.name || '') === normArtist
    ) ||
    results.find(
      (r) =>
        r.preview &&
        normalize(r.title) === normTitle &&
        normalize(r.artist?.name || '').includes(artistToken)
    ) ||
    results.find((r) => r.preview) ||
    null;
  return pick?.preview || null;
}

async function isPreviewUrlValid(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return false;
  try {
    const { status, headers, data } = await axios.get(trimmed, {
      timeout: 8000,
      validateStatus: () => true,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      headers: { Range: 'bytes=0-1023', 'User-Agent': 'SoundGuess/1.0' },
    });
    if (status < 200 || status >= 400) return false;
    const ct = String(headers['content-type'] || '').toLowerCase();
    if (ct.includes('audio')) return true;
    return (data?.byteLength || 0) > 128;
  } catch {
    return false;
  }
}

async function resolvePreviewUrl(artist, title) {
  const key = `${artist}|${title}`.toLowerCase();
  if (previewCache.has(key)) {
    const cached = previewCache.get(key);
    if (cached && (await isPreviewUrlValid(cached))) return cached;
    previewCache.delete(key);
  }

  let url = null;
  try {
    url = await searchItunesPreview(artist, title);
  } catch (_) {}
  if (url && (await isPreviewUrlValid(url))) {
    previewCache.set(key, url);
    return url;
  }

  try {
    url = await searchDeezerPreview(artist, title);
  } catch (_) {}
  if (url && (await isPreviewUrlValid(url))) {
    previewCache.set(key, url);
    return url;
  }

  return null;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

module.exports = {
  isPreviewUrlValid,
  resolvePreviewUrl,
  searchItunesPreview,
  searchDeezerPreview,
  mapPool,
  normalize,
  clearPreviewCache,
};
