/**
 * Utilitaires Instagram (posts / embed) — plus d’OAuth ici (auth = scrape profil public).
 */

const axios = require('axios');

/**
 * Extrait un shortcode Instagram depuis une URL de post/reel.
 */
function extractShortcode(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const reel = trimmed.match(/instagram\.com\/(?:reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (reel) return reel[1];
  const post = trimmed.match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/i);
  if (post) return post[1];
  const tv = trimmed.match(/instagram\.com\/tv\/([A-Za-z0-9_-]+)/i);
  if (tv) return tv[1];
  return null;
}

function getEmbedUrlFromPostUrl(url) {
  const code = extractShortcode(url);
  if (!code) return null;
  const s = String(url || '');
  const isReel = /instagram\.com\/(?:reel|reels)\//i.test(s);
  /** muted + playsinline : requis par la plupart des navigateurs pour tenter l’autoplay dans un iframe tiers. */
  const q = 'autoplay=1&muted=1&playsinline=1';
  if (isReel) {
    return `https://www.instagram.com/reel/${code}/embed/?${q}`;
  }
  return `https://www.instagram.com/p/${code}/embed/?${q}`;
}

/**
 * oEmbed Meta (optionnel, nécessite parfois une app).
 */
async function tryFetchOembedThumbnail(postUrl) {
  try {
    const appId = (process.env.INSTAGRAM_APP_ID || '').trim();
    const appSecret = (process.env.INSTAGRAM_APP_SECRET || '').trim();
    const token = appId && appSecret ? `${appId}|${appSecret}` : null;
    if (!token) return null;

    const { data } = await axios.get('https://graph.facebook.com/v12.0/instagram_oembed', {
      params: {
        url: postUrl,
        access_token: token,
        omitscript: true,
      },
      timeout: 5000,
      validateStatus: (s) => s < 500,
    });
    if (data && data.thumbnail_url) return data.thumbnail_url;
  } catch (e) {
    console.warn('[Instagram] oEmbed:', e.message);
  }
  return null;
}

/**
 * Heuristique : page embed Instagram (vidéo supprimée / indisponible).
 * Ne vérifie pas les URLs non vérifiées si tu limites IMPORT_EMBED_VERIFY_MAX.
 */
async function isPostEmbedLikelyAvailable(postUrl) {
  const embedUrl = getEmbedUrlFromPostUrl(postUrl);
  if (!embedUrl) return false;
  try {
    const { status, data } = await axios.get(embedUrl, {
      timeout: Number(process.env.IMPORT_EMBED_HTTP_MS) || 4500,
      maxRedirects: 4,
      maxContentLength: 150_000,
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (status === 404 || status === 410) return false;
    const html = typeof data === 'string' ? data : '';
    if (
      /sorry, this page isn.?t available|content isn.?t available|video unavailable|no longer available|page introuvable|n.+est pas disponible/i.test(
        html
      )
    ) {
      return false;
    }
    return status >= 200 && status < 400;
  } catch {
    return true;
  }
}

function canonicalPostUrlForDedupe(url) {
  const code = extractShortcode(String(url || ''));
  if (!code) return null;
  const s = String(url || '');
  if (/instagram\.com\/(?:reel|reels)\//i.test(s)) return `https://www.instagram.com/reel/${code}/`;
  if (/instagram\.com\/tv\//i.test(s)) return `https://www.instagram.com/tv/${code}/`;
  return `https://www.instagram.com/p/${code}/`;
}

/**
 * Vérifie jusqu’à `maxChecks` URLs canoniques distinctes ; retire toutes les entrées dont l’URL est « morte ».
 * @param {{ postUrl: string }[]} entries
 */
async function filterEntriesByReachable(entries, maxChecks) {
  if (!maxChecks || maxChecks < 1 || !Array.isArray(entries) || entries.length === 0) return entries;
  const byCanon = new Map();
  for (const e of entries) {
    const c = canonicalPostUrlForDedupe(e.postUrl);
    if (!c) continue;
    if (!byCanon.has(c)) byCanon.set(c, []);
    byCanon.get(c).push(e);
  }
  const uniq = [...byCanon.keys()];
  const toCheck = uniq.slice(0, maxChecks);
  const dead = new Set();
  const CONC = Math.min(20, Math.max(4, Number(process.env.IMPORT_EMBED_CONCURRENCY) || 12));
  for (let i = 0; i < toCheck.length; i += CONC) {
    const slice = toCheck.slice(i, i + CONC);
    const results = await Promise.all(
      slice.map(async (c) => ({ c, ok: await isPostEmbedLikelyAvailable(c) }))
    );
    for (const { c, ok } of results) {
      if (!ok) dead.add(c);
    }
  }
  if (dead.size === 0) return entries;
  return entries.filter((e) => !dead.has(canonicalPostUrlForDedupe(e.postUrl)));
}

module.exports = {
  extractShortcode,
  getEmbedUrlFromPostUrl,
  tryFetchOembedThumbnail,
  isPostEmbedLikelyAvailable,
  filterEntriesByReachable,
};

