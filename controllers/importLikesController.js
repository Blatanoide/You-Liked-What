/**
 * Import des likes depuis l’export de données Instagram (fichiers / ZIP).
 */

const likesStore = require('../services/likesStore');
const { tursoCreds, flushTursoSyncNow, queueTursoDb } = require('../services/openDatabase');
const ingest = require('../services/instagramExportIngest');
const { MIN_LIKES } = require('../config/constants');

async function importFromInstagramExport(req, res) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Connecte-toi d’abord.' });
  }

  const files = req.files;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({
      error: 'Aucun fichier reçu. Envoie un fichier .zip ou des fichiers .json avec le champ « files ».',
    });
  }

  try {
    const { entries, diagnostics } = await ingest.ingestMulterFiles(files);
    if (entries.length === 0) {
      return res.status(422).json({
        ok: false,
        error:
          'Aucun « J’aime » Instagram détecté dans ces fichiers. Vérifie que tu as bien demandé l’export avec les likes, puis réessaie avec le .zip ou les fichiers du dossier.',
        diagnostics,
      });
    }

    const userId = String(req.session.user.id);
    const turso = tursoCreds().enabled;

    const dbResult = await queueTursoDb(() => {
      const r = likesStore.upsertMany(userId, entries, {
        skipScheduleTurso: turso,
      });
      if (turso) {
        flushTursoSyncNow(likesStore.getDb());
      }
      return r;
    });

    likesStore.hydrateSession(req);
    req.session.save((err) => {
      if (err) {
        console.error('[ImportLikes] session.save:', err);
        return res.status(500).json({ error: 'Erreur en enregistrant la session.' });
      }
      const list = Array.isArray(req.session.simulatedLikes) ? req.session.simulatedLikes : [];
      return res.json({
        ok: true,
        importedUnique: entries.length,
        dbResult,
        totalInGamePool: list.length,
        totalInDatabase: likesStore.countForUser(userId),
        canPlay: list.length >= MIN_LIKES,
        simulatedLikes: list,
        diagnostics,
      });
    });
  } catch (e) {
    console.error('[ImportLikes]', e);
    return res.status(500).json({ error: (e && e.message) || 'Erreur serveur pendant l’analyse.' });
  }
}

module.exports = { importFromInstagramExport };
