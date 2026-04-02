/**
 * Jeton signé (HMAC) pour créer un handoff sans cookie sur la requête POST.
 * Contourne WebKit iOS qui n’envoie parfois pas les cookies cross-site sur fetch POST.
 */

const crypto = require('crypto');

const TTL_SEC = 6 * 60 * 60;

function secret() {
  return process.env.SESSION_SECRET || 'change-me-in-production';
}

function normalizeUserSnapshot(user) {
  if (!user || !user.id) return null;
  return {
    id: String(user.id),
    username: String(user.username || ''),
    profile_picture: user.profile_picture != null ? String(user.profile_picture) : null,
  };
}

/**
 * @param {object} user — req.session.user
 * @param {string|null} loginMethod
 * @returns {string|null}
 */
function issueProofForHandoff(user, loginMethod) {
  const u = normalizeUserSnapshot(user);
  if (!u) return null;
  const e = Math.floor(Date.now() / 1000) + TTL_SEC;
  const payloadStr = JSON.stringify({ e, u, m: loginMethod != null ? String(loginMethod) : null });
  const sig = crypto.createHmac('sha256', secret()).update(payloadStr).digest();
  return Buffer.from(payloadStr, 'utf8').toString('base64url') + '.' + Buffer.from(sig).toString('base64url');
}

/**
 * @param {string} token
 * @returns {{ user: object, loginMethod: string|null } | null}
 */
function verifyProofForHandoff(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payloadStr;
  try {
    payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(payloadStr);
  } catch {
    return null;
  }
  if (!data || typeof data.e !== 'number' || !data.u || !data.u.id) return null;
  if (data.e < Math.floor(Date.now() / 1000)) return null;
  const expectedSig = crypto.createHmac('sha256', secret()).update(payloadStr).digest();
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (sigBuf.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedSig)) return null;
  const u = normalizeUserSnapshot(data.u);
  if (!u) return null;
  return { user: u, loginMethod: data.m != null ? String(data.m) : null };
}

module.exports = {
  issueProofForHandoff,
  verifyProofForHandoff,
};
