/**
 * Copie la page d’import + styles depuis le dossier frontend du monorepo vers backend/public.
 * À lancer après modification de ces fichiers : node scripts/copy-import-static.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const fe = path.join(root, '..', 'frontend');
const files = ['import-likes.html', 'import-likes.js', 'style.css'];

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
