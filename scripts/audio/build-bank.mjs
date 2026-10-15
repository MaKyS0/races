// Builds the engine sample bank from real F1 recordings (see public/audio/CREDITS.txt for sources / licence).
//   node scripts/audio/build-bank.mjs <dir with the downloaded .ogg files> [outDir=public/audio]
// For every recording: decode (ffmpeg) -> track the firing frequency -> rpm(t) -> cut short windows at chosen rpm values,
// time-warp each window to constant pitch (the car was accelerating while it was recorded), make it loop seamlessly,
// normalise loudness -> pack all layers of one engine in one 16-bit mono WAV + manifest.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const SR = 32000;
// firing frequency = rpm/60 * cyl/2 (four-stroke)
export const SOURCES = [
  { id: 'v10a', file: 'fw18.ogg',  cyl: 10, label: 'V10 · 1996', title: 'Williams-Renault FW18 (1996)',          commons: 'File:Williams-Renault FW18 (1996).ogg' },
  { id: 'v10b', file: 'rb1.ogg',   cyl: 10, label: 'V10 · 2005', title: 'Red Bull-Cosworth RB1 (2005)',          commons: 'File:Red Bull-Cosworth RB1 (2005).ogg' },
  { id: 'v8a',  file: 'mp423.ogg', cyl: 8,  label: 'V8 · 2008',  title: 'McLaren-Mercedes MP4/23 (2008)',        commons: 'File:McLaren-Mercedes MP4 23 (2008).ogg' },
  { id: 'v8b',  file: 'bgp.ogg',   cyl: 8,  label: 'V8 · 2009',  title: 'Brawn-Mercedes BGP 001 (2009)',         commons: 'File:Brawn-Mercedes BGP 001 (2009).ogg' },
  { id: 'v8c',  file: 'fw32.ogg',  cyl: 8,  label: 'V8 · 2010',  title: 'Williams-Cosworth FW32 (2010)',         commons: 'File:Williams-Cosworth FW32 (2010).ogg' },
  { id: 'v8d',  file: 'str1.ogg',  cyl: 8,  label: 'V8 · 2006',  title: 'Red Bull-Cosworth STR1 (2006)',         commons: 'File:Red-Bull-Cosworth-STR1-2006-David-Coulthard.ogg' },
];

function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
  const b = r.stdout; return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
// ------------------------------------------------------------------ FFT (radix-2, in place)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) {
      const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
      re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
/** firing-frequency track (Hz) per hop: harmonic salience on a log grid + Viterbi continuity */
export function trackPitch(x, { N = 4096, hop = 1024, fMin = 110, fMax = 1700, bins = 260 } = {}) {
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const grid = Array.from({ length: bins }, (_, i) => fMin * Math.pow(fMax / fMin, i / (bins - 1)));
  const frames = []; const times = [];
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(N / 2); for (let i = 0; i < N / 2; i++) mag[i] = Math.log1p(60 * Math.hypot(re[i], im[i]) / N * 8);
    const at = (f) => { const p = f * N / SR; const i = Math.floor(p); if (i + 1 >= N / 2) return 0; const a = p - i; return mag[i] * (1 - a) + mag[i + 1] * a; };
    const sal = new Float32Array(bins);
    for (let b = 0; b < bins; b++) { let v = 0; for (let h = 1; h <= 8; h++) { const f = grid[b] * h; if (f > SR / 2 - 200) break; v += at(f) / Math.sqrt(h); } sal[b] = v; }
    frames.push(sal); times.push((s + N / 2) / SR);
  }
  // Viterbi
  const T = frames.length, cost = new Float32Array(T * bins), from = new Int16Array(T * bins);
  for (let b = 0; b < bins; b++) cost[b] = frames[0][b];
  const maxJump = 14;   // bins per hop (~ one octave = 260*ln2/ln(fMax/fMin)=~71 bins)
  for (let t = 1; t < T; t++) for (let b = 0; b < bins; b++) {
    let best = -1e9, bi = b;
    for (let d = -maxJump; d <= maxJump; d++) { const p = b + d; if (p < 0 || p >= bins) continue; const c = cost[(t - 1) * bins + p] - 0.045 * Math.abs(d); if (c > best) { best = c; bi = p; } }
    cost[t * bins + b] = best + frames[t][b]; from[t * bins + b] = bi;
  }
  let b = 0; for (let i = 1; i < bins; i++) if (cost[(T - 1) * bins + i] > cost[(T - 1) * bins + b]) b = i;
  const f = new Float32Array(T); for (let t = T - 1; t >= 0; t--) { f[t] = grid[b]; b = from[t * bins + b]; }
  const conf = new Float32Array(T); for (let t = 0; t < T; t++) { let m = 0, s = 0; for (let i = 0; i < bins; i++) { m = Math.max(m, frames[t][i]); s += frames[t][i]; } conf[t] = m / (s / bins); }
  return { times, f, conf };
}
const interp = (xs, ys, x) => { if (x <= xs[0]) return ys[0]; if (x >= xs[xs.length - 1]) return ys[ys.length - 1]; let lo = 0, hi = xs.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; } const a = (x - xs[lo]) / (xs[hi] - xs[lo]); return ys[lo] * (1 - a) + ys[hi] * a; };
const smooth = (a, k) => a.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k); j++) { s += a[j]; n++; } return s / n; });

/** cut a window centred on tc, warp it to constant pitch fTarget, return Float32Array (length ~ len seconds) */
function warpWindow(x, tr, tc, len, fTargetOf) {
  const fOf = (t) => interp(tr.times, tr.f, t);
  const f0 = fOf(tc);
  const out = []; let t = tc - len / 2 - 0.05;
  const tEnd = tc + len / 2 + 0.05;
  // read position advances by f0/f(t) per output sample... i.e. slower where pitch is higher -> constant pitch f0
  while (t < tEnd) {
    const i = Math.floor(t * SR); if (i < 1 || i + 2 >= x.length) break;
    const a = t * SR - i; out.push(x[i] * (1 - a) + x[i + 1] * a);
    t += (f0 / fOf(t)) / SR;
  }
  return { data: Float32Array.from(out), f0 };
}
/** make a seamless loop: choose the end point maximising correlation with the start, cross-fade the tail into the head */
function makeLoop(w, f0, targetLen) {
  const d = w.data; const per = SR / f0 * 2 * (f0 > 700 ? 2 : 1);      // ~ engine cycle in samples (2 revolutions = cyl/2 fires...) just a search scale
  const xf = Math.round(0.06 * SR);
  const L0 = Math.min(d.length - xf - 1, Math.round(targetLen * SR));
  let best = -1e9, bestL = L0; const cmpN = Math.round(0.03 * SR);
  for (let L = Math.round(L0 - 0.05 * SR); L <= L0; L++) {
    if (L < xf + cmpN) continue; let c = 0, e1 = 1e-9, e2 = 1e-9;
    for (let i = 0; i < cmpN; i++) { const a = d[L + i - cmpN / 2 | 0] ?? 0, b = d[i + xf] ?? 0; c += a * b; e1 += a * a; e2 += b * b; }
    c /= Math.sqrt(e1 * e2); if (c > best) { best = c; bestL = L; }
  }
  const L = bestL, out = new Float32Array(L);
  for (let i = 0; i < L; i++) out[i] = d[i + xf];
  // tail [L, L+xf) of the source continues sample (L+xf-1) -> blend it into the head
  for (let i = 0; i < xf; i++) { const g = i / xf, a = Math.cos(g * Math.PI / 2), b = Math.sin(g * Math.PI / 2); out[i] = out[i] * b + d[L + xf - xf + i] * a; }
  return { data: out, corr: best };
}
function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); }
function wav16(samples, sr) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

export function buildEngine(src, x, opts = {}) {
  const tr = trackPitch(x); const rpmOf = (f) => f * 60 / (src.cyl / 2);
  const rpm = Array.from(tr.f, rpmOf), sm = smooth(rpm, 2);
  // usable region: where tracking is confident and rpm plausible
  const good = (i) => tr.conf[i] > 3 && sm[i] > 3000 && sm[i] < 20000;
  let lo = Infinity, hi = 0; for (let i = 0; i < sm.length; i++) if (good(i)) { lo = Math.min(lo, sm[i]); hi = Math.max(hi, sm[i]); }
  const nLayers = opts.layers ?? 7, layers = [];
  const trf = { times: tr.times, f: Float32Array.from(sm, (r) => r * (src.cyl / 2) / 60) };
  for (let k = 0; k < nLayers; k++) {
    const target = lo * Math.pow(hi / lo, k / (nLayers - 1));
    // closest confident frame to the target rpm that has a gentle slope
    let bi = -1, bd = 1e9;
    for (let i = 3; i < sm.length - 3; i++) { if (!good(i)) continue; const slope = Math.abs(sm[i + 3] - sm[i - 3]) / 6; const d = Math.abs(Math.log(sm[i] / target)) + slope / 4e5; if (d < bd) { bd = d; bi = i; } }
    if (bi < 0) continue;
    const tc = tr.times[bi];
    const w = warpWindow(x, trf, tc, 0.55);
    if (w.data.length < 0.4 * SR) continue;
    const loop = makeLoop(w, w.f0, 0.5);
    const g = 0.12 / Math.max(1e-6, rms(loop.data)); for (let i = 0; i < loop.data.length; i++) loop.data[i] *= g;
    layers.push({ rpm: Math.round(sm[bi]), tc: +tc.toFixed(2), data: loop.data, corr: +loop.corr.toFixed(2) });
  }
  layers.sort((a, b) => a.rpm - b.rpm);
  return { layers, lo, hi, track: { times: tr.times, rpm: sm, conf: tr.conf } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inDir = process.argv[2], outDir = process.argv[3] || 'public/audio';
  if (!inDir) { console.error('usage: node scripts/audio/build-bank.mjs <dir with .ogg> [outDir]'); process.exit(2); }
  const dbg = process.env.DEBUG_TRACK;
  mkdirSync(join(outDir, 'engines'), { recursive: true });
  const manifest = { version: 1, sampleRate: SR, engines: [] };
  for (const s of SOURCES) {
    const p = join(inDir, s.file); if (!existsSync(p)) { console.log('skip (missing)', s.file); continue; }
    const x = decode(p); const e = buildEngine(s, x);
    if (dbg) { const T = e.track; console.log(s.id, T.times.map((t, i) => `${t.toFixed(1)}:${Math.round(T.rpm[i])}(${T.conf[i].toFixed(1)})`).filter((_, i) => i % 6 === 0).join(' ')); }
    let total = 0; const gap = 64; const offs = [];
    for (const l of e.layers) { offs.push(total); total += l.data.length + gap; }
    const pack = new Float32Array(total); e.layers.forEach((l, i) => pack.set(l.data, offs[i]));
    writeFileSync(join(outDir, 'engines', s.id + '.wav'), wav16(pack, SR));
    manifest.engines.push({ id: s.id, label: s.label, cyl: s.cyl, file: `engines/${s.id}.wav`, layers: e.layers.map((l, i) => ({ rpm: l.rpm, start: offs[i], length: l.data.length })) });
    console.log(s.id, `rpm ${Math.round(e.lo)}..${Math.round(e.hi)}`, e.layers.map((l) => `${l.rpm}@${l.tc}s(c${l.corr})`).join(' '));
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  const built = SOURCES.filter((s) => manifest.engines.some((e) => e.id === s.id));
  writeFileSync(join(outDir, 'CREDITS.txt'), `Engine sounds in this folder are derived from real Formula 1 car recordings published on Wikimedia Commons
by "Edvvc" (https://commons.wikimedia.org/wiki/User:Edvvc), recorded at the Goodwood Festival of Speed, licence
Creative Commons Attribution-ShareAlike 3.0 (https://creativecommons.org/licenses/by-sa/3.0/).

Changes made: short windows were cut out at different engine speeds, time-warped to constant pitch, cross-faded into
seamless loops, loudness-normalised, down-mixed to mono / 32 kHz and packed (engines/*.wav). At run time they are pitch-shifted,
filtered and mixed by the simulator. Because of the ShareAlike term these derived audio files are also available under
CC BY-SA 3.0; the rest of the project is not part of that grant.

${built.map((s) => `  ${s.id.padEnd(5)} ${s.title} - https://commons.wikimedia.org/wiki/${encodeURI(s.commons.replace(/ /g, '_'))}`).join('\n')}
`);
}
