/**
 * Import des likes depuis l’export de données Instagram (fichiers / ZIP).
 */

const likesStore = require('../services/likesStore');
const { tursoCreds, flushTursoSyncNow, queueTursoDb } = require('../services/openDatabase');
const ingest = require('../services/instagramExportIngest');
const instagramService = require('../services/instagramService');
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
    let { entries, diagnostics } = await ingest.ingestMulterFiles(files);
    if (entries.length === 0) {
      return res.status(422).json({
        ok: false,
        error:
          'Aucun « J’aime » Instagram détecté dans ces fichiers. Vérifie que tu as bien demandé l’export avec les likes, puis réessaie avec le .zip ou les fichiers du dossier.',
        diagnostics,
      });
    }

    /** 0 par défaut : la vérif HTTP Instagram bloque le thread longtemps et fait échouer les health checks Render. */
    const embedCheckLimit = Math.max(
      0,
      Number.parseInt(String(process.env.IMPORT_EMBED_VERIFY_MAX ?? '0'), 10) || 0
    );
    let embedRemoved = 0;
    if (embedCheckLimit > 0) {
      const before = entries.length;
      entries = await instagramService.filterEntriesByReachable(entries, embedCheckLimit);
      embedRemoved = before - entries.length;
      diagnostics = { ...diagnostics, embedUnreachableRemoved: embedRemoved, embedVerifyCap: embedCheckLimit };
    }

    if (entries.length === 0) {
      return res.status(422).json({
        ok: false,
        error:
          'Après vérification, aucun lien Instagram valide reste. Réessaie avec un export à jour (ou désactive la vérif : IMPORT_EMBED_VERIFY_MAX=0).',
        diagnostics,
      });
    }

    const userId = String(req.session.user.id);
    const turso = tursoCreds().enabled;

    /** Découpe l’écriture DB + laisse respirer l’event loop (health check Render ~5 s). */
    const sliceSize = Math.min(1200, Math.max(150, Number(process.env.IMPORT_DB_SLICE) || 400));
    let dbResult = { processed: 0, skippedInvalid: 0 };
    for (let off = 0; off < entries.length; off += sliceSize) {
      const slice = entries.slice(off, off + sliceSize);
      const part = await queueTursoDb(() =>
        likesStore.upsertMany(userId, slice, {
          skipScheduleTurso: turso,
        })
      );
      dbResult.processed += part.processed;
      dbResult.skippedInvalid += part.skippedInvalid;
      await new Promise((r) => setImmediate(r));
    }

    if (turso) {
      setImmediate(() => {
        try {
          flushTursoSyncNow(likesStore.getDb());
        } catch (e) {
          console.warn('[ImportLikes] flush Turso différé :', e.message || e);
        }
      });
    }

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
