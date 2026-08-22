/**
 * Avatars — Cloudinary en prod (durable), disque local en dev si non configuré.
 *
 * Render (recommandé, évite les problèmes d'encodage URL) :
 *   CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET
 * Alternative : CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD_NAME
 *   (SECRET doit être URL-encodé si caractères spéciaux)
 */

const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

let cloudinaryReady = false;
let verifyCache = { ok: null, error: null, httpCode: null, checkedAt: 0 };

function stripEnvQuotes(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
}

function discreteCloudinaryEnv() {
  const cloud_name = stripEnvQuotes(process.env.CLOUDINARY_CLOUD_NAME);
  const api_key = stripEnvQuotes(process.env.CLOUDINARY_API_KEY);
  const api_secret = stripEnvQuotes(process.env.CLOUDINARY_API_SECRET);
  if (cloud_name && api_key && api_secret) {
    return { cloud_name, api_key, api_secret };
  }
  return null;
}

function isCloudinaryEnabled() {
  if (discreteCloudinaryEnv()) return true;
  return Boolean(stripEnvQuotes(process.env.CLOUDINARY_URL));
}

function cloudinaryCredentialsPresent() {
  const cfg = cloudinary.config();
  return Boolean(cfg.cloud_name && cfg.api_key && cfg.api_secret);
}

function ensureCloudinary() {
  if (cloudinaryReady) return;

  const discrete = discreteCloudinaryEnv();
  if (discrete) {
    cloudinary.config({ ...discrete, secure: true });
  } else {
    const url = stripEnvQuotes(process.env.CLOUDINARY_URL);
    if (!url) {
      throw new Error('CLOUDINARY_NOT_CONFIGURED');
    }
    process.env.CLOUDINARY_URL = url;
    cloudinary.config();
    cloudinary.config({ secure: true });
  }

  if (!cloudinaryCredentialsPresent()) {
    throw new Error('CLOUDINARY_NOT_CONFIGURED');
  }
  cloudinaryReady = true;
}

function cloudinaryErrorMessage(err) {
  if (!err) return 'Erreur Cloudinary inconnue';
  if (typeof err === 'string') return err;
  const nested = err.error?.message || err.error?.error?.message;
  const parts = [err.message, nested].filter(Boolean);
  const msg = parts[0] || 'Erreur Cloudinary inconnue';
  if (err.http_code) return `${msg} (HTTP ${err.http_code})`;
  return msg;
}

function verifyCloudinaryPing() {
  ensureCloudinary();
  return new Promise((resolve) => {
    cloudinary.api.ping((err, result) => {
      if (err) {
        const error = cloudinaryErrorMessage(err);
        verifyCache = {
          ok: false,
          error,
          httpCode: err.http_code || null,
          checkedAt: Date.now(),
        };
        resolve(verifyCache);
        return;
      }
      verifyCache = {
        ok: true,
        error: null,
        httpCode: 200,
        status: result?.status || 'ok',
        checkedAt: Date.now(),
      };
      resolve(verifyCache);
    });
  });
}

function getCloudinaryStatus() {
  if (!isCloudinaryEnabled()) {
    return { enabled: false, ready: false, verified: false };
  }
  try {
    ensureCloudinary();
    const cfg = cloudinary.config();
    return {
      enabled: true,
      ready: true,
      cloudName: cfg.cloud_name || null,
      verified: verifyCache.ok,
      verifyError: verifyCache.ok === false ? verifyCache.error : null,
      configSource: discreteCloudinaryEnv() ? 'env_vars' : 'cloudinary_url',
    };
  } catch (e) {
    return {
      enabled: true,
      ready: false,
      verified: false,
      error: e.message || String(e),
    };
  }
}

function extFromMime(mimetype) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[String(mimetype || '').toLowerCase()] || 'jpg';
}

function publicIdForUser(userId) {
  const safe = String(userId || 'x').replace(/[^a-z0-9_-]/gi, '');
  return `soundguess/avatars/${safe}`;
}

function publicIdFromCloudinaryUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+$/i);
  return m ? m[1] : null;
}

function uploadToCloudinary(buffer, userId) {
  ensureCloudinary();
  const publicId = publicIdForUser(userId);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        overwrite: true,
        resource_type: 'image',
      },
      (err, result) => {
        if (err) return reject(err);
        if (!result?.secure_url) return reject(new Error('Cloudinary: URL manquante'));
        resolve(result.secure_url);
      }
    );
    stream.on('error', reject);
    stream.end(buffer);
  });
}

function saveLocal(buffer, userId, mimetype) {
  const dir = path.join(__dirname, '..', 'uploads', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const ext = extFromMime(mimetype);
  const filename = `${String(userId).replace(/[^a-z0-9_-]/gi, '')}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/profiles/${filename}`;
}

async function uploadAvatar(buffer, userId, mimetype) {
  if (isCloudinaryEnabled()) {
    if (verifyCache.ok === false) {
      await verifyCloudinaryPing();
    }
    if (verifyCache.ok === false) {
      const err = new Error('CLOUDINARY_AUTH_FAILED');
      err.detail = verifyCache.error;
      throw err;
    }
    try {
      const url = await uploadToCloudinary(buffer, userId);
      return { url, storage: 'cloudinary' };
    } catch (e) {
      console.error('[Avatar] Cloudinary upload:', cloudinaryErrorMessage(e));
      await verifyCloudinaryPing();
      const err = new Error('CLOUDINARY_UPLOAD_FAILED');
      err.cause = e;
      err.detail = cloudinaryErrorMessage(e);
      throw err;
    }
  }
  const url = saveLocal(buffer, userId, mimetype);
  return { url, storage: 'local' };
}

/** Chemins locaux obsolètes une fois Cloudinary actif (fichiers perdus sur Render). */
function isObsoleteLocalAvatar(storedUrl) {
  return (
    isCloudinaryEnabled() &&
    typeof storedUrl === 'string' &&
    storedUrl.startsWith('/uploads/profiles/')
  );
}

async function deletePreviousAvatar(storedUrl) {
  if (!storedUrl) return;
  const s = String(storedUrl);
  if (s.includes('res.cloudinary.com') && isCloudinaryEnabled()) {
    try {
      ensureCloudinary();
      const publicId = publicIdFromCloudinaryUrl(s);
      if (publicId) await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (e) {
      console.warn('[Avatar] Cloudinary delete:', e.message || e);
    }
    return;
  }
  if (s.startsWith('/uploads/profiles/')) {
    try {
      fs.unlinkSync(path.join(__dirname, '..', s.replace(/^\//, '')));
    } catch (_) {}
  }
}

module.exports = {
  isCloudinaryEnabled,
  getCloudinaryStatus,
  verifyCloudinaryPing,
  isObsoleteLocalAvatar,
  uploadAvatar,
  deletePreviousAvatar,
};
