/**
 * Envoi du code de vérification (Gmail / SMTP).
 *
 * Gmail : activer la validation en 2 étapes sur le compte, puis créer un
 * « Mot de passe des applications » (https://myaccount.google.com/apppasswords).
 * Dans .env (ne jamais committer) :
 *   SMTP_USER=youlikedwhatsupport@gmail.com
 *   SMTP_PASS=xxxx xxxx xxxx xxxx   (le mot de passe d’app, sans espaces ou avec)
 *   EMAIL_FROM=youlikedwhatsupport@gmail.com   (optionnel, défaut = cette adresse)
 */

const nodemailer = require('nodemailer');
const { APP_NAME } = require('../config/constants');

function smtpPass() {
  const p = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '';
  return String(p).replace(/\s/g, '');
}

function isConfigured() {
  return Boolean(process.env.SMTP_USER && smtpPass());
}

function createTransporter() {
  const user = process.env.SMTP_USER;
  const pass = smtpPass();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').toLowerCase();

  if (host === 'smtp.gmail.com' && process.env.SMTP_EXPLICIT_HOST !== 'true') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user, pass },
  });
}

/**
 * @param {string} to
 * @param {string} code
 * @returns {Promise<{ sent: boolean; skippedReason?: string }>}
 */
async function sendVerificationEmail(to, code) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'youlikedwhatsupport@gmail.com';

  if (!isConfigured()) {
    console.warn(
      '[Email] SMTP non configuré (SMTP_USER + SMTP_PASS ou GMAIL_APP_PASSWORD). Code pour',
      to,
      ':',
      `[${code}]`
    );
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  const transporter = createTransporter();

  const text = `Voici ton code de vérification pour ${APP_NAME} :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;

  try {
    const info = await transporter.sendMail({
      from: `"${APP_NAME}" <${from}>`,
      to,
      replyTo: from,
      subject: `Code de vérification — ${APP_NAME}`,
      text,
    });

    console.log('[Email] Code envoyé à', to, info.messageId ? `(id ${info.messageId})` : '');
    return { sent: true };
  } catch (e) {
    const smtpMsg = e.response || e.message || String(e);
    console.error('[Email] Échec SMTP pour', to, ':', smtpMsg);
    if (e.responseCode) {
      console.error('[Email] Code réponse SMTP:', e.responseCode);
    }
    console.warn('[Email] Code de secours (logs uniquement) pour', to, ':', `[${code}]`);
    return { sent: false, skippedReason: 'smtp_error', smtpMessage: smtpMsg };
  }
}

/**
 * Code à usage unique pour la connexion (2FA par e-mail).
 * @param {string} to
 * @param {string} code
 * @returns {Promise<{ sent: boolean; skippedReason?: string }>}
 */
async function sendLogin2faEmail(to, code) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'youlikedwhatsupport@gmail.com';

  if (!isConfigured()) {
    console.warn('[Email] SMTP non configuré. Code 2FA connexion pour', to, ':', `[${code}]`);
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  const transporter = createTransporter();
  const text = `Quelqu’un tente de se connecter à ton compte ${APP_NAME}.\n\nCode de connexion :\n\n[${code}]\n\nCe code expire dans 10 minutes.\nSi ce n’est pas toi, change ton mot de passe.`;

  try {
    const info = await transporter.sendMail({
      from: `"${APP_NAME}" <${from}>`,
      to,
      replyTo: from,
      subject: `Code de connexion — ${APP_NAME}`,
      text,
    });
    console.log('[Email] Code 2FA connexion envoyé à', to, info.messageId ? `(id ${info.messageId})` : '');
    return { sent: true };
  } catch (e) {
    const smtpMsg = e.response || e.message || String(e);
    console.error('[Email] Échec SMTP 2FA pour', to, ':', smtpMsg);
    console.warn('[Email] Code 2FA de secours pour', to, ':', `[${code}]`);
    return { sent: false, skippedReason: 'smtp_error', smtpMessage: smtpMsg };
  }
}

module.exports = {
  isConfigured,
  sendVerificationEmail,
  sendLogin2faEmail,
};
