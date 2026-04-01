/**
 * URLs publiques des assets (avatars uploadés) quand le front est sur un autre domaine.
 */

function publicBaseFromEnv() {
  return (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
}

/**
 * @param {import('express').Request | null} req
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
function expandProfilePictureUrl(req, url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!url.startsWith('/')) return url;
  const base = publicBaseFromEnv();
  if (base) return `${base}${url}`;
  if (req && typeof req.get === 'function') {
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    const host = req.get('host');
    if (host) return `${proto}://${host}${url}`;
  }
  return url;
}

module.exports = {
  publicBaseFromEnv,
  expandProfilePictureUrl,
};
