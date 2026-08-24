/**
 * Envoi des codes par e-mail (Gmail / SMTP).
 *
 * Render — variables recommandées :
 *   SMTP_USER=ton-compte@gmail.com
 *   SMTP_PASS=mot_de_passe_application_16_caracteres
 *   SMTP_PORT=465
 *
 * Ne pas laisser EMAIL_DEV_RETURN_CODE=true en production.
 */

const nodemailer = require('nodemailer');
const dns = require('dns');
const { APP_NAME } = require('../config/constants');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let verifyCache = { ok: null, error: null, checkedAt: 0 };
let lastSend = { at: 0, ok: null, error: null, to: null };
let transporterSingleton = null;

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
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
    lookup: (hostname, _opts, cb) => {
      dns.lookup(hostname, { family: 4, all: false }, cb);
    },
  });
}

function getTransporter() {
  if (!transporterSingleton) {
    transporterSingleton = createTransporter();
  }
  return transporterSingleton;
}

async function verifySmtp() {
  if (!isConfigured()) {
    verifyCache = { ok: false, error: 'SMTP_USER ou SMTP_PASS manquant', checkedAt: Date.now() };
    return verifyCache;
  }
  try {
    await getTransporter().verify();
    verifyCache = { ok: true, error: null, checkedAt: Date.now() };
  } catch (e) {
    transporterSingleton = null;
    const msg = e.response || e.message || String(e);
    verifyCache = { ok: false, error: msg, checkedAt: Date.now() };
    console.error('[Email] Vérification SMTP échouée:', msg);
  }
  return verifyCache;
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return '***';
  return `${s.slice(0, 2)}***${s.slice(at)}`;
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
    lastSend: lastSend.at
      ? {
          at: lastSend.at,
          ok: lastSend.ok,
          to: lastSend.to,
          error: lastSend.error,
        }
      : null,
  };
}

async function sendMailText(to, subject, text, html) {
  const user = smtpUser();
  if (!isConfigured()) {
    console.warn('[Email] SMTP non configuré — pas d’envoi à', to);
    lastSend = { at: Date.now(), ok: false, error: 'smtp_not_configured', to: maskEmail(to) };
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: `"${APP_NAME}" <${user}>`,
      to,
      replyTo: user,
      subject,
      text,
      html: html || undefined,
    });
    console.log('[Email] Envoyé à', to, info.messageId ? `(id ${info.messageId})` : '');
    lastSend = { at: Date.now(), ok: true, error: null, to: maskEmail(to) };
    return { sent: true, messageId: info.messageId || null };
  } catch (e) {
    transporterSingleton = null;
    const smtpMsg = e.response || e.message || String(e);
    console.error('[Email] Échec SMTP pour', to, ':', smtpMsg);
    lastSend = { at: Date.now(), ok: false, error: smtpMsg, to: maskEmail(to) };
    return { sent: false, skippedReason: 'smtp_error', smtpMessage: smtpMsg };
  }
}

async function sendVerificationEmail(to, code) {
  const text = `Voici ton code de vérification pour ${APP_NAME} :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;
  const html = `<p>Voici ton code de vérification pour <strong>${APP_NAME}</strong> :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">[${code}]</p><p>Si tu n’as pas créé de compte, ignore ce message.</p>`;
  const result = await sendMailText(to, `Code de vérification — ${APP_NAME}`, text, html);
  if (!result.sent) {
    console.warn('[Email] Code de secours (logs) pour', to, ':', `[${code}]`);
  }
  return result;
}

async function sendLogin2faEmail(to, code) {
  const text = `Quelqu’un tente de se connecter à ton compte ${APP_NAME}.\n\nCode de connexion :\n\n[${code}]\n\nCe code expire dans 10 minutes.\nSi ce n’est pas toi, change ton mot de passe.`;
  const html = `<p>Connexion à <strong>${APP_NAME}</strong>.</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">[${code}]</p><p>Ce code expire dans 10 minutes.</p>`;
  const result = await sendMailText(to, `Code de connexion — ${APP_NAME}`, text, html);
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
