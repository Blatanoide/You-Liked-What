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

function isCloudinaryEnabled() {
  if ((process.env.CLOUDINARY_URL || '').trim()) return true;
  return Boolean(
    (process.env.CLOUDINARY_CLOUD_NAME || '').trim() &&
      (process.env.CLOUDINARY_API_KEY || '').trim() &&
      (process.env.CLOUDINARY_API_SECRET || '').trim()
  );
}

function ensureCloudinary() {
  if (cloudinaryReady) return;
  const url = (process.env.CLOUDINARY_URL || '').trim();
  if (url) {
    // CLOUDINARY_URL suffit — ne pas appeler config() vide qui efface les credentials.
    cloudinaryReady = true;
    return;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  cloudinaryReady = true;
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
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        overwrite: true,
        resource_type: 'image',
        format: extFromMime(mimetype),
      },
      (err, result) => {
        if (err) return reject(err);
        if (!result?.secure_url) return reject(new Error('Cloudinary: URL manquante'));
        resolve(result.secure_url);
      }
    );
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
    try {
      const url = await uploadToCloudinary(buffer, userId, mimetype);
      return { url, storage: 'cloudinary' };
    } catch (e) {
      console.error('[Avatar] Cloudinary upload:', e.message || e);
      const err = new Error('CLOUDINARY_UPLOAD_FAILED');
      err.cause = e;
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
  isObsoleteLocalAvatar,
  uploadAvatar,
  deletePreviousAvatar,
};
