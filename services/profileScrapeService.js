/**
 * Profil Instagram public : axios + Cheerio, puis repli Puppeteer (V1) si mur de login.
 * USE_PUPPETEER_PROFILE=true pour activer le repli (plus lent, nécessite puppeteer installé).
 */

const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const RESERVED = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'accounts',
  'direct',
  'tv',
  'legal',
  'about',
]);

function normalizeUsername(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) return null;
  if (RESERVED.has(u)) return null;
  return u;
}

function stableIdFromUsername(username) {
  const h = crypto.createHash('sha256').update(`ig|${username}`).digest('hex');
  return `igscrape_${h.slice(0, 24)}`;
}

function parseProfileHtml(html, username) {
  const $ = cheerio.load(html);

  // Instagram expose souvent l'URL de photo de profil dans un JSON inline
  // (ex: "profile_pic_url_hd" / "profile_pic_url"). On privilégie ces champs
  // pour coller au rendu Instagram (résolution et variante).
  let profilePicture = null;

  let displayName =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="og:title"]').attr('content') ||
    null;

  if (displayName && displayName.includes('•')) {
    displayName = displayName.split('•')[0].trim();
  }
  if (displayName && displayName.includes('(')) {
    displayName = displayName.replace(/\s*\(@[^)]+\)\s*$/, '').trim();
  }

  const jsonLd = $('script[type="application/ld+json"]').first().html();
  if (jsonLd) {
    try {
      const data = JSON.parse(jsonLd);
      if (data.image && !profilePicture) profilePicture = typeof data.image === 'string' ? data.image : data.image?.url;
    } catch (_) {
      /* ignore */
    }
  }

  const hdMatch = html.match(/"profile_pic_url_hd"\s*:\s*"([^"]+)"/);
  if (hdMatch) profilePicture = hdMatch[1].replace(/\\u0026/g, '&');

  if (!profilePicture) {
    const picMatch = html.match(/"profile_pic_url"\s*:\s*"([^"]+)"/);
    if (picMatch) profilePicture = picMatch[1].replace(/\\u0026/g, '&');
  }

  // Fallback si Instagram n'injecte pas ces champs.
  if (!profilePicture) {
    profilePicture =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="og:image"]').attr('content') ||
      null;
  }

  const hasMetaTitle = Boolean($('meta[property="og:title"]').attr('content'));

  return {
    username,
    profile_picture: profilePicture || null,
    display_name: displayName || username,
    hasMetaTitle,
  };
}

function looksLikeLoginWall(html) {
  const lower = html.slice(0, 8000).toLowerCase();
  return (
    lower.includes('log in to instagram') ||
    lower.includes('connexion à instagram') ||
    (lower.includes('name="password"') && lower.includes('instagram'))
  );
}

function toPublicResult(parsed) {
  return {
    username: parsed.username,
    profile_picture: parsed.profile_picture,
    display_name: parsed.display_name,
    scrapeOk: Boolean(parsed.profile_picture || parsed.hasMetaTitle),
  };
}

/**
 * Tentative rapide HTTP (comme avant).
 */
async function scrapePublicProfileAxios(username) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;

  const { data: html, status } = await axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept: 'text/html,application/xhtml+xml',
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
  });

  if (status === 404) {
    const err = new Error('Profil introuvable ou pseudo invalide.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (typeof html !== 'string' || html.length < 500) {
    const err = new Error('Réponse Instagram trop courte ou vide.');
    err.code = 'EMPTY';
    throw err;
  }

  if (looksLikeLoginWall(html)) {
    const err = new Error(
      'Instagram demande une connexion (mur de login). Essaie Puppeteer (USE_PUPPETEER_PROFILE=true), ngrok HTTPS, ou réessaie plus tard.'
    );
    err.code = 'LOGIN_WALL';
    throw err;
  }

  return toPublicResult(parseProfileHtml(html, username));
}

/**
 * Profil public : axios d’abord, puis Puppeteer si activé et mur de login / réponse vide.
 */
async function scrapePublicProfile(username) {
  try {
    return await scrapePublicProfileAxios(username);
  } catch (err) {
    const puppeteerOk =
      process.env.USE_PUPPETEER_PROFILE === 'true' &&
      (err.code === 'LOGIN_WALL' || err.code === 'EMPTY');

    if (!puppeteerOk) throw err;

    console.log('[Profile] Repli Puppeteer (style V1) pour @' + username);
    try {
      const { fetchPublicProfileHtml } = require('./puppeteerInstagram');
      const html = await fetchPublicProfileHtml(username);

      if (typeof html !== 'string' || html.length < 500) {
        throw err;
      }
      if (looksLikeLoginWall(html)) {
        throw err;
      }

      return toPublicResult(parseProfileHtml(html, username));
    } catch (e2) {
      console.warn('[Profile] Puppeteer:', e2.message);
      throw err;
    }
  }
}

module.exports = {
  normalizeUsername,
  stableIdFromUsername,
  scrapePublicProfile,
  parseProfileHtml,
};
