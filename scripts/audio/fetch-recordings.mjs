// Downloads the real F1 recordings (Wikimedia Commons, CC BY-SA 3.0, author "Edvvc") used for the engine bank.
//   node scripts/audio/fetch-recordings.mjs [dir=.audio-src]     then:   node scripts/audio/build-bank.mjs <dir>
// Polite on purpose: one file at a time, honours Retry-After (Wikimedia rate-limits shared IPs hard).
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES } from './build-bank.mjs';

const dir = process.argv[2] || '.audio-src';
mkdirSync(dir, { recursive: true });
const UA = 'ApexGP-simulator-build/1.0 (https://github.com/makys0/races; asset fetch, one request per file)';
const API = 'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata&format=json&titles=';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    if (r.status === 429 || r.status === 503) { const ra = Number(r.headers.get('retry-after')) || 600; console.log(`  ${r.status}, waiting ${ra + 60}s (Retry-After)`); await wait((ra + 60) * 1000); continue; }
    throw new Error(url + ' -> ' + r.status);
  }
  throw new Error('gave up: ' + url);
}
const meta = [];
for (const s of SOURCES) {
  const out = join(dir, s.file);
  if (existsSync(out)) { console.log('have', s.file); continue; }
  const info = await (await get(API + encodeURIComponent(s.commons))).json();
  const ii = Object.values(info.query.pages)[0].imageinfo[0], lic = ii.extmetadata.LicenseShortName.value;
  if (!/^CC BY(-SA)? |^CC0|^Public domain/i.test(lic)) { console.log('skip, unexpected licence', s.commons, lic); continue; }
  const buf = Buffer.from(await (await get(ii.url)).arrayBuffer());
  if (buf.subarray(0, 4).toString() !== 'OggS') throw new Error('not an Ogg file: ' + s.file);
  writeFileSync(out, buf); meta.push({ file: s.file, commons: s.commons, licence: lic, url: ii.url });
  console.log('ok  ', s.file, buf.length, 'bytes', lic);
  await wait(20000);
}
