/**
 * Utilitaires Instagram (posts / embed) — plus d’OAuth ici (auth = scrape profil public).
 */

const axios = require('axios');

const videoUrlCache = new Map();

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

function decodeIgEscapedUrl(raw) {
  const v = String(raw || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function parseMetaVideoFromHtml(html) {
  const picked = pickInstagramDirectVideoUrl(html);
  return picked;
}

/**
 * Meta tags + champs JSON courants dans les pages / embed Instagram (Reels souvent absents des meta seules).
 */
function pickInstagramDirectVideoUrl(html) {
  if (!html || typeof html !== 'string') return null;
  const patterns = [
    /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
    /"video_url"\s*:\s*"(https:[^"\\]+)"/i,
    /"playback_url"\s*:\s*"(https:[^"\\]+)"/i,
    /"progressive_url"\s*:\s*"(https:[^"\\]+)"/i,
    /"url"\s*:\s*"(https:[^"\\]*fbcdn\.net[^"\\]*\.mp4[^"\\]*)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m || !m[1]) continue;
    const u = decodeIgEscapedUrl(m[1]);
    if (u && /^https?:\/\//i.test(u) && /\.(mp4|m4v)(\?|$)/i.test(u)) return u;
  }
  const allMp4 = html.match(/https:\/\/[^"'\\\s<>]+\.mp4[^"'\\\s<>]*/gi) || [];
  const candidates = allMp4.map((raw) => decodeIgEscapedUrl(raw.split(/["'<>]/)[0])).filter(Boolean);
  const prefer = (u) =>
    /^https?:\/\//i.test(u) && (u.includes('fbcdn.net') || u.includes('cdninstagram.com'));
  const scored = candidates.filter(prefer).sort((a, b) => {
    const score = (u) => (/fbcdn\.net\/v\//i.test(u) ? 2 : 0) + (/\/v\/t/i.test(u) ? 1 : 0);
    return score(b) - score(a);
  });
  if (scored[0]) return scored[0];
  const looseNoExt = html.match(/https:\/\/[^"'\\\s<>]*fbcdn\.net\/v\/[^"'\\\s<>]+/i);
  if (looseNoExt && looseNoExt[0]) {
    const u = decodeIgEscapedUrl(looseNoExt[0].split(/["'<>]/)[0]);
    if (prefer(u)) return u;
  }
  return null;
}

/**
 * Essaie d'extraire un flux vidéo direct (mp4) depuis la page publique.
 * Retourne null si indisponible ; le front restera sur l'embed Instagram.
 */
const IG_HTML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function axiosPickVideo(url) {
  if (!url) return null;
  try {
    const { data, status } = await axios.get(url, {
      timeout: Number(process.env.IG_VIDEO_FETCH_MS) || 4500,
      maxRedirects: 5,
      maxContentLength: Number(process.env.IG_VIDEO_HTML_MAX) || 900_000,
      validateStatus: () => true,
      headers: IG_HTML_HEADERS,
    });
    if (status >= 400) return null;
    return pickInstagramDirectVideoUrl(typeof data === 'string' ? data : '');
  } catch {
    return null;
  }
}

async function tryFetchDirectVideoUrl(postUrl) {
  const canon = canonicalPostUrlForDedupe(postUrl);
  if (!canon) return null;
  if (videoUrlCache.has(canon) && videoUrlCache.get(canon)) {
    return videoUrlCache.get(canon);
  }

  let video = await axiosPickVideo(canon);
  if (video) {
    videoUrlCache.set(canon, video);
    return video;
  }

  const embedPageUrl = getEmbedUrlFromPostUrl(postUrl);
  if (embedPageUrl && embedPageUrl !== canon) {
    video = await axiosPickVideo(embedPageUrl);
    if (video) {
      videoUrlCache.set(canon, video);
      return video;
    }
  }

  const usePuppeteerFallback = String(process.env.USE_PUPPETEER_VIDEO || 'true').toLowerCase() !== 'false';
  if (usePuppeteerFallback) {
    try {
      const { fetchDirectVideoUrlFromPost } = require('./puppeteerInstagram');
      const video2 = await fetchDirectVideoUrlFromPost(canon, embedPageUrl);
      if (video2) {
        videoUrlCache.set(canon, video2);
        return video2;
      }
    } catch (_) {
      // ignore
    }
  }
  return null;
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
  tryFetchDirectVideoUrl,
  pickInstagramDirectVideoUrl,
  isPostEmbedLikelyAvailable,
  filterEntriesByReachable,
};

