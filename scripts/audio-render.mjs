// Offline render of the engine voices (OfflineAudioContext in headless Chromium) -> WAV files + a spectrogram PNG for each engine.
//   node scripts/audio-render.mjs [outDir=build-output/audio]      (needs `vite` dev server on :4181:  npx vite --port 4181)
import { launch } from './browser.mjs';
import fs from 'node:fs';
const out = process.argv[2] || 'build-output/audio'; fs.mkdirSync(out, { recursive: true });
const b = await launch();
const ids = ['syn-v6', 'syn-v8', 'syn-v10', 'syn-v12'];
for (const id of ids) {
  const p = await b.newPage({ viewport: { width: 1000, height: 520 } });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message)); p.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); });
  await p.goto('http://localhost:4181/'); await p.waitForTimeout(1200);
  const r = await p.evaluate(async (id) => {
    const { EngineVoice } = await import('/src/audio/EngineBank.js'); const { buildSynthEngine, SYNTH_SPECS } = await import('/src/audio/EngineSynth.js');
    const SR = 44100, T = 11, ctx = new OfflineAudioContext(1, SR * T, SR);
    const eng = buildSynthEngine(ctx, SYNTH_SPECS.find((s) => s.id === id));
    const master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    const v = new EngineVoice(ctx, master, eng, {});
    // timeline: 0-1 s idle, 1-7 s full-throttle pull 4200 -> 15000 rpm (one shift dip at 15000 -> 11500 at 4 s), 7-8 s hold, 8-10.5 s lift-off falling to 7500, 10.5-11 s idle
    const rpmAt = (t) => (t < 1 ? 4200 : t < 4 ? 4200 + (15000 - 4200) * ((t - 1) / 3) : t < 4.15 ? 15000 - (15000 - 11500) * ((t - 4) / 0.15) : t < 7 ? 11500 + 3500 * ((t - 4.15) / 2.85) : t < 8 ? 15000 : t < 10.5 ? 15000 - 7500 * ((t - 8) / 2.5) ** 0.8 : 4200 + 3300 * Math.max(0, 1 - (t - 10.5) / 0.5));
    const thrAt = (t) => (t < 1 ? 0 : t < 8 ? 1 : t < 10.5 ? 0 : 0);
    for (let t = 0; t < T; t += 0.02) v.set(rpmAt(t), thrAt(t), 1.7, t, { limiter: t > 7.4 && t < 8, shifting: t > 4 && t < 4.15 });
    const buf = await ctx.startRendering(); const d = buf.getChannelData(0);
    // spectrogram
    const N = 2048, hop = 512, cols = Math.floor((d.length - N) / hop), H = 400, W = 1000, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    const an = (re, im) => { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } } for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const u = i + k, w = u + len / 2, vr = re[w] * cr - im[w] * ci, vi = re[w] * ci + im[w] * cr; re[w] = re[u] - vr; im[w] = im[u] - vi; re[u] += vr; im[u] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } };
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const maxF = 8000, re = new Float32Array(N), im = new Float32Array(N);
    for (let c = 0; c < W; c++) { const s = Math.floor(c / W * cols) * hop; for (let i = 0; i < N; i++) { re[i] = d[s + i] * win[i]; im[i] = 0; } an(re, im);
      for (let y = 0; y < H; y++) { const f = (1 - y / H) * maxF, k = Math.round(f / SR * N); const m = Math.hypot(re[k], im[k]) / N; const db = 20 * Math.log10(m + 1e-9); const v = Math.max(0, Math.min(1, (db + 92) / 50)); g.fillStyle = `hsl(${260 - v * 260},90%,${v * 55}%)`; g.fillRect(c, y, 1, 1); } }
    g.fillStyle = '#fff'; g.font = '12px sans-serif'; for (let f = 0; f <= maxF; f += 1000) g.fillText(f / 1000 + 'k', 4, H - f / maxF * H + 12);
    const png = cv.toDataURL('image/png').split(',')[1];
    let peak = 0, ss = 0, nan = 0; for (const x of d) { if (!Number.isFinite(x)) nan++; peak = Math.max(peak, Math.abs(x)); ss += x * x; }
    // 16-bit wav
    const pcm = new Int16Array(d.length); for (let i = 0; i < d.length; i++) pcm[i] = Math.max(-1, Math.min(1, d[i])) * 32767 | 0;
    let bin = ''; const u8 = new Uint8Array(pcm.buffer); for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return { peak, rms: Math.sqrt(ss / d.length), nan, wav: btoa(bin), SR, png };
  }, id);
  const wavHead = Buffer.alloc(44); const pcm = Buffer.from(r.wav, 'base64');
  wavHead.write('RIFF', 0); wavHead.writeUInt32LE(36 + pcm.length, 4); wavHead.write('WAVEfmt ', 8); wavHead.writeUInt32LE(16, 16); wavHead.writeUInt16LE(1, 20); wavHead.writeUInt16LE(1, 22); wavHead.writeUInt32LE(r.SR, 24); wavHead.writeUInt32LE(r.SR * 2, 28); wavHead.writeUInt16LE(2, 32); wavHead.writeUInt16LE(16, 34); wavHead.write('data', 36); wavHead.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(`${out}/${id}-sweep.wav`, Buffer.concat([wavHead, pcm]));
  fs.writeFileSync(`${out}/${id}-spectrogram.png`, Buffer.from(r.png, 'base64'));
  console.log(id, `peak ${r.peak.toFixed(2)} rms ${r.rms.toFixed(3)} NaN ${r.nan}`);
  await p.close();
}
await b.close();
