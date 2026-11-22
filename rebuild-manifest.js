// Scans ./recordings/<folder>/*.mp3.enc and writes manifest.json.
// Usage: npm run rebuild   (run from the repo root after adding/removing recordings)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const recordingsDir = path.join(root, 'recordings');
const natural = new Intl.Collator(undefined, { numeric: true });

function prettify(name) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

if (!fs.existsSync(recordingsDir)) {
  console.error('No ./recordings directory found');
  process.exit(1);
}

const folders = [];
for (const name of fs.readdirSync(recordingsDir).sort(natural.compare)) {
  const dir = path.join(recordingsDir, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const files = fs.readdirSync(dir)
    .filter(f => /\.mp3\.enc$/i.test(f))
    .map(f => f.replace(/\.enc$/i, ''))
    .sort(natural.compare);
  if (files.length === 0) {
    console.warn(`Skipping "${name}": no .mp3.enc tracks found`);
    continue;
  }
  folders.push({ name, title: prettify(name), files });
}
folders.sort((a, b) => a.title.localeCompare(b.title));

const out = path.join(root, 'manifest.json');
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), folders }, null, 2));
const trackCount = folders.reduce((s, f) => s + f.files.length, 0);
console.log(`Wrote manifest.json: ${folders.length} folders, ${trackCount} tracks`);
