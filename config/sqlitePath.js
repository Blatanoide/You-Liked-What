/**
 * Chemin unique du fichier SQLite (comptes site, likes, sessions, handoffs, stats).
 *
 * Persistance après redéploiement (Render, etc.) :
 * 1. Ajoute un disque persistant au service (Render : Settings → Disks, ou Blueprint ci-dessous).
 * 2. Définis SQLITE_PATH vers un fichier SUR ce disque, ex. /var/ylw-data/app.db
 *    ou DATA_DIR=/var/ylw-data (le fichier sera …/app.db).
 *
 * Sans disque / sans SQLITE_PATH, la base reste sous backend/data/ (souvent effacée au redeploy).
 *
 * Alternative gratuite (sans disque Render) : Turso + variables TURSO_DATABASE_URL et TURSO_AUTH_TOKEN.
 * Le backend utilise alors une réplique locale (turso-replica.db à côté du chemin logique app.db).
 * Import massif lent ? Même région Turso que Render si possible ; option TURSO_READ_YOUR_WRITES=false
 * (les gros imports appellent quand même sync() à la fin pour pousser vers le cloud).
 */

const fs = require('fs');
const path = require('path');

function getSqliteDatabasePath() {
  const explicit = (process.env.SQLITE_PATH || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const dataDir = (process.env.DATA_DIR || '').trim();
  if (dataDir) {
    return path.resolve(dataDir, 'app.db');
  }
  return path.join(__dirname, '..', 'data', 'app.db');
}

/** Crée le dossier parent si besoin ; retourne le chemin complet du fichier .db */
function ensureSqliteDirectory() {
  const file = getSqliteDatabasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

module.exports = {
  getSqliteDatabasePath,
  ensureSqliteDirectory,
};
