/**
 * Fusionne data/tracks-import.txt dans data/tracks.seed.json (sans doublons).
 * Usage: node scripts/merge-tracks.js
 */

const fs = require('fs');
const path = require('path');

const seedPath = path.join(__dirname, '..', 'data', 'tracks.seed.json');
const importPath = path.join(__dirname, '..', 'data', 'tracks-import.txt');

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function key(artist, title) {
  return `${stripAccents(artist).toLowerCase().trim()}|${stripAccents(title).toLowerCase().trim()}`;
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

function main() {
  const existing = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const importText = fs.readFileSync(importPath, 'utf8');
  const lines = importText.split(/\r?\n/);

  const seen = new Set(existing.map((t) => key(t.artist, t.title)));
  let added = 0;
  let skippedDup = 0;
  let skippedBad = 0;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) {
      if (line.trim()) skippedBad += 1;
      continue;
    }
    const k = key(parsed.artist, parsed.title);
    if (seen.has(k)) {
      skippedDup += 1;
      continue;
    }
    seen.add(k);
    existing.push({ artist: parsed.artist, title: parsed.title });
    added += 1;
  }

  fs.writeFileSync(seedPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  console.log(`Catalogue: ${existing.length} morceaux`);
  console.log(`Ajoutés: ${added}`);
  console.log(`Doublons ignorés: ${skippedDup}`);
  if (skippedBad) console.log(`Lignes invalides: ${skippedBad}`);
}

main();
