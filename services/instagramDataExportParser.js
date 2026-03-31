/**
 * Détection et parsing des fichiers « Télécharger vos informations » Instagram.
 * Ne suppose pas un nom de fichier fixe : parcourt JSON / texte et extrait les permaliens.
 */

const instagramService = require('./instagramService');

const MAX_JSON_BYTES = 48 * 1024 * 1024;
const IG_URL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/gi;

/**
 * @param {string} relativePath — chemin logique (zip) ou nom de fichier
 * @returns {boolean}
 */
function pathSuggestsLikes(relativePath) {
  const p = (relativePath || '').toLowerCase().replace(/\\/g, '/');
  if (!p.endsWith('.json')) return false;
  return (
    /like/.test(p) ||
    /liked/.test(p) ||
    /interactions/.test(p) ||
    /activity/.test(p) ||
    /connections\//.test(p) ||
    /your_instagram_activity/.test(p) ||
    /instagram_your_activity/.test(p)
  );
}

/**
 * Parcourt récursivement un objet JSON pour des paires href + timestamp (export Meta).
 * @param {unknown} node
 * @param {string} sourcePath
 * @param {Map<string, { likedAt: number|null, sourcePath: string }>} out — clé = URL normalisée
 */
function walkJsonForLikes(node, sourcePath, out) {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    extractUrlsFromText(node, sourcePath, out);
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) walkJsonForLikes(item, sourcePath, out);
    return;
  }

  if (typeof node === 'object') {
    const o = /** @type {Record<string, unknown>} */ (node);
    const hrefRaw = o.href;
    if (typeof hrefRaw === 'string' && /instagram\.com/i.test(hrefRaw)) {
      recordLikeEntry(hrefRaw, o.timestamp, sourcePath, out);
    }
    if (Array.isArray(o.string_list_data)) {
      for (const item of o.string_list_data) {
        if (item && typeof item === 'object') {
          const sl = /** @type {Record<string, unknown>} */ (item);
          const h = sl.href;
          if (typeof h === 'string') recordLikeEntry(h, sl.timestamp, sourcePath, out);
        }
      }
    }
    for (const k of Object.keys(o)) {
      if (k === 'href' || k === 'string_list_data') continue;
      walkJsonForLikes(o[k], sourcePath, out);
    }
  }
}

function recordLikeEntry(href, timestamp, sourcePath, out) {
  const normalized = normalizeIgUrl(href);
  if (!normalized) return;
  let likedAt = null;
  if (timestamp != null) {
    const n = Number(timestamp);
    if (Number.isFinite(n)) {
      likedAt = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    }
  }
  const prev = out.get(normalized);
  if (!prev || (likedAt != null && (prev.likedAt == null || likedAt > prev.likedAt))) {
    out.set(normalized, { likedAt, sourcePath });
  }
}

function normalizeIgUrl(href) {
  if (!href || typeof href !== 'string') return null;
  const clean = href.trim().split('?')[0].split('#')[0];
  if (!instagramService.extractShortcode(clean)) return null;
  const reel = /instagram\.com\/(?:reel|reels)\//i.test(clean);
  const tv = /instagram\.com\/tv\//i.test(clean);
  const sc = instagramService.extractShortcode(clean);
  if (!sc) return null;
  if (tv) return `https://www.instagram.com/tv/${sc}/`;
  if (reel) return `https://www.instagram.com/reel/${sc}/`;
  return `https://www.instagram.com/p/${sc}/`;
}

function extractUrlsFromText(text, sourcePath, out) {
  if (!text || typeof text !== 'string') return;
  IG_URL_RE.lastIndex = 0;
  let m;
  while ((m = IG_URL_RE.exec(text)) !== null) {
    recordLikeEntry(m[0], null, sourcePath, out);
  }
}

/**
 * @param {string} content
 * @param {string} sourcePath
 * @param {Map<string, { likedAt: number|null, sourcePath: string }>} out
 */
function parseJsonFileContent(content, sourcePath, out) {
  if (!content || content.length > MAX_JSON_BYTES) return;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    extractUrlsFromText(content, sourcePath, out);
    return;
  }
  try {
    const data = JSON.parse(content);
    walkJsonForLikes(data, sourcePath, out);
  } catch (_) {
    extractUrlsFromText(content, sourcePath, out);
  }
}

/**
 * Analyse un buffer texte (fichier JSON ou texte brut).
 * @returns {{ entries: { postUrl: string, shortcode: string|null, likedAt: number|null, sourceLabel: string }[], scannedAs: string }}
 */
function parseBuffer(buffer, logicalPath) {
  const out = new Map();
  const label = logicalPath || 'fichier';
  if (!buffer || buffer.length === 0) {
    return { entries: [], scannedAs: label };
  }
  if (buffer.length > MAX_JSON_BYTES) {
    return { entries: [], scannedAs: `${label} (ignoré : trop volumineux)` };
  }
  const text = buffer.toString('utf8');
  const lower = label.toLowerCase();
  const likelyJson = lower.endsWith('.json') || trimmedStartsJson(text);
  if (likelyJson) {
    parseJsonFileContent(text, label, out);
  } else {
    extractUrlsFromText(text, label, out);
  }
  const entries = [];
  for (const [postUrl, meta] of out.entries()) {
    entries.push({
      postUrl,
      shortcode: instagramService.extractShortcode(postUrl),
      likedAt: meta.likedAt,
      sourceLabel: `export:${meta.sourcePath}`.slice(0, 200),
    });
  }
  return { entries, scannedAs: label };
}

function trimmedStartsJson(s) {
  const t = s.trim();
  return t.startsWith('{') || t.startsWith('[');
}

module.exports = {
  pathSuggestsLikes,
  parseBuffer,
  parseJsonFileContent,
  walkJsonForLikes,
  MAX_JSON_BYTES,
};
