/**
 * Envoi du code de vérification (Gmail / SMTP). Aucun secret en dur : SMTP_USER, SMTP_PASS dans .env.
 */

const nodemailer = require('nodemailer');

function isConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * @param {string} to
 * @param {string} code
 * @returns {Promise<{ sent: boolean; skippedReason?: string }>}
 */
async function sendVerificationEmail(to, code) {
  const from = process.env.EMAIL_FROM || 'youlikedwhatsupport@gmail.com';

  if (!isConfigured()) {
    console.warn(
      '[Email] SMTP non configuré (SMTP_USER / SMTP_PASS). Code de vérification pour',
      to,
      ':',
      `[${code}]`
    );
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const text = `Voici ton code de vérification pour You Liked What :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;

  await transporter.sendMail({
    from,
    to,
    subject: 'Code de vérification — You Liked What?',
    text,
  });

  return { sent: true };
}

module.exports = {
  isConfigured,
  sendVerificationEmail,
};
