/**
 * Envoi des codes par e-mail (Gmail / SMTP).
 *
 * Render — variables recommandées :
 *   SMTP_USER=ton-compte@gmail.com
 *   SMTP_PASS=mot_de_passe_application_16_caracteres
 *   EMAIL_FROM=ton-compte@gmail.com   (optionnel)
 *   SMTP_HOST=smtp.gmail.com          (optionnel)
 *   SMTP_PORT=465                     (optionnel, défaut 465 SSL — recommandé sur Render)
 *
 * Ne pas laisser EMAIL_DEV_RETURN_CODE=true en production une fois SMTP OK.
 */

const nodemailer = require('nodemailer');
const dns = require('dns');
const { APP_NAME } = require('../config/constants');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let verifyCache = { ok: null, error: null, checkedAt: 0 };

function stripEnv(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
}

function smtpUser() {
  return stripEnv(process.env.SMTP_USER);
}

function smtpPass() {
  const p = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '';
  return stripEnv(p).replace(/\s/g, '');
}

function isConfigured() {
  return Boolean(smtpUser() && smtpPass());
}

function createTransporter() {
  const user = smtpUser();
  const pass = smtpPass();
  const host = stripEnv(process.env.SMTP_HOST || 'smtp.gmail.com').toLowerCase();
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    process.env.SMTP_SECURE === 'true' || (process.env.SMTP_SECURE !== 'false' && port === 465);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    // Render free : IPv6 vers Gmail échoue (ENETUNREACH) — forcer IPv4.
    family: 4,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

async function verifySmtp() {
  if (!isConfigured()) {
    verifyCache = { ok: false, error: 'SMTP_USER ou SMTP_PASS manquant', checkedAt: Date.now() };
    return verifyCache;
  }
  try {
    const transporter = createTransporter();
    await transporter.verify();
    verifyCache = { ok: true, error: null, checkedAt: Date.now() };
  } catch (e) {
    const msg = e.response || e.message || String(e);
    verifyCache = { ok: false, error: msg, checkedAt: Date.now() };
    console.error('[Email] Vérification SMTP échouée:', msg);
  }
  return verifyCache;
}

function getEmailStatus() {
  const port = Number(process.env.SMTP_PORT) || 465;
  return {
    configured: isConfigured(),
    verified: verifyCache.ok,
    verifyError: verifyCache.ok === false ? verifyCache.error : null,
    smtpUser: smtpUser() ? smtpUser().replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    smtpPort: port,
    smtpFamily: 'ipv4',
  };
}

async function sendMailText(to, subject, text) {
  const from = stripEnv(process.env.EMAIL_FROM) || smtpUser() || 'noreply@soundguess.app';

  if (!isConfigured()) {
    console.warn('[Email] SMTP non configuré — pas d’envoi à', to);
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  const transporter = createTransporter();

  try {
    const info = await transporter.sendMail({
      from: `"${APP_NAME}" <${from}>`,
      to,
      replyTo: from,
      subject,
      text,
    });
    console.log('[Email] Envoyé à', to, info.messageId ? `(id ${info.messageId})` : '');
    return { sent: true };
  } catch (e) {
    const smtpMsg = e.response || e.message || String(e);
    console.error('[Email] Échec SMTP pour', to, ':', smtpMsg);
    if (e.responseCode) console.error('[Email] Code réponse SMTP:', e.responseCode);
    return { sent: false, skippedReason: 'smtp_error', smtpMessage: smtpMsg };
  }
}

async function sendVerificationEmail(to, code) {
  const text = `Voici ton code de vérification pour ${APP_NAME} :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;
  const result = await sendMailText(to, `Code de vérification — ${APP_NAME}`, text);
  if (!result.sent) {
    console.warn('[Email] Code de secours (logs) pour', to, ':', `[${code}]`);
  }
  return result;
}

async function sendLogin2faEmail(to, code) {
  const text = `Quelqu’un tente de se connecter à ton compte ${APP_NAME}.\n\nCode de connexion :\n\n[${code}]\n\nCe code expire dans 10 minutes.\nSi ce n’est pas toi, change ton mot de passe.`;
  const result = await sendMailText(to, `Code de connexion — ${APP_NAME}`, text);
  if (!result.sent) {
    console.warn('[Email] Code 2FA de secours pour', to, ':', `[${code}]`);
  }
  return result;
}

module.exports = {
  isConfigured,
  verifySmtp,
  getEmailStatus,
  sendVerificationEmail,
  sendLogin2faEmail,
};
