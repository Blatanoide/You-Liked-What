/**
 * Authentification par pseudo Instagram + scrape de la page profil public.
 * Option : DEV_FAKE_AUTH + POST /auth/login-demo pour tests sans réseau.
 */

const crypto = require('crypto');
const instagramService = require('../services/instagramService');
const instagramOAuth = require('../services/instagramOAuthService');
const profileScrape = require('../services/profileScrapeService');
const likesStore = require('../services/likesStore');
const playerStatsStore = require('../services/playerStatsStore');
const { MIN_LIKES } = require('../config/constants');
const { expandProfilePictureUrl } = require('../utils/publicUrl');
const siteUserStore = require('../services/siteUserStore');
const emailService = require('../services/emailService');

function displayUser(req, user) {
  if (!user) return null;
  return {
    ...user,
    profile_picture: expandProfilePictureUrl(req, user.profile_picture),
  };
}

function saveSessionAndReply(req, res, user, extra = {}) {
  likesStore.hydrateSession(req);
  if (!Array.isArray(req.session.simulatedLikes)) {
    req.session.simulatedLikes = [];
  }
  req.session.igAccessToken = null;

  req.session.save((err) => {
    if (err) {
      console.error('[Auth] session.save:', err);
      if (wantsHtmlRedirect(req)) {
        return res.redirect(302, '/?auth_error=session');
      }
      return res.status(500).json({ error: 'Erreur session' });
    }
    if (wantsHtmlRedirect(req)) {
      return res.redirect(302, '/');
    }
    const likes = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];
    return res.json({
      ok: true,
      user: displayUser(req, user),
      simulatedLikes: likes,
      canPlay: likes.length >= MIN_LIKES,
      ...extra,
    });
  });
}

/** Soumission HTML native du formulaire (pas fetch JSON) */
function wantsHtmlRedirect(req) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  return ct.includes('application/x-www-form-urlencoded') && req.accepts('html');
}

/**
 * POST { username } — scrape instagram.com/{username}/ puis session.
 */
async function loginWithScrape(req, res) {
  const normalized = profileScrape.normalizeUsername(req.body?.username);
  if (!normalized) {
    return res.status(400).json({
      error: 'Pseudo invalide (lettres, chiffres, . et _, 1–30 caractères).',
    });
  }

  let profilePicture = null;
  let scrapeOk = false;
  let scrapeWarning = null;

  try {
    const scraped = await profileScrape.scrapePublicProfile(normalized);
    profilePicture = scraped.profile_picture;
    scrapeOk = scraped.scrapeOk;
    if (!scrapeOk) {
      scrapeWarning = 'Profil partiellement lu (pas d’image publique détectée).';
    }
  } catch (err) {
    console.warn('[Auth] Scrape Instagram:', err.code || '', err.message);
    scrapeWarning = err.message || 'Scrape impossible.';
  }

  // Fallback : si l'avatar est absent, on tente un scrape Puppeteer du profil.
  if (!profilePicture) {
    try {
      const { fetchPublicProfileHtml } = require('../services/puppeteerInstagram');
      const html = await fetchPublicProfileHtml(normalized);
      const parsed = profileScrape.parseProfileHtml(html, normalized);
      profilePicture = parsed.profile_picture || null;
    } catch (_) {
      /* avatar optionnel */
    }
  }

  const user = {
    id: profileScrape.stableIdFromUsername(normalized),
    username: normalized,
    profile_picture: profilePicture,
  };

  req.session.user = user;
  console.log('[Auth] Connexion:', user.username, scrapeOk ? '(scrape OK)' : '(repli / partiel)');

  return saveSessionAndReply(req, res, user, {
    scrapeOk,
    scrapeWarning: scrapeWarning || undefined,
  });
}

/**
 * POST { username, password } — vraie connexion via Puppeteer (style V1).
 * Crée la session seulement si la navigation/login Instagram réussit.
 */
async function loginWithPuppeteerCredentials(req, res) {
  if (process.env.ALLOW_INSTAGRAM_PASSWORD_SCRAPE !== 'true') {
    return res.status(403).json({
      error: 'Connexion par mot de passe désactivée. Mets ALLOW_INSTAGRAM_PASSWORD_SCRAPE=true dans .env puis redémarre.',
    });
  }

  const username = profileScrape.normalizeUsername(req.body?.username);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username) {
    return res.status(400).json({ error: 'Pseudo Instagram invalide.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Mot de passe requis.' });
  }

  const { scrapeLikesWithCredentials } = require('../services/puppeteerInstagram');
  console.warn('[Auth] Login Puppeteer demandé pour', username);

  const result = await scrapeLikesWithCredentials({ username, password, collectLikes: false });
  if (!result.success) {
    console.warn('[Auth] Login Puppeteer KO', {
      username,
      stage: result.stage || 'unknown',
      hint: result.hint || null,
      checkpoint: Boolean(result.checkpoint),
      trace: Array.isArray(result.trace) ? result.trace : [],
      error: result.error || 'unknown',
    });
    return res.status(401).json({
      error: result.error || 'Connexion Instagram impossible (identifiants, 2FA ou challenge).',
      stage: result.stage || 'unknown',
      hint: result.hint || null,
      checkpoint: Boolean(result.checkpoint),
      details: Array.isArray(result.trace) ? result.trace : [],
      pageInfo: result.pageInfo || undefined,
    });
  }

  let profilePicture = null;
  try {
    const scraped = await profileScrape.scrapePublicProfile(username);
    profilePicture = scraped.profile_picture || null;
  } catch (_) {
    /* avatar optionnel */
  }

  // Fallback : si l'avatar est absent, on tente un scrape Puppeteer du profil.
  if (!profilePicture) {
    try {
      const { fetchPublicProfileHtml } = require('../services/puppeteerInstagram');
      const html = await fetchPublicProfileHtml(username);
      const parsed = profileScrape.parseProfileHtml(html, username);
      profilePicture = parsed.profile_picture || null;
    } catch (_) {
      /* avatar optionnel */
    }
  }

  const user = {
    id: profileScrape.stableIdFromUsername(username),
    username,
    profile_picture: profilePicture,
  };

  const entries = [];
  for (const href of result.posts || []) {
    const clean = String(href).split('?')[0];
    if (!instagramService.extractShortcode(clean)) continue;
    entries.push({ postUrl: clean, sourceLabel: 'puppeteer_login' });
  }

  req.session.user = user;
  req.session.loginMethod = 'instagram_password_puppeteer';
  req.session.igAccessToken = null;
  if (entries.length > 0) {
    likesStore.upsertMany(user.id, entries);
  }

  return saveSessionAndReply(req, res, user, {
    scrapeOk: true,
    importedLikes: entries.length,
    loginOnly: true,
    canPlay: likesStore.getUrlsForUser(user.id).length >= MIN_LIKES,
    debug: {
      stage: result.stage || 'done',
      details: Array.isArray(result.trace) ? result.trace : [],
    },
  });
}

/**
 * Démarre OAuth Instagram Basic Display (compte réel).
 */
function instagramOAuthStart(req, res) {
  if (!instagramOAuth.isConfigured()) {
    return res.status(503).type('html').send(
      '<!DOCTYPE html><meta charset="utf-8"><p>OAuth désactivé : renseigne <code>INSTAGRAM_APP_ID</code> et <code>INSTAGRAM_APP_SECRET</code> dans <code>.env</code>, puis redémarre le serveur.</p><p><a href="/">Retour</a></p>'
    );
  }
  const state = crypto.randomBytes(24).toString('hex');
  const redirectUri = instagramOAuth.getRedirectUri(req);
  req.session.instagramOAuthState = state;
  req.session.instagramOAuthRedirectUri = redirectUri;

  req.session.save((err) => {
    if (err) {
      console.error('[Auth] OAuth start session:', err);
      return res.status(500).type('html').send('Erreur session');
    }
    const url = instagramOAuth.buildAuthorizeUrl(state, redirectUri);
    res.redirect(302, url);
  });
}

/**
 * Callback OAuth — crée la session avec l’identité vérifiée par Meta.
 */
async function instagramOAuthCallback(req, res) {
  const q = req.query || {};
  if (q.error) {
    const reason = q.error_description || q.error_reason || q.error;
    return res.redirect(302, `/?auth_error=${encodeURIComponent(String(reason))}`);
  }

  const code = q.code;
  const state = q.state;
  if (!code || typeof state !== 'string' || state !== req.session.instagramOAuthState) {
    return res.redirect(
      302,
      '/?auth_error=' + encodeURIComponent('Connexion interrompue ou session expirée — réessaie depuis la page d’accueil.')
    );
  }

  const redirectUri = req.session.instagramOAuthRedirectUri;
  delete req.session.instagramOAuthState;
  delete req.session.instagramOAuthRedirectUri;

  if (!redirectUri) {
    return res.redirect(302, '/?auth_error=' + encodeURIComponent('Session OAuth invalide.'));
  }

  try {
    const exchanged = await instagramOAuth.exchangeCodeForToken(code, redirectUri);
    const longLived = await instagramOAuth.exchangeForLongLivedToken(exchanged.access_token);
    const token = longLived.access_token;
    const igUser = await instagramOAuth.fetchInstagramUser(token);

    const user = {
      id: `ig_oauth_${igUser.id}`,
      username: igUser.username,
      profile_picture: null,
      accountType: igUser.account_type || undefined,
    };

    try {
      const scraped = await profileScrape.scrapePublicProfile(igUser.username);
      if (scraped.profile_picture) user.profile_picture = scraped.profile_picture;
    } catch (_) {
      /* avatar optionnel */
    }

    // Fallback : si l'avatar est absent, on tente un scrape Puppeteer du profil.
    if (!user.profile_picture) {
      try {
        const { fetchPublicProfileHtml } = require('../services/puppeteerInstagram');
        const normalized = profileScrape.normalizeUsername(igUser.username) || igUser.username;
        const html = await fetchPublicProfileHtml(normalized);
        const parsed = profileScrape.parseProfileHtml(html, normalized);
        user.profile_picture = parsed.profile_picture || null;
      } catch (_) {
        /* avatar optionnel */
      }
    }

    req.session.user = user;
    req.session.igAccessToken = token;
    req.session.loginMethod = 'instagram_oauth';
    likesStore.hydrateSession(req);

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[Auth] OAuth callback save:', saveErr);
        return res.redirect(302, '/?auth_error=' + encodeURIComponent('Erreur en enregistrant la session.'));
      }
      console.log('[Auth] Instagram OAuth OK @' + user.username);
      res.redirect(302, '/');
    });
  } catch (e) {
    console.error('[Auth] Instagram OAuth callback:', e.message || e);
    const msg = e.message || 'Échec de la connexion Instagram.';
    res.redirect(302, '/?auth_error=' + encodeURIComponent(msg));
  }
}

/**
 * Connexion factice (développement).
 */
function loginDemo(req, res) {
  if (process.env.DEV_FAKE_AUTH !== 'true') {
    return res.status(403).json({ error: 'DEV_FAKE_AUTH désactivé.' });
  }
  const suffix = crypto.randomBytes(3).toString('hex');
  const user = {
    id: `dev_${crypto.randomBytes(8).toString('hex')}`,
    username: `dev_${suffix}`,
    profile_picture: null,
  };
  req.session.user = user;
  console.warn('[Auth] Connexion démo —', user.username);
  return saveSessionAndReply(req, res, user, { scrapeOk: false, demo: true });
}

function logout(req, res) {
  const name = req.session.user?.username;
  req.session.destroy((err) => {
    if (err) console.error('[Auth] logout:', err);
    else console.log('[Auth] Déconnexion:', name || 'inconnu');
    res.redirect('/');
  });
}

/**
 * Même contenu que GET /auth/me — réutilisé dans GET /api/health (une seule requête fiable derrière ngrok).
 */
function sessionPayload(req) {
  if (!req.session || !req.session.user) {
    return { authenticated: false };
  }
  const likes = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];
  return {
    authenticated: true,
    user: displayUser(req, req.session.user),
    simulatedLikes: likes,
    minLikesRequired: MIN_LIKES,
    canPlay: likes.length >= MIN_LIKES,
  };
}

function me(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  return res.status(200).json(sessionPayload(req));
}

function myProfile(req, res) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ error: 'Non connecté' });
  }
  playerStatsStore.upsertIdentity(req.session.user);
  const summary = playerStatsStore.getProfileSummary(req.session.user.id);
  const ex = (u) => expandProfilePictureUrl(req, u);
  const profile = {
    ...summary,
    profile_picture: ex(summary.profile_picture),
    podium: (summary.podium || []).map((p) => ({
      ...p,
      profile_picture: ex(p.profile_picture),
    })),
  };
  return res.json({ ok: true, profile });
}

function updateMyBio(req, res) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ error: 'Non connecté' });
  }
  const bio = typeof req.body?.bio === 'string' ? req.body.bio : '';
  const saved = playerStatsStore.setBio(req.session.user.id, bio);
  playerStatsStore.upsertIdentity(req.session.user);
  return res.json({
    ok: true,
    bio: saved,
    profile: playerStatsStore.getProfileSummary(req.session.user.id),
  });
}

function addSimulatedLike(req, res) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non connecté' });
  }

  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) {
    return res.status(400).json({ error: 'URL requise' });
  }

  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL invalide (http/https)' });
  }

  const shortcode = instagramService.extractShortcode(url);
  if (!shortcode) {
    return res.status(400).json({
      error: 'URL Instagram non reconnue (post /p/… ou reel /reel/…)',
    });
  }

  const normalized = url.split('?')[0];
  const uid = req.session.user.id;
  if (likesStore.hasPost(uid, normalized)) {
    return res.status(409).json({ error: 'Ce post est déjà dans ta liste' });
  }

  likesStore.addOne(uid, normalized, 'manual');
  likesStore.hydrateSession(req);
  const list = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];

  req.session.save((err) => {
    if (err) {
      console.error('[Auth] addSimulatedLike:', err);
      return res.status(500).json({ error: 'Erreur session' });
    }
    console.log('[Auth] Like simulé +', req.session.user.username);
    return res.json({
      simulatedLikes: list,
      canPlay: list.length >= MIN_LIKES,
    });
  });
}

function removeSimulatedLike(req, res) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non connecté' });
  }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  likesStore.removeOne(req.session.user.id, url);
  likesStore.hydrateSession(req);
  const next = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];

  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Erreur session' });
    return res.json({
      simulatedLikes: next,
      canPlay: next.length >= MIN_LIKES,
    });
  });
}

/**
 * Import des URLs de posts via Puppeteer + identifiants (comme la V1 /scrape-likes).
 * Désactivé sauf si ALLOW_INSTAGRAM_PASSWORD_SCRAPE=true — risque sécurité / CGU Instagram.
 */
async function scrapeLikesPuppeteer(req, res) {
  if (process.env.ALLOW_INSTAGRAM_PASSWORD_SCRAPE !== 'true') {
    return res.status(403).json({
      error: 'Désactivé. Mets ALLOW_INSTAGRAM_PASSWORD_SCRAPE=true dans .env (à tes risques).',
    });
  }
  if (!req.session.user) {
    return res.status(401).json({ error: 'Connecte-toi d’abord avec le même pseudo Instagram.' });
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const usernameBody = profileScrape.normalizeUsername(req.body?.username);
  const sessionName = (req.session.user.username || '').toLowerCase();

  if (!password) {
    return res.status(400).json({ error: 'Mot de passe requis.' });
  }
  if (!usernameBody || usernameBody !== sessionName) {
    return res.status(400).json({
      error: 'Le pseudo envoyé doit être exactement celui de ta session.',
    });
  }

  const { scrapeLikesWithCredentials } = require('../services/puppeteerInstagram');
  console.warn('[Auth] Scrape likes Puppeteer demandé pour', usernameBody);

  try {
    const result = await scrapeLikesWithCredentials({
      username: usernameBody,
      password,
      collectLikes: true,
    });

    if (!result.success) {
      return res.status(502).json({
        error: result.error || 'Échec du scrape (UI Instagram ou identifiants).',
      });
    }

    const entries = [];
    for (const href of result.posts || []) {
      const clean = String(href).split('?')[0];
      if (!instagramService.extractShortcode(clean)) continue;
      entries.push({ postUrl: clean, sourceLabel: 'puppeteer_scrape' });
    }
    if (entries.length > 0) {
      likesStore.upsertMany(req.session.user.id, entries);
    }
    likesStore.hydrateSession(req);
    const list = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];

    req.session.save((err) => {
      if (err) {
        console.error('[Auth] scrapeLikesPuppeteer save:', err);
        return res.status(500).json({ error: 'Erreur session' });
      }
      return res.json({
        ok: true,
        rawFound: (result.posts || []).length,
        simulatedLikes: list,
        canPlay: list.length >= MIN_LIKES,
      });
    });
  } catch (e) {
    console.error('[Auth] scrapeLikesPuppeteer:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}

/**
 * POST { username, email, password } — inscription compte site + e-mail de vérification.
 */
async function registerSite(req, res) {
  const username = siteUserStore.normalizeSiteUsername(req.body?.username);
  const email = siteUserStore.normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const pwErr = siteUserStore.validatePassword(password);
  if (!username) {
    return res.status(400).json({
      error: 'Pseudo invalide (3–30 caractères : lettres minuscules, chiffres, . et _).',
    });
  }
  if (!email) {
    return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  }
  if (pwErr) {
    return res.status(400).json({ error: pwErr });
  }
  let pending;
  try {
    pending = await siteUserStore.createPendingUser({
      username,
      email,
      password: String(password),
    });
  } catch (e) {
    if (e.message === 'USERNAME_TAKEN') {
      return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
    }
    if (e.message === 'EMAIL_TAKEN') {
      const existing = siteUserStore.findByEmail(email);
      if (existing && !existing.verified) {
        return res.status(409).json({
          error: 'Cet e-mail est déjà inscrit mais pas encore vérifié.',
          pendingVerification: true,
          email,
        });
      }
      return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
    }
    console.error('[Auth] registerSite:', e);
    return res.status(500).json({ error: 'Erreur serveur lors de l’inscription.' });
  }

  let emailResult;
  let mailThrew = false;
  try {
    emailResult = await emailService.sendVerificationEmail(email, pending.code);
  } catch (mailErr) {
    console.error('[Auth] sendVerificationEmail:', mailErr.message || mailErr);
    mailThrew = true;
    emailResult = { sent: false };
  }

  const body = {
    ok: true,
    email,
    emailSent: Boolean(emailResult.sent),
    message: emailResult.sent
      ? 'Compte créé. Ouvre ton e-mail : le texte contient ton code de vérification entre crochets [123456].'
      : mailThrew
        ? 'Compte créé, mais l’e-mail n’a pas pu être envoyé (SMTP / Gmail à vérifier sur le serveur). Utilise « Renvoyer le code » une fois corrigé, ou le code affiché dans les logs Render.'
        : 'Compte créé. Le serveur n’a pas encore d’SMTP : le code est dans les logs serveur (ligne [Email]). Configure SMTP_USER et SMTP_PASS pour l’envoi réel.',
  };
  if (!emailResult.sent && process.env.EMAIL_DEV_RETURN_CODE === 'true') {
    body.devCode = pending.code;
  }
  return res.status(201).json(body);
}

/**
 * POST { email } — nouveau code pour compte non vérifié.
 */
async function resendVerification(req, res) {
  const email = siteUserStore.normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: 'E-mail requis.' });
  }
  const regen = siteUserStore.regenerateVerificationForEmail(email);
  if (!regen.ok) {
    return res.status(400).json({ error: regen.error });
  }
  try {
    const send = await emailService.sendVerificationEmail(email, regen.code);
    if (!send.sent) {
      return res.status(503).json({
        error:
          'Code régénéré mais envoi impossible (SMTP non configuré). Regarde les logs serveur pour le nouveau code ou configure SMTP.',
        devCode: process.env.EMAIL_DEV_RETURN_CODE === 'true' ? regen.code : undefined,
      });
    }
    return res.json({ ok: true, message: 'Un nouveau code a été envoyé à ton adresse.' });
  } catch (e) {
    console.error('[Auth] resendVerification send:', e.message || e);
    return res.status(502).json({ error: 'Envoi de l’e-mail impossible pour le moment.' });
  }
}

/**
 * POST { email, code } — valide l’e-mail puis ouvre la session.
 */
async function verifySiteEmail(req, res) {
  const result = siteUserStore.verifyEmailCode(req.body?.email, req.body?.code);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  const row = result.user;
  const user = siteUserStore.sessionUserFromRow(row);
  req.session.igAccessToken = null;
  req.session.user = user;
  req.session.loginMethod = 'site';
  likesStore.hydrateSession(req);
  if (!Array.isArray(req.session.simulatedLikes)) {
    req.session.simulatedLikes = [];
  }
  console.log('[Auth] Compte site vérifié:', user.username);
  return saveSessionAndReply(req, res, user, { siteRegistration: true });
}

/**
 * POST { emailOrUsername, password } ou { login, password }
 */
async function loginSite(req, res) {
  const login = req.body?.emailOrUsername ?? req.body?.login ?? req.body?.email;
  const password = req.body?.password;
  if (!login || !password) {
    return res.status(400).json({ error: 'E-mail (ou pseudo) et mot de passe requis.' });
  }
  const row = await siteUserStore.checkLogin(String(login).trim(), password);
  if (row && row.error) {
    return res.status(403).json({
      error: row.error,
      needsVerification: Boolean(row.needsVerification),
      email: row.email || undefined,
    });
  }
  if (!row) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  const user = siteUserStore.sessionUserFromRow(row);
  req.session.igAccessToken = null;
  req.session.user = user;
  req.session.loginMethod = 'site';
  likesStore.hydrateSession(req);
  if (!Array.isArray(req.session.simulatedLikes)) {
    req.session.simulatedLikes = [];
  }
  console.log('[Auth] Connexion site:', user.username);
  return saveSessionAndReply(req, res, user);
}

/**
 * POST multipart field « photo » — avatar (comptes site uniquement).
 */
function uploadProfileAvatar(req, res) {
  if (!req.session?.user?.id || !String(req.session.user.id).startsWith('site_')) {
    return res.status(403).json({ error: 'Réservé aux comptes créés sur le site.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Envoie une image (JPEG, PNG, WebP ou GIF).' });
  }
  const rel = `/uploads/profiles/${req.file.filename}`;
  siteUserStore.updateProfilePicturePath(req.session.user.id, rel);
  req.session.user.profile_picture = rel;
  playerStatsStore.upsertIdentity(req.session.user);
  likesStore.hydrateSession(req);
  req.session.save((err) => {
    if (err) {
      console.error('[Auth] uploadProfileAvatar session:', err);
      return res.status(500).json({ error: 'Erreur session' });
    }
    return res.json({ ok: true, user: displayUser(req, req.session.user) });
  });
}

function seedFakeLikes(req, res) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non connecté' });
  }

  const demos = [
    'https://www.instagram.com/p/CUbHfhpswxt/',
    'https://www.instagram.com/p/BZhWnzHn7fq/',
    'https://www.instagram.com/p/BXr9CKYj7kz/',
  ];
  const unique = [...new Set(demos.map((u) => u.split('?')[0]))];
  const entries = unique.map((u) => ({ postUrl: u, sourceLabel: 'seed_demo' }));
  likesStore.upsertMany(req.session.user.id, entries);
  likesStore.hydrateSession(req);
  const list = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];

  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Erreur session' });
    return res.json({
      simulatedLikes: list,
      canPlay: list.length >= MIN_LIKES,
    });
  });
}

module.exports = {
  loginWithScrape,
  loginWithPuppeteerCredentials,
  instagramOAuthStart,
  instagramOAuthCallback,
  loginDemo,
  logout,
  me,
  myProfile,
  updateMyBio,
  sessionPayload,
  addSimulatedLike,
  removeSimulatedLike,
  scrapeLikesPuppeteer,
  seedFakeLikes,
  registerSite,
  verifySiteEmail,
  resendVerification,
  loginSite,
  uploadProfileAvatar,
  MIN_LIKES,
};
