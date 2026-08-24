/**
 * Envoi des codes par e-mail (Gmail / SMTP).
 *
 * Render — variables recommandées :
 *   SMTP_USER=ton-compte@gmail.com
 *   SMTP_PASS=mot_de_passe_application_16_caracteres
 *   SMTP_PORT=465
 */

const nodemailer = require('nodemailer');
const dns = require('dns');
const { APP_NAME } = require('../config/constants');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let verifyCache = { ok: null, error: null, checkedAt: 0 };
let lastSend = { at: 0, ok: null, error: null, to: null };
let transporterPromise = null;

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

function smtpHostname() {
  return stripEnv(process.env.SMTP_HOST || 'smtp.gmail.com').toLowerCase();
}

function isConfigured() {
  return Boolean(smtpUser() && smtpPass());
}

async function resolveSmtpHost() {
  const override = stripEnv(process.env.SMTP_HOST_IP);
  if (override && /^\d+\.\d+\.\d+\.\d+$/.test(override)) return override;

  const hostname = smtpHostname();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;

  const addrs = await dns.promises.resolve4(hostname);
  if (!addrs.length) throw new Error(`Aucune adresse IPv4 pour ${hostname}`);
  return addrs[0];
}

async function buildTransporter() {
  const hostname = smtpHostname();
  const host = await resolveSmtpHost();
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    process.env.SMTP_SECURE === 'true' || (process.env.SMTP_SECURE !== 'false' && port === 465);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: smtpUser(), pass: smtpPass() },
    tls: { servername: hostname },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
}

async function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = buildTransporter();
  }
  return transporterPromise;
}

function resetTransporter() {
  transporterPromise = null;
}

async function verifySmtp() {
  if (!isConfigured()) {
    verifyCache = { ok: false, error: 'SMTP_USER ou SMTP_PASS manquant', checkedAt: Date.now() };
    return verifyCache;
  }
  try {
    const transporter = await getTransporter();
    await transporter.verify();
    verifyCache = { ok: true, error: null, checkedAt: Date.now(), host: await resolveSmtpHost() };
  } catch (e) {
    resetTransporter();
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
    smtpHost: smtpHostname(),
    smtpResolvedIp: verifyCache.host || null,
    smtpPort: port,
    lastSend: lastSend.at
      ? { at: lastSend.at, ok: lastSend.ok, to: lastSend.to, error: lastSend.error }
      : null,
  };
}

async function sendMailText(to, subject, text, html) {
  const user = smtpUser();
  if (!isConfigured()) {
    lastSend = { at: Date.now(), ok: false, error: 'smtp_not_configured', to: maskEmail(to) };
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  try {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
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
    resetTransporter();
    const smtpMsg = e.response || e.message || String(e);
    console.error('[Email] Échec SMTP pour', to, ':', smtpMsg);
    lastSend = { at: Date.now(), ok: false, error: smtpMsg, to: maskEmail(to) };
    return { sent: false, skippedReason: 'smtp_error', smtpMessage: smtpMsg };
  }
}

async function sendVerificationEmail(to, code) {
  const text = `Voici ton code de vérification pour ${APP_NAME} :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;
  const html = `<p>Voici ton code de vérification pour <strong>${APP_NAME}</strong> :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">[${code}]</p>`;
  const result = await sendMailText(to, `Code de vérification — ${APP_NAME}`, text, html);
  if (!result.sent) console.warn('[Email] Code secours pour', to, ':', `[${code}]`);
  return result;
}

async function sendLogin2faEmail(to, code) {
  const text = `Connexion ${APP_NAME} — code : [${code}] (10 min).`;
  const html = `<p>Connexion à <strong>${APP_NAME}</strong>.</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">[${code}]</p>`;
  const result = await sendMailText(to, `Code de connexion — ${APP_NAME}`, text, html);
  if (!result.sent) console.warn('[Email] Code 2FA secours pour', to, ':', `[${code}]`);
  return result;
}

module.exports = {
  isConfigured,
  verifySmtp,
  getEmailStatus,
  sendVerificationEmail,
  sendLogin2faEmail,
};
