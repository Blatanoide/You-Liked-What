/**
 * Remplit preview_url dans data/tracks.seed.json via iTunes puis Deezer.
 * Usage: node scripts/seed-previews.js
 */

const fs = require('fs');
const path = require('path');
const { resolvePreviewUrl, mapPool } = require('../services/previewResolver');

const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');

async function main() {
  const list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const missing = list.filter((t) => !t.preview_url);
  const CONCURRENCY = Number(process.env.PREVIEW_CONCURRENCY) || 6;

  console.log(`Previews manquantes: ${missing.length}/${list.length}`);

  await mapPool(missing, CONCURRENCY, async (t) => {
    process.stdout.write(`… ${t.artist} — ${t.title}\n`);
    const url = await resolvePreviewUrl(t.artist, t.title);
    if (url) {
      t.preview_url = url;
      process.stdout.write(`  OK\n`);
    } else {
      process.stdout.write(`  FAIL\n`);
    }
    await new Promise((r) => setTimeout(r, 80));
  });

  const playable = list.filter((t) => t.preview_url);
  fs.writeFileSync(seedPath, `${JSON.stringify(playable, null, 2)}\n`, 'utf8');
  console.log(`Previews: ${playable.length}/${list.length} (${list.length - playable.length} sans extrait)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
