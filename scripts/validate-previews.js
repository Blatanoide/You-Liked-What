/**
 * Vérifie les preview_url du seed et remplace les liens expirés par iTunes ou Deezer frais.
 * Usage: node scripts/validate-previews.js
 */

const fs = require('fs');
const path = require('path');
const {
  isPreviewUrlValid,
  resolvePreviewUrl,
  searchDeezerPreview,
  clearPreviewCache,
} = require('../services/previewResolver');

const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
const CONCURRENCY = Number(process.env.PREVIEW_CONCURRENCY) || 3;
const DELAY_MS = Number(process.env.PREVIEW_DELAY_MS) || 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshTrackPreview(track) {
  const current = track.preview_url ? String(track.preview_url).trim() : '';
  if (current && (await isPreviewUrlValid(current))) {
    return 'kept';
  }

  let fresh = await resolvePreviewUrl(track.artist, track.title);
  if (fresh) {
    track.preview_url = fresh;
    return fresh.includes('itunes') || fresh.includes('mzstatic') ? 'itunes' : 'deezer';
  }

  try {
    fresh = await searchDeezerPreview(track.artist, track.title);
  } catch (_) {}
  if (fresh && (await isPreviewUrlValid(fresh))) {
    track.preview_url = fresh;
    return 'deezer';
  }

  delete track.preview_url;
  return 'removed';
}

async function main() {
  clearPreviewCache();
  const list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const stats = { kept: 0, itunes: 0, deezer: 0, removed: 0 };

  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const i = idx;
      idx += 1;
      const track = list[i];
      const result = await refreshTrackPreview(track);
      stats[result] = (stats[result] || 0) + 1;
      if ((i + 1) % 25 === 0 || i + 1 === list.length) {
        process.stdout.write(
          `\r  ${i + 1}/${list.length} — ok ${stats.kept + stats.itunes + stats.deezer}, retirés ${stats.removed}`
        );
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, () => worker()));
  console.log('');

  const playable = list.filter((t) => t.preview_url && String(t.preview_url).trim());
  fs.writeFileSync(seedPath, `${JSON.stringify(playable, null, 2)}\n`, 'utf8');
  console.log(
    `Catalogue: ${playable.length} morceaux — conservés ${stats.kept}, iTunes ${stats.itunes}, Deezer ${stats.deezer}, retirés ${stats.removed}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
