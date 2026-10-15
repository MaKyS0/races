// Dev tool: simulated-annealing "closer". Perturbs corner angles / straight lengths of a circuit definition so the
// loop closes with minimal straight adjustment and without self-overlap, then writes the numbers back to the file.
import fs from 'node:fs';
import { buildTurtle } from '../src/track/Turtle.js';
import { makeRng } from '../src/core/math.js';

const id = process.argv[2];
const iters = +(process.argv[3] || 40000);
const seed = +(process.argv[4] || 1);
const file = new URL(`../src/track/circuits/${id}.js`, import.meta.url);
const def = (await import(file.href + '?t=' + Date.now())).default;
const rnd = makeRng(seed);
const base = def.segments.map((s) => s.slice());
const target = def.lengthM || 0;
const runoff = def.runoff || { w: 10, grass: 8 };
const roMax = Math.max((runoff.w || 0) + (runoff.grass || 0), ...(def.runoffZones || []).map((z) => (z[3].w || 0) + (z[3].grass || 0)));
const need = (def.width || 12) + 2 * (roMax * 0.8 + 2.1) + 8 + (def.clearanceExtra || 0);

function evaluate(segs) {
  const g = buildTurtle(segs, 4);
  const pts = g.pts; // [x,z,psi]...
  // coarse resample every ~16 m
  const xs = [], zs = [], cs = [];
  let acc = 0, last = 0;
  for (let i = 1; i < pts.length / 3; i++) {
    acc += Math.hypot(pts[i * 3] - pts[(i - 1) * 3], pts[i * 3 + 1] - pts[(i - 1) * 3 + 1]);
    if (acc - last >= 16) { xs.push(pts[i * 3]); zs.push(pts[i * 3 + 1]); cs.push(acc); last = acc; }
  }
  let overlap = 0;
  const Ltot = acc;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    const ds = Math.min(cs[j] - cs[i], Ltot - (cs[j] - cs[i]));
    if (ds < 220) continue;
    const d = Math.hypot(xs[i] - xs[j], zs[i] - zs[j]);
    if (d < need) overlap += (need - d) * (need - d);
  }
  let straightPen = 0;
  const s0 = segs.filter((s) => s[0] === 'S');
  for (let k = 0; k < g.lens.length; k++) { const r = g.lens[k] / s0[k][1] - 1; straightPen += r * r; }
  let minPen = 0;
  for (let k = 0; k < g.lens.length; k++) if (g.lens[k] < 18) minPen += (18 - g.lens[k]) ** 2;
  return { g, overlap, straightPen, minPen, length: g.length };
}
function cost(segs) {
  const e = evaluate(segs);
  let dev = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i][0] === 'C') { const a0 = Math.abs(base[i][2]), a = Math.abs(segs[i][2]); const r = a / a0 - 1; dev += r * r * (segs[i][3] && segs[i][3].free ? 3 : 1); }
    else { const r = segs[i][1] / base[i][1] - 1; dev += r * r * 0.4; }
  }
  const lenPen = target ? ((e.length - target) / target) ** 2 * 400 : 0;
  return 60 * e.straightPen + 0.02 * e.overlap + 0.5 * e.minPen + 1.2 * dev + lenPen;
}
let cur = base.map((s) => s.slice());
let curC = cost(cur), best = cur.map((s) => s.slice()), bestC = curC;
const free = base.findIndex((s) => s[0] === 'C' && s[3] && s[3].free);
for (let it = 0; it < iters; it++) {
  const T = 0.6 * (1 - it / iters) + 0.002;
  const cand = cur.map((s) => s.slice());
  const k = 1 + (rnd() < 0.3 ? 1 : 0);
  for (let q = 0; q < k; q++) {
    const i = Math.floor(rnd() * cand.length);
    if (i === free) continue;
    if (cand[i][0] === 'C') {
      const a0 = Math.abs(base[i][2]);
      let a = Math.abs(cand[i][2]) * (1 + rnd.gauss() * 0.06);
      a = Math.min(Math.max(a, a0 * 0.6), a0 * 1.6);
      cand[i][2] = Math.sign(base[i][2]) * a;
    } else {
      const l0 = base[i][1];
      cand[i][1] = Math.min(Math.max(cand[i][1] * (1 + rnd.gauss() * 0.08), l0 * 0.55), l0 * 1.7);
    }
  }
  const c = cost(cand);
  if (c < curC || rnd() < Math.exp((curC - c) / T)) { cur = cand; curC = c; if (c < bestC) { best = cand.map((s) => s.slice()); bestC = c; } }
}
const e = evaluate(best);
console.log(`${id}: cost=${bestC.toFixed(3)} length=${e.length.toFixed(0)} overlap=${e.overlap.toFixed(0)} straightPen=${e.straightPen.toFixed(4)} gap=${e.g.gap.toFixed(1)} minRel=${e.g.minRel.toFixed(2)} maxRel=${e.g.maxRel.toFixed(2)}`);
// write back
const fmt = (s) => {
  if (s[0] === 'S') return `S(${Math.round(s[1])})`;
  const a = Math.round(Math.abs(s[2]) * 10) / 10, r = Math.round(s[1] * 10) / 10;
  const o = s[3] ? ', ' + JSON.stringify(s[3]).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ').replace('{', '{ ').replace('}', ' }') : '';
  return `${s[2] >= 0 ? 'L' : 'R'}(${r}, ${a}${o})`;
};
// keep one-per-line, preserving original comments when possible
let text = fs.readFileSync(file, 'utf8');
const a = text.indexOf('segments: [');
const b = text.indexOf('\n  ],', a);
const lines = best.map((s) => '    ' + fmt(s) + ',').join('\n');
text = text.slice(0, a) + 'segments: [\n' + lines + text.slice(b);
if (process.argv.includes('--write')) { fs.writeFileSync(file, text); console.log('written'); }
