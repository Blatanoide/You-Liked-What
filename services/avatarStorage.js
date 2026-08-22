/**
 * Avatars — Cloudinary en prod (durable), disque local en dev si non configuré.
 *
 * Render : définir CLOUDINARY_URL (recommandé) ou
 *   CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET
 */

const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

let cloudinaryReady = false;

function stripEnvQuotes(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
}

function isCloudinaryEnabled() {
  if (stripEnvQuotes(process.env.CLOUDINARY_URL)) return true;
  return Boolean(
    stripEnvQuotes(process.env.CLOUDINARY_CLOUD_NAME) &&
      stripEnvQuotes(process.env.CLOUDINARY_API_KEY) &&
      stripEnvQuotes(process.env.CLOUDINARY_API_SECRET)
  );
}

function cloudinaryCredentialsPresent() {
  const cfg = cloudinary.config();
  return Boolean(cfg.cloud_name && cfg.api_key && cfg.api_secret);
}

function ensureCloudinary() {
  if (cloudinaryReady) return;

  const url = stripEnvQuotes(process.env.CLOUDINARY_URL);
  if (url) {
    process.env.CLOUDINARY_URL = url;
    cloudinary.config();
    cloudinary.config({ secure: true });
  } else {
    cloudinary.config({
      cloud_name: stripEnvQuotes(process.env.CLOUDINARY_CLOUD_NAME),
      api_key: stripEnvQuotes(process.env.CLOUDINARY_API_KEY),
      api_secret: stripEnvQuotes(process.env.CLOUDINARY_API_SECRET),
      secure: true,
    });
  }

  if (!cloudinaryCredentialsPresent()) {
    throw new Error('CLOUDINARY_NOT_CONFIGURED');
  }
  cloudinaryReady = true;
}

function getCloudinaryStatus() {
  if (!isCloudinaryEnabled()) {
    return { enabled: false, ready: false };
  }
  try {
    ensureCloudinary();
    const cfg = cloudinary.config();
    return {
      enabled: true,
      ready: true,
      cloudName: cfg.cloud_name || null,
    };
  } catch (e) {
    return {
      enabled: true,
      ready: false,
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

function uploadToCloudinary(buffer, userId, mimetype) {
  ensureCloudinary();
  const publicId = publicIdForUser(userId);
  const mime = String(mimetype || 'image/jpeg').toLowerCase();
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      dataUri,
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

function cloudinaryErrorMessage(err) {
  if (!err) return 'Erreur Cloudinary inconnue';
  const parts = [err.message, err.error?.message].filter(Boolean);
  return parts[0] || 'Erreur Cloudinary inconnue';
}

async function uploadAvatar(buffer, userId, mimetype) {
  if (isCloudinaryEnabled()) {
    try {
      const url = await uploadToCloudinary(buffer, userId, mimetype);
      return { url, storage: 'cloudinary' };
    } catch (e) {
      console.error('[Avatar] Cloudinary upload:', cloudinaryErrorMessage(e), e.http_code || '');
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
  isObsoleteLocalAvatar,
  uploadAvatar,
  deletePreviousAvatar,
};
