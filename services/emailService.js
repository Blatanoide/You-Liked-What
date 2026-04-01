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

  const text = `Voici ton code de vérification pour You Liked What :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;

  const info = await transporter.sendMail({
    from: `"You Liked What" <${from}>`,
    to,
    replyTo: from,
    subject: 'Code de vérification — You Liked What?',
    text,
  });

  console.log('[Email] Code envoyé à', to, info.messageId ? `(id ${info.messageId})` : '');
  return { sent: true };
}

module.exports = {
  isConfigured,
  sendVerificationEmail,
};
