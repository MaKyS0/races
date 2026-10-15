// Dev tool: print geometry stats of every circuit and write an SVG overview for each.
import fs from 'node:fs';
import { Track } from '../src/track/TrackSystem.js';
const ids = process.argv.slice(2);
const dir = new URL('../src/track/circuits/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'helpers.js' && f !== 'index.js');
fs.mkdirSync(new URL('../build-output/', import.meta.url), { recursive: true });
for (const f of files) {
  const id = f.replace('.js', '');
  if (ids.length && !ids.includes(id)) continue;
  const def = (await import(new URL(f, dir).href)).default;
  let t;
  try { t = new Track(def); } catch (e) { console.log(id, 'ERROR', e.message); continue; }
  const b = t.bounds;
  const W = 900, pad = 40;
  const sc = (W - 2 * pad) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const X = (x) => pad + (x - b.minX) * sc, Y = (z) => W - pad - (z - b.minZ) * sc;
  let d = '', dl = '';
  for (let i = 0; i < t.N; i++) { d += (i ? 'L' : 'M') + X(t.x[i]).toFixed(1) + ' ' + Y(t.z[i]).toFixed(1); dl += (i ? 'L' : 'M') + X(t.lineX[i]).toFixed(1) + ' ' + Y(t.lineZ[i]).toFixed(1); }
  const edge = (side) => { let e = ''; for (let i = 0; i < t.N; i++) { const n = side * (side > 0 ? t.wl[i] : t.wr[i]); const x = t.x[i] + Math.cos(t.psi[i]) * n, z = t.z[i] - Math.sin(t.psi[i]) * n; e += (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(z).toFixed(1); } return e; };
  const corners = t.cornerList.map((c) => { const i = Math.round(c.apex / t.ds); return `<text x="${X(t.x[i]) + 6}" y="${Y(t.z[i]) - 6}" font-size="11" fill="#444">${c.n}</text>`; }).join('');
  const i0 = 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" style="background:#fff"><path d="${edge(1)}" stroke="#999" fill="none"/><path d="${edge(-1)}" stroke="#999" fill="none"/><path d="${d}" stroke="#222" fill="none" stroke-width="1" /><path d="${dl}" stroke="#e33" fill="none" stroke-width="1"/><circle cx="${X(t.x[i0])}" cy="${Y(t.z[i0])}" r="6" fill="#0a0"/>${corners}</svg>`;
  fs.writeFileSync(new URL(`../build-output/${id}.svg`, import.meta.url), svg);
  const r = t.report;
  console.log(`${id.padEnd(12)} length=${t.length.toFixed(0)}m N=${t.N} corners=${t.cornerList.length} gap=${t.closureGap.toFixed(0)}m minStraight=${t.minStraight.toFixed(0)} headRes=${t.headingResidual.toFixed(2)} minR=${r.minRadius.toFixed(1)} clearance=${r.minClearance.toFixed(0)} ok=${r.ok} ${r.errors.join(' | ')}`);
}
