/**
 * Copie le front statique vers backend/public pour les déplois « backend seul » (Render).
 * Inclut le jeu + la page import → même domaine que l’API = session reconnue partout.
 * Commande : node scripts/copy-import-static.js  (ou npm run sync-public)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const fe = path.join(root, '..', 'frontend');
const files = [
  'index.html',
  'client.js',
  'style.css',
  'import-likes.html',
  'import-likes.js',
];

fs.mkdirSync(pub, { recursive: true });
for (const name of files) {
  const from = path.join(fe, name);
  const to = path.join(pub, name);
  if (!fs.existsSync(from)) {
    console.warn('Absent:', from);
    continue;
  }
  fs.copyFileSync(from, to);
  console.log('OK', name);
}
