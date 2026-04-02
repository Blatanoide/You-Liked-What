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
  if (isReel) {
    return `https://www.instagram.com/reel/${code}/embed/?autoplay=1`;
  }
  return `https://www.instagram.com/p/${code}/embed/?autoplay=1`;
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

module.exports = {
  extractShortcode,
  getEmbedUrlFromPostUrl,
  tryFetchOembedThumbnail,
};
