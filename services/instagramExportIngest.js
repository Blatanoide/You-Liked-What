/**
 * Ingère un ou plusieurs fichiers (dont .zip) issus de l’export Instagram.
 */

const unzipper = require('unzipper');
const exportParser = require('./instagramDataExportParser');

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_FILES_IN_ZIP = 400;

/**
 * @param {Buffer} zipBuffer
 * @returns {Promise<{ entries: object[], filesRead: string[], skipped: string[] }>}
 */
async function extractLikesFromZip(zipBuffer) {
  const entries = new Map();
  const filesRead = [];
  const skipped = [];

  if (!zipBuffer || zipBuffer.length > MAX_ZIP_BYTES) {
    skipped.push('archive trop volumineuse (max 200 Mo)');
    return { entries: [], filesRead, skipped };
  }

  let directory;
  try {
    directory = await unzipper.Open.buffer(zipBuffer);
  } catch (e) {
    skipped.push(`ZIP illisible : ${(e && e.message) || e}`);
    return { entries: [], filesRead, skipped };
  }

  let count = 0;
  let processedFiles = 0;
  for (const file of directory.files) {
    if (count >= MAX_FILES_IN_ZIP) {
      skipped.push('limite de fichiers dans l’archive atteinte');
      break;
    }
    if (file.type !== 'File') continue;
    const name = file.path || '';
    if (name.endsWith('/')) continue;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.html') && !lower.endsWith('.htm')) continue;

    let buf;
    try {
      buf = await file.buffer();
    } catch (_) {
      skipped.push(name);
      continue;
    }
    if (!buf || buf.length === 0) continue;
    if (buf.length > exportParser.MAX_JSON_BYTES) {
      skipped.push(`${name} (trop gros)`);
      continue;
    }

    count += 1;
    processedFiles += 1;
    if (processedFiles % 12 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const { entries: parsed } = exportParser.parseBuffer(buf, name);
    if (parsed.length > 0) filesRead.push(name);
    for (const e of parsed) {
      const prev = entries.get(e.postUrl);
      if (!prev || (e.likedAt != null && (prev.likedAt == null || e.likedAt > prev.likedAt))) {
        entries.set(e.postUrl, e);
      }
    }
  }

  return {
    entries: [...entries.values()],
    filesRead,
    skipped,
  };
}

/**
 * @param {{ buffer: Buffer, originalname: string }[]} multerFiles
 */
async function ingestMulterFiles(multerFiles) {
  const merged = new Map();
  const diagnostics = {
    zips: 0,
    looseFiles: 0,
    filesRead: /** @type {string[]} */ ([]),
    skipped: /** @type {string[]} */ ([]),
  };

  for (const f of multerFiles || []) {
    const name = (f.originalname || 'fichier').toLowerCase();
    if (name.endsWith('.zip')) {
      diagnostics.zips += 1;
      const { entries, filesRead, skipped } = await extractLikesFromZip(f.buffer);
      diagnostics.filesRead.push(...filesRead.map((p) => `[zip] ${p}`));
      diagnostics.skipped.push(...skipped);
      for (const e of entries) {
        const prev = merged.get(e.postUrl);
        if (!prev || (e.likedAt != null && (prev.likedAt == null || e.likedAt > prev.likedAt))) {
          merged.set(e.postUrl, e);
        }
      }
    } else {
      diagnostics.looseFiles += 1;
      const { entries, scannedAs } = exportParser.parseBuffer(f.buffer, f.originalname || 'fichier');
      if (entries.length > 0) diagnostics.filesRead.push(scannedAs);
      for (const e of entries) {
        const prev = merged.get(e.postUrl);
        if (!prev || (e.likedAt != null && (prev.likedAt == null || e.likedAt > prev.likedAt))) {
          merged.set(e.postUrl, e);
        }
      }
    }
  }

  return { entries: [...merged.values()], diagnostics };
}

module.exports = {
  extractLikesFromZip,
  ingestMulterFiles,
  MAX_ZIP_BYTES,
};
