/**
 * OAuth Instagram Basic Display (Meta) — autorise un vrai compte Instagram.
 * Console : https://developers.facebook.com — app → produit « Instagram Basic Display ».
 * Redirect URI valide : même chaîne que getRedirectUri() (souvent PUBLIC_BASE_URL + ce chemin).
 */

const axios = require('axios');

const AUTH_URL = 'https://api.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const LONG_LIVED_URL = 'https://graph.instagram.com/access_token';
const ME_URL = 'https://graph.instagram.com/me';

function clientId() {
  return (process.env.INSTAGRAM_APP_ID || '').trim();
}

function clientSecret() {
  return (process.env.INSTAGRAM_APP_SECRET || '').trim();
}

function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

function getPublicBase() {
  return (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
}

/**
 * URL de callback enregistrée dans Meta (doit matcher exactement).
 * Surcharge possible avec INSTAGRAM_OAUTH_REDIRECT_URI (URL complète).
 */
function getRedirectUri(req) {
  const override = (process.env.INSTAGRAM_OAUTH_REDIRECT_URI || '').trim();
  if (override) return override;

  const publicBase = getPublicBase();
  if (publicBase) {
    return `${publicBase}/auth/instagram/callback`;
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host') || `127.0.0.1:${process.env.PORT || 3000}`;
  return `${proto}://${host}/auth/instagram/callback`;
}

function buildAuthorizeUrl(state, redirectUri) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'user_profile,user_media');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

function normalizeCode(code) {
  if (!code || typeof code !== 'string') return '';
  return code.split('#')[0].trim();
}

async function exchangeCodeForToken(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code: normalizeCode(code),
  });

  const { data, status } = await axios.post(TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
    validateStatus: () => true,
  });

  if (status >= 400) {
    const msg =
      (data && (data.error_message || data.error?.message || (typeof data.error === 'string' ? data.error : null))) ||
      `Échange token HTTP ${status}`;
    const err = new Error(String(msg));
    err.code = 'TOKEN_EXCHANGE';
    throw err;
  }

  let access_token = data.access_token;
  let user_id = data.user_id;
  if (!access_token && Array.isArray(data.data) && data.data[0]) {
    access_token = data.data[0].access_token;
    user_id = data.data[0].user_id;
  }
  if (!access_token) {
    const err = new Error('Réponse Instagram sans access_token.');
    err.code = 'TOKEN_EXCHANGE';
    throw err;
  }
  return { access_token, user_id };
}

async function exchangeForLongLivedToken(shortLivedToken) {
  try {
    const { data, status } = await axios.get(LONG_LIVED_URL, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: clientSecret(),
        access_token: shortLivedToken,
      },
      timeout: 20000,
      validateStatus: (s) => s < 500,
    });
    if (status === 200 && data && data.access_token) {
      return { access_token: data.access_token, expires_in: data.expires_in };
    }
  } catch (e) {
    console.warn('[Instagram OAuth] jeton longue durée:', e.message);
  }
  return { access_token: shortLivedToken };
}

async function fetchInstagramUser(accessToken) {
  const { data, status } = await axios.get(ME_URL, {
    params: {
      fields: 'id,username,account_type',
      access_token: accessToken,
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (status >= 400 || (data && data.error)) {
    const msg = data?.error?.message || data?.error_message || `Profil HTTP ${status}`;
    throw new Error(String(msg));
  }
  if (!data || !data.id || !data.username) {
    throw new Error('Réponse /me incomplète.');
  }
  return {
    id: String(data.id),
    username: String(data.username).toLowerCase(),
    account_type: data.account_type || null,
  };
}

module.exports = {
  isConfigured,
  getRedirectUri,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchInstagramUser,
};
