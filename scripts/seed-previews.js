/**
 * Remplit preview_url dans data/tracks.seed.json via iTunes puis Deezer.
 * Usage: node scripts/seed-previews.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
const HTTP_OPTS = {
  timeout: 8000,
  validateStatus: () => true,
  headers: {
    'User-Agent': 'SoundGuess/1.0 (preview resolver)',
    Accept: 'application/json',
  },
};

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalize(text) {
  return stripAccents(String(text || '').toLowerCase())
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fromItunes(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`);
  const { data } = await axios.get(
    `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=8`,
    HTTP_OPTS
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  const normTitle = normalize(title);
  const pick =
    results.find((r) => r.previewUrl && normalize(r.trackName) === normTitle) ||
    results.find((r) => r.previewUrl) ||
    null;
  return pick?.previewUrl || null;
}

async function fromDeezer(artist, title) {
  const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
  const { data } = await axios.get(`https://api.deezer.com/search?q=${q}&limit=8`, HTTP_OPTS);
  const results = Array.isArray(data?.data) ? data.data : [];
  const normTitle = normalize(title);
  const normArtist = normalize(artist);
  const pick =
    results.find(
      (r) =>
        r.preview &&
        normalize(r.title) === normTitle &&
        normalize(r.artist?.name || '') === normArtist
    ) ||
    results.find(
      (r) => r.preview && normalize(r.title) === normTitle && normalize(r.artist?.name || '').includes(normArtist)
    ) ||
    results.find((r) => r.preview) ||
    null;
  return pick?.preview || null;
}

async function resolvePreview(artist, title) {
  try {
    const it = await fromItunes(artist, title);
    if (it) return it;
  } catch (_) {}
  try {
    const dz = await fromDeezer(artist, title);
    if (dz) return dz;
  } catch (_) {}
  return null;
}

async function main() {
  const list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  let ok = 0;
  for (const t of list) {
    if (t.preview_url) {
      ok += 1;
      continue;
    }
    process.stdout.write(`… ${t.artist} — ${t.title}\n`);
    const url = await resolvePreview(t.artist, t.title);
    if (url) {
      t.preview_url = url;
      ok += 1;
      process.stdout.write(`  OK\n`);
    } else {
      process.stdout.write(`  FAIL\n`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  fs.writeFileSync(seedPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  console.log(`Previews: ${ok}/${list.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
