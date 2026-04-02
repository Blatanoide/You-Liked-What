/**
 * Comptes « site » (pseudo + e-mail + mot de passe), distincts d’Instagram.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const likesStore = require('./likesStore');

const SALT_ROUNDS = 10;
const CODE_TTL_SEC = 60 * 60;

function getDb() {
  const db = likesStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      verification_expires INTEGER NOT NULL DEFAULT 0,
      profile_picture TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_site_users_email ON site_users(email);
  `);
  return db;
}

function normalizeSiteUsername(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9._]{3,30}$/.test(s)) return null;
  return s;
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 9) {
    return 'Le mot de passe doit faire au moins 9 caractères (strictement plus de 8).';
  }
  if (!/[A-Z]/.test(pw)) {
    return 'Le mot de passe doit contenir au moins une majuscule.';
  }
  return null;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * @param {{ username: string, email: string, password: string }} p
 */
async function createPendingUser(p) {
  const code = generateCode();
  const expires = Math.floor(Date.now() / 1000) + CODE_TTL_SEC;
  const id = `site_${crypto.randomUUID()}`;
  const hash = await bcrypt.hash(p.password, SALT_ROUNDS);
  try {
    getDb()
      .prepare(
        `INSERT INTO site_users (id, username, email, password_hash, verified, verification_code, verification_expires, profile_picture)
         VALUES (?, ?, ?, ?, 0, ?, ?, NULL)`
      )
      .run(id, p.username, p.email, hash, code, expires);
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('UNIQUE constraint failed')) {
      if (msg.includes('username')) throw new Error('USERNAME_TAKEN');
      if (msg.includes('email')) throw new Error('EMAIL_TAKEN');
    }
    throw e;
  }
  return { id, username: p.username, email: p.email, code, expires };
}

function findByEmail(email) {
  if (!email) return null;
  return getDb().prepare('SELECT * FROM site_users WHERE email = ?').get(String(email).toLowerCase());
}

function findByUsername(username) {
  if (!username) return null;
  return getDb().prepare('SELECT * FROM site_users WHERE username = ?').get(String(username).toLowerCase());
}

function findByEmailOrUsername(login) {
  const q = String(login || '').trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  if (lower.includes('@')) return findByEmail(lower);
  return findByUsername(lower);
}

function getUserRowById(id) {
  if (!id) return null;
  return getDb().prepare('SELECT * FROM site_users WHERE id = ?').get(String(id));
}

function setVerified(userId) {
  getDb()
    .prepare(
      `UPDATE site_users SET verified = 1, verification_code = NULL, verification_expires = 0 WHERE id = ?`
    )
    .run(userId);
}

/**
 * @param {string} email
 * @param {string} codeStr
 */
function verifyEmailCode(email, codeStr) {
  const emailN = normalizeEmail(email);
  const code = String(codeStr || '').replace(/\D/g, '').slice(0, 6);
  if (!emailN || code.length !== 6) {
    return { ok: false, error: 'E-mail ou code invalide.' };
  }
  const row = findByEmail(emailN);
  if (!row) {
    return { ok: false, error: 'Aucun compte trouvé pour cet e-mail.' };
  }
  if (row.verified) {
    return { ok: false, error: 'Ce compte est déjà vérifié — connecte-toi.' };
  }
  if (row.verification_code !== code) {
    return { ok: false, error: 'Code incorrect.' };
  }
  if (Number(row.verification_expires) < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'Code expiré — crée un nouveau compte ou contacte le support.' };
  }
  setVerified(row.id);
  const fresh = findByEmail(emailN);
  return { ok: true, user: fresh };
}

/**
 * @param {string} login
 * @param {string} password
 * @returns {Promise<import('better-sqlite3').Row | { error: string } | null>}
 */
async function checkLogin(login, password) {
  const row = findByEmailOrUsername(login);
  if (!row) return null;
  const pwOk = await bcrypt.compare(String(password || ''), row.password_hash);
  if (!pwOk) return null;
  if (!row.verified) {
    return {
      error: 'Compte non vérifié — entre le code reçu par e-mail ci-dessous.',
      needsVerification: true,
      email: row.email,
    };
  }
  return row;
}

/**
 * Nouveau code pour un compte encore non vérifié (e-mail identique à l’inscription).
 */
function regenerateVerificationForEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: 'E-mail invalide.' };
  const row = findByEmail(email);
  if (!row) return { ok: false, error: 'Aucun compte pour cet e-mail.' };
  if (row.verified) return { ok: false, error: 'Ce compte est déjà vérifié.' };
  const code = generateCode();
  const expires = Math.floor(Date.now() / 1000) + CODE_TTL_SEC;
  getDb()
    .prepare('UPDATE site_users SET verification_code = ?, verification_expires = ? WHERE id = ?')
    .run(code, expires, row.id);
  return { ok: true, code, email };
}

function updateProfilePicturePath(userId, relativePath) {
  getDb().prepare('UPDATE site_users SET profile_picture = ? WHERE id = ?').run(relativePath, userId);
}

function sessionUserFromRow(row) {
  return {
    id: row.id,
    username: row.username,
    profile_picture: row.profile_picture || null,
    loginMethod: 'site',
  };
}


module.exports = {
  getDb,
  normalizeSiteUsername,
  normalizeEmail,
  validatePassword,
  createPendingUser,
  findByEmail,
  getUserRowById,
  verifyEmailCode,
  checkLogin,
  regenerateVerificationForEmail,
  updateProfilePicturePath,
  sessionUserFromRow,
};
