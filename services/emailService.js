/**
 * Envoi des codes par e-mail.
 *
 * Render FREE : ports SMTP 25/465/587 bloqués → utiliser une API HTTP :
 *
 * Option A — Brevo (gratuit ~300 mails/jour) :
 *   1. https://www.brevo.com → compte gratuit
 *   2. Vérifier ton adresse expéditeur (Senders → ton Gmail)
 *   3. Render : BREVO_API_KEY=xkeysib-...
 *              EMAIL_FROM=ton@gmail.com
 *
 * Option B — Resend (gratuit) :
 *   RESEND_API_KEY=re_...
 *   EMAIL_FROM=SoundGuess <noreply@ton-domaine-verifie.com>
 *
 * SMTP Gmail : fonctionne en local ou Render PAYANT uniquement.
 */

const nodemailer = require('nodemailer');
const dns = require('dns');
const { APP_NAME } = require('../config/constants');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let verifyCache = { ok: null, error: null, provider: null, checkedAt: 0 };
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

function emailFrom() {
  return stripEnv(process.env.EMAIL_FROM) || smtpUser() || 'noreply@soundguess.app';
}

function emailProvider() {
  if (stripEnv(process.env.RESEND_API_KEY)) return 'resend';
  if (stripEnv(process.env.BREVO_API_KEY)) return 'brevo';
  if (smtpUser() && smtpPass()) return 'smtp';
  return 'none';
}

function isConfigured() {
  return emailProvider() !== 'none';
}

function isRenderFreeHint() {
  return process.env.RENDER === 'true' && emailProvider() === 'smtp';
}

async function sendViaResend(to, subject, text, html) {
  const key = stripEnv(process.env.RESEND_API_KEY);
  const from = emailFrom();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from.includes('<') ? from : `"${APP_NAME}" <${from}>`,
      to: [to],
      subject,
      text,
      html: html || undefined,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.error || `Resend HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { sent: true, messageId: body.id || null };
}

async function sendViaBrevo(to, subject, text, html) {
  const key = stripEnv(process.env.BREVO_API_KEY);
  const fromEmail = emailFrom();
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: APP_NAME, email: fromEmail },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html || `<p>${text.replace(/\n/g, '<br>')}</p>`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.error || `Brevo HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { sent: true, messageId: body.messageId || null };
}

async function resolveSmtpHost() {
  const override = stripEnv(process.env.SMTP_HOST_IP);
  if (override && /^\d+\.\d+\.\d+\.\d+$/.test(override)) return override;
  const hostname = stripEnv(process.env.SMTP_HOST || 'smtp.gmail.com').toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  const addrs = await dns.promises.resolve4(hostname);
  if (!addrs.length) throw new Error(`Aucune IPv4 pour ${hostname}`);
  return addrs[0];
}

async function buildSmtpTransporter() {
  const hostname = stripEnv(process.env.SMTP_HOST || 'smtp.gmail.com').toLowerCase();
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

async function getSmtpTransporter() {
  if (!transporterPromise) transporterPromise = buildSmtpTransporter();
  return transporterPromise;
}

function resetSmtpTransporter() {
  transporterPromise = null;
}

async function sendViaSmtp(to, subject, text, html) {
  const user = smtpUser();
  const transporter = await getSmtpTransporter();
  const info = await transporter.sendMail({
    from: `"${APP_NAME}" <${user}>`,
    to,
    replyTo: user,
    subject,
    text,
    html: html || undefined,
  });
  return { sent: true, messageId: info.messageId || null };
}

async function verifySmtp() {
  const provider = emailProvider();
  if (provider === 'none') {
    verifyCache = {
      ok: false,
      error: 'Aucun provider (BREVO_API_KEY, RESEND_API_KEY ou SMTP)',
      provider: 'none',
      checkedAt: Date.now(),
    };
    return verifyCache;
  }
  if (provider === 'resend' || provider === 'brevo') {
    verifyCache = { ok: true, error: null, provider, checkedAt: Date.now() };
    return verifyCache;
  }
  if (isRenderFreeHint()) {
    verifyCache = {
      ok: false,
      error: 'Render free bloque SMTP (ports 465/587). Utilise BREVO_API_KEY ou upgrade Render.',
      provider: 'smtp',
      checkedAt: Date.now(),
    };
    return verifyCache;
  }
  try {
    const transporter = await getSmtpTransporter();
    await transporter.verify();
    verifyCache = {
      ok: true,
      error: null,
      provider: 'smtp',
      checkedAt: Date.now(),
      host: await resolveSmtpHost(),
    };
  } catch (e) {
    resetSmtpTransporter();
    verifyCache = {
      ok: false,
      error: e.response || e.message || String(e),
      provider: 'smtp',
      checkedAt: Date.now(),
    };
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
  const provider = emailProvider();
  return {
    configured: isConfigured(),
    provider,
    verified: verifyCache.ok,
    verifyError: verifyCache.ok === false ? verifyCache.error : null,
    renderSmtpBlocked: isRenderFreeHint(),
    emailFrom: emailFrom().replace(/(.{2}).*(@.*)/, '$1***$2'),
    lastSend: lastSend.at
      ? { at: lastSend.at, ok: lastSend.ok, to: lastSend.to, error: lastSend.error }
      : null,
  };
}

async function sendMailText(to, subject, text, html) {
  const provider = emailProvider();
  if (provider === 'none') {
    lastSend = { at: Date.now(), ok: false, error: 'not_configured', to: maskEmail(to) };
    return { sent: false, skippedReason: 'smtp_not_configured' };
  }

  try {
    let result;
    if (provider === 'resend') result = await sendViaResend(to, subject, text, html);
    else if (provider === 'brevo') result = await sendViaBrevo(to, subject, text, html);
    else result = await sendViaSmtp(to, subject, text, html);

    console.log(`[Email/${provider}] Envoyé à`, to);
    lastSend = { at: Date.now(), ok: true, error: null, to: maskEmail(to) };
    return result;
  } catch (e) {
    if (provider === 'smtp') resetSmtpTransporter();
    const msg = e.message || String(e);
    console.error(`[Email/${provider}] Échec pour`, to, ':', msg);
    lastSend = { at: Date.now(), ok: false, error: msg, to: maskEmail(to) };
    return { sent: false, skippedReason: 'send_error', smtpMessage: msg };
  }
}

async function sendVerificationEmail(to, code) {
  const text = `Voici ton code de vérification pour ${APP_NAME} :\n\n[${code}]\n\nSi tu n’as pas créé de compte, ignore ce message.`;
  const html = `<p>Code de vérification <strong>${APP_NAME}</strong> :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">[${code}]</p>`;
  const result = await sendMailText(to, `Code de vérification — ${APP_NAME}`, text, html);
  if (!result.sent) console.warn('[Email] Code secours pour', to, ':', `[${code}]`);
  return result;
}

async function sendLogin2faEmail(to, code) {
  const text = `Connexion ${APP_NAME} — code : [${code}] (valide 10 min).`;
  const html = `<p>Connexion <strong>${APP_NAME}</strong> :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">[${code}]</p>`;
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
