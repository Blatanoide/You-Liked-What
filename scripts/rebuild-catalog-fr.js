/**
 * 1. Garde uniquement les morceaux avec preview dans tracks.seed.json
 * 2. Ajoute data/tracks-francais-import.txt
 * 3. Résout les previews (iTunes + Deezer)
 * 4. Retire ceux toujours sans preview
 *
 * Usage: node scripts/rebuild-catalog-fr.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
const importPath = path.join(__dirname, '..', 'data', 'tracks-francais-import.txt');
const noPreviewPath = path.join(__dirname, '..', 'data', 'tracks-no-preview.txt');

const HTTP_OPTS = {
  timeout: 10000,
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

function key(artist, title) {
  return `${stripAccents(artist).toLowerCase().trim()}|${stripAccents(title).toLowerCase().trim()}`;
}

function normalize(text) {
  return stripAccents(String(text || '').toLowerCase())
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLine(line) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;
  const sep = raw.indexOf(' - ');
  if (sep <= 0) return null;
  const artist = raw.slice(0, sep).trim();
  const title = raw.slice(sep + 3).trim();
  if (!artist || !title) return null;
  return { artist, title };
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

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  let list = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const before = list.length;
  list = list.filter((t) => t.preview_url);
  console.log(`Retirés sans preview (ancien catalogue): ${before - list.length}`);

  const importText = fs.readFileSync(importPath, 'utf8');
  const seen = new Set(list.map((t) => key(t.artist, t.title)));
  let added = 0;
  let dup = 0;

  for (const line of importText.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const k = key(parsed.artist, parsed.title);
    if (seen.has(k)) {
      dup += 1;
      continue;
    }
    seen.add(k);
    list.push({ artist: parsed.artist, title: parsed.title });
    added += 1;
  }
  console.log(`Nouveaux titres FR ajoutés: ${added} (doublons ignorés: ${dup})`);

  const missing = list.filter((t) => !t.preview_url);
  const CONCURRENCY = Number(process.env.PREVIEW_CONCURRENCY) || 8;
  console.log(`Résolution preview pour ${missing.length} morceaux…`);

  let resolved = 0;
  await mapPool(missing, CONCURRENCY, async (t, idx) => {
    const url = await resolvePreview(t.artist, t.title);
    if (url) {
      t.preview_url = url;
      resolved += 1;
    }
    if ((idx + 1) % 25 === 0 || idx + 1 === missing.length) {
      process.stdout.write(`\r  ${idx + 1}/${missing.length} traités, ${resolved} previews trouvées`);
    }
  });
  console.log('');

  const rejected = list.filter((t) => !t.preview_url);
  list = list.filter((t) => t.preview_url);

  fs.writeFileSync(seedPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    noPreviewPath,
    rejected.map((t) => `${t.artist} - ${t.title}`).join('\n') + (rejected.length ? '\n' : ''),
    'utf8'
  );

  console.log(`Catalogue final: ${list.length} morceaux (100% avec preview)`);
  console.log(`Exclus (pas de preview): ${rejected.length} → ${noPreviewPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
