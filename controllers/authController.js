/**
 * Authentification par pseudo Instagram + scrape de la page profil public.
 * Option : DEV_FAKE_AUTH + POST /auth/login-demo pour tests sans réseau.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const instagramService = require('../services/instagramService');
const instagramOAuth = require('../services/instagramOAuthService');
const profileScrape = require('../services/profileScrapeService');
const likesStore = require('../services/likesStore');
const playerStatsStore = require('../services/playerStatsStore');
const { MIN_LIKES } = require('../config/constants');
const { expandProfilePictureUrl } = require('../utils/publicUrl');
const siteUserStore = require('../services/siteUserStore');
const emailService = require('../services/emailService');
const handoffStore = require('../services/handoffStore');
const handoffProof = require('../services/handoffProof');
const avatarStorage = require('../services/avatarStorage');

function displayUser(req, user) {
  if (!user) return null;
  let pic = user.profile_picture;
  if (avatarStorage.isObsoleteLocalAvatar(pic)) pic = null;
  return {
    ...user,
    profile_picture: expandProfilePictureUrl(req, pic),
  };
}

function saveSessionAndReply(req, res, user, extra = {}) {
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
    const proof = handoffProof.issueProofForHandoff(user, req.session.loginMethod);
    return res.json({
      ok: true,
      user: displayUser(req, user),
      ...extra,
      ...(proof ? { handoffProof: proof } : {}),
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
  const name = req.session?.user?.username;
  const fe = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  const clearOpts = {
    path: '/',
    httpOnly: true,
    secure: Boolean(req.session?.cookie?.secure),
    sameSite: req.session?.cookie?.sameSite || 'lax',
  };

  const finish = () => {
    res.clearCookie('ylw.sid', clearOpts);
    if (req.method === 'POST') {
      return res.status(200).json({ ok: true });
    }
    if (fe) return res.redirect(302, `${fe}/?logged_out=1`);
    return res.redirect(302, '/?logged_out=1');
  };

  if (!req.session) return finish();

  req.session.destroy((err) => {
    if (err) console.error('[Auth] logout:', err);
    else console.log('[Auth] Déconnexion:', name || 'inconnu');
    finish();
  });
}

/**
 * Même contenu que GET /auth/me — réutilisé dans GET /api/health (une seule requête fiable derrière ngrok).
 */
function sessionPayload(req) {
  if (!req.session || !req.session.user) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    user: displayUser(req, req.session.user),
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
  const ex = (u) => {
    const pic = avatarStorage.isObsoleteLocalAvatar(u) ? null : u;
    return expandProfilePictureUrl(req, pic);
  };
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
function appendDevCode(body, code) {
  if (process.env.EMAIL_DEV_RETURN_CODE === 'true') {
    body.devCode = code;
  }
  return body;
}

function emailOkMessage(sent) {
  return sent
    ? 'Code envoyé à ton e-mail — vérifie aussi les spams / courriers indésirables.'
    : 'Impossible d’envoyer l’e-mail pour le moment. Réessaie ou contacte le support.';
}

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
        const regen = siteUserStore.regenerateVerificationForEmail(email);
        if (!regen.ok) {
          return res.status(409).json({ error: regen.error });
        }
        const emailResult = await emailService.sendVerificationEmail(email, regen.code);
        return res.status(200).json(
          appendDevCode(
            {
              ok: true,
              email,
              emailSent: Boolean(emailResult.sent),
              resent: true,
              message: emailOkMessage(emailResult.sent),
              emailError: emailResult.sent ? undefined : emailResult.smtpMessage || emailResult.skippedReason,
            },
            regen.code
          )
        );
      }
      return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
    }
    console.error('[Auth] registerSite:', e);
    return res.status(500).json({ error: 'Erreur serveur lors de l’inscription.' });
  }

  const emailResult = await emailService.sendVerificationEmail(email, pending.code);
  return res.status(201).json(
    appendDevCode(
      {
        ok: true,
        email,
        emailSent: Boolean(emailResult.sent),
        message: emailOkMessage(emailResult.sent),
        emailError: emailResult.sent ? undefined : emailResult.smtpMessage || emailResult.skippedReason,
      },
      pending.code
    )
  );
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
  const emailResult = await emailService.sendVerificationEmail(email, regen.code);
  if (!emailResult.sent) {
    return res.status(503).json({
      ok: false,
      error: emailOkMessage(false),
      emailError: emailResult.smtpMessage || emailResult.skippedReason,
      devCode: process.env.EMAIL_DEV_RETURN_CODE === 'true' ? regen.code : undefined,
    });
  }
  return res.json({ ok: true, message: emailOkMessage(true) });
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
  req.session.user = user;
  req.session.loginMethod = 'site';
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

  const issued = siteUserStore.issueLogin2faCode(row.id);
  const emailResult = await emailService.sendLogin2faEmail(row.email, issued.code);
  return res.status(200).json(
    appendDevCode(
      {
        ok: true,
        needs2fa: true,
        email: row.email,
        emailSent: Boolean(emailResult.sent),
        message: emailOkMessage(emailResult.sent),
        emailError: emailResult.sent ? undefined : emailResult.smtpMessage || emailResult.skippedReason,
      },
      issued.code
    )
  );
}

/**
 * POST { email, code } — valide le 2FA connexion puis ouvre la session.
 */
async function verifyLogin2fa(req, res) {
  const result = siteUserStore.verifyLogin2faCode(req.body?.email, req.body?.code);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  const user = siteUserStore.sessionUserFromRow(result.user);
  req.session.user = user;
  req.session.loginMethod = 'site';
  console.log('[Auth] Connexion site (2FA):', user.username);
  return saveSessionAndReply(req, res, user);
}

/**
 * POST { email } — renvoie le code 2FA si une connexion est en cours.
 */
async function resendLogin2fa(req, res) {
  const email = siteUserStore.normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: 'E-mail requis.' });
  }
  const regen = siteUserStore.regenerateLogin2faForEmail(email);
  if (!regen.ok) {
    return res.status(400).json({ error: regen.error });
  }
  const emailResult = await emailService.sendLogin2faEmail(email, regen.code);
  if (!emailResult.sent) {
    return res.status(503).json({
      ok: false,
      error: emailOkMessage(false),
      emailError: emailResult.smtpMessage || emailResult.skippedReason,
      devCode: process.env.EMAIL_DEV_RETURN_CODE === 'true' ? regen.code : undefined,
    });
  }
  return res.json({ ok: true, message: emailOkMessage(true) });
}

/**
 * POST multipart field « photo » — avatar (comptes site uniquement).
 */
async function uploadProfileAvatar(req, res) {
  if (!req.session?.user?.id || !String(req.session.user.id).startsWith('site_')) {
    return res.status(403).json({ error: 'Réservé aux comptes créés sur le site.' });
  }
  if (!req.file?.buffer) {
    return res.status(400).json({ error: 'Envoie une image (JPEG, PNG, WebP ou GIF).' });
  }
  try {
    await avatarStorage.deletePreviousAvatar(req.session.user.profile_picture);
    const { url } = await avatarStorage.uploadAvatar(
      req.file.buffer,
      req.session.user.id,
      req.file.mimetype
    );
    siteUserStore.updateProfilePicturePath(req.session.user.id, url);
    req.session.user.profile_picture = url;
    playerStatsStore.upsertIdentity(req.session.user);
    req.session.save((err) => {
      if (err) {
        console.error('[Auth] uploadProfileAvatar session:', err);
        return res.status(500).json({ error: 'Erreur session' });
      }
      return res.json({ ok: true, user: displayUser(req, req.session.user) });
    });
  } catch (e) {
    console.error('[Auth] uploadProfileAvatar:', e.message || e, e.cause?.message || '');
    if (e.message === 'CLOUDINARY_UPLOAD_FAILED' || e.message === 'CLOUDINARY_AUTH_FAILED') {
      return res.status(503).json({
        error:
          e.message === 'CLOUDINARY_AUTH_FAILED'
            ? 'Clés Cloudinary invalides sur le serveur.'
            : 'Stockage photo indisponible (Cloudinary).',
        detail: e.detail || undefined,
        hint:
          'Sur Render, définis CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY et CLOUDINARY_API_SECRET séparément (Dashboard Cloudinary → API Keys).',
      });
    }
    if (e.message === 'CLOUDINARY_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'Cloudinary mal configuré sur le serveur (clés manquantes).',
      });
    }
    return res.status(500).json({ error: 'Impossible d’enregistrer la photo.' });
  }
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

/**
 * POST — session cookie et/ou handoffProof (sessionStorage iOS / WebKit cross-site).
 */
function createHandoff(req, res) {
  let user = null;
  let loginMethod = null;
  if (req.session?.user?.id) {
    user = req.session.user;
    loginMethod = req.session.loginMethod || null;
  } else {
    const raw = String(req.body?.handoffProof || req.headers['x-handoff-proof'] || '').trim();
    const snap = handoffProof.verifyProofForHandoff(raw);
    if (!snap) {
      return res.status(401).json({ error: 'Non connecté' });
    }
    user = snap.user;
    loginMethod = snap.loginMethod;
    if (String(user.id).startsWith('site_')) {
      const row = siteUserStore.getUserRowById(user.id);
      if (!row || !row.verified) {
        return res.status(401).json({ error: 'Non connecté' });
      }
      user = siteUserStore.sessionUserFromRow(row);
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  const payload = {
    user,
    loginMethod,
  };
  try {
    handoffStore.createToken(token, payload);
  } catch (e) {
    console.error('[Auth] handoff create:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
  return res.json({ ok: true, token });
}

function safeHandoffNext(raw) {
  const p = String(raw || '/import-likes.html').split('?')[0];
  if (p !== '/import-likes.html') return '/import-likes.html';
  return p;
}

/**
 * GET ?h=&next= — Safari iOS applique mal Set-Cookie après fetch JSON ; une redirection HTTP fixe la session.
 */
function applyHandoffGet(req, res) {
  const token = String(req.query.h || '').trim();
  const nextPath = safeHandoffNext(req.query.next);
  const payload = handoffStore.takeToken(token);
  if (!payload || !payload.user) {
    return res.redirect(302, `${nextPath}?handoff_err=1`);
  }
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('[Auth] handoff apply regenerate:', regenErr);
      return res.redirect(302, `${nextPath}?handoff_err=1`);
    }
    req.session.user = payload.user;
    req.session.loginMethod = payload.loginMethod || 'handoff';
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[Auth] handoff apply save:', saveErr);
        return res.redirect(302, `${nextPath}?handoff_err=1`);
      }
      return res.redirect(302, nextPath);
    });
  });
}

/**
 * POST { token } — page import sur l’API (1er niveau) : établit une session cookie sur ce domaine.
 */
function consumeHandoff(req, res) {
  const token = String(req.body?.token || '').trim();
  const payload = handoffStore.takeToken(token);
  if (!payload || !payload.user) {
    return res.status(400).json({
      error:
        'Lien invalide ou expiré (5 min max). Retourne sur le site, reconnecte-toi, puis reclique sur « Importer mes likes ».',
    });
  }
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('[Auth] handoff regenerate:', regenErr);
      return res.status(500).json({ error: 'Erreur session' });
    }
    req.session.user = payload.user;
    req.session.loginMethod = payload.loginMethod || 'handoff';
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[Auth] handoff save:', saveErr);
        return res.status(500).json({ error: 'Erreur session' });
      }
      return res.json({ ok: true });
    });
  });
}

module.exports = {
  logout,
  me,
  myProfile,
  updateMyBio,
  sessionPayload,
  registerSite,
  verifySiteEmail,
  resendVerification,
  loginSite,
  verifyLogin2fa,
  resendLogin2fa,
  uploadProfileAvatar,
  createHandoff,
  consumeHandoff,
  applyHandoffGet,
};
