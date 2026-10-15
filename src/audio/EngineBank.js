// EngineBank: real F1 engine recordings (see public/audio/CREDITS.txt) played as rpm-pitched, cross-faded loop layers.
// Each engine is a handful of seamless loops cut from real recordings at different rpm; at run time the two loops that
// bracket the current rpm are pitch-shifted by rpm / loopRpm and cross-faded (equal power). Throttle opens a low-pass (an
// off-throttle engine is dark and quiet), the limiter chops the amplitude, doppler is just a change of the rpm ratio.
import { clamp } from '../core/math.js';

/** download + decode every engine in <base>/manifest.json. Resolves to { engines: Map(id -> engine) } or null when unavailable. */
export async function loadEngineBank(ctx, base = 'audio/') {
  let man;
  try { const r = await fetch(base + 'manifest.json'); if (!r.ok) return null; man = await r.json(); } catch (e) { return null; }
  const engines = new Map();
  await Promise.all(man.engines.map(async (e) => {
    try {
      const r = await fetch(base + e.file); if (!r.ok) return;
      const ab = await r.arrayBuffer();
      const whole = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });   // callback form: old WebKit has no promise
      const src = whole.getChannelData(0);
      const layers = e.layers.map((l) => { const b = ctx.createBuffer(1, l.length, whole.sampleRate); b.getChannelData(0).set(src.subarray(l.start, l.start + l.length)); return { rpm: l.rpm, buffer: b }; });
      if (layers.length) engines.set(e.id, { id: e.id, label: e.label, cyl: e.cyl, layers });
    } catch (err) { /* this engine stays unavailable */ }
  }));
  return engines.size ? { engines } : null;
}

/** the two loop layers that bracket rpm x and their equal-power weights (log-rpm interpolation); layers sorted by rpm */
export function layerMix(L, x) {
  const n = L.length;
  if (n === 1 || x <= L[0].rpm) return { a: 0, b: 0, wa: 1, wb: 0 };
  if (x >= L[n - 1].rpm) return { a: n - 1, b: n - 1, wa: 1, wb: 0 };
  let a = 0; while (a + 1 < n - 1 && L[a + 1].rpm <= x) a++;
  const b = a + 1, t = (Math.log(x) - Math.log(L[a].rpm)) / (Math.log(L[b].rpm) - Math.log(L[a].rpm));
  return { a, b, wa: Math.cos(t * Math.PI / 2), wb: Math.sin(t * Math.PI / 2) };
}

/** one playing engine (player or opponent): nodes are created lazily per layer and stopped when a layer is silent */
export class EngineVoice {
  constructor(ctx, out, engine, { pan = false, limiterLfo = false } = {}) {
    this.ctx = ctx; this.eng = engine; this.dead = false;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 3000; this.lp.Q.value = 0.5;
    this.chop = ctx.createGain(); this.amp = ctx.createGain(); this.amp.gain.value = 0;
    this.lp.connect(this.chop); this.chop.connect(this.amp);
    this.pan = pan && ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.pan) { this.amp.connect(this.pan); this.pan.connect(out); } else this.amp.connect(out);
    this.lfo = null;
    if (limiterLfo) {   // fuel-cut limiter: amplitude chopped by a square wave (base gain 0.7 +/- lfoG while limiting)
      this.lfo = ctx.createOscillator(); this.lfo.type = 'square'; this.lfo.frequency.value = 26;
      this.lfoG = ctx.createGain(); this.lfoG.gain.value = 0; this.lfo.connect(this.lfoG); this.lfoG.connect(this.chop.gain); this.lfo.start();
    }
    this.slots = engine.layers.map(() => null);
    this.idleT = engine.layers.map(() => 0);
    this.limiter = false;
  }
  _ensure(i, now) {
    let s = this.slots[i];
    if (s) return s;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.eng.layers[i].buffer; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0; src.connect(g); g.connect(this.lp);
    src.start(0, Math.random() * src.buffer.duration);
    return (this.slots[i] = { src, g });
  }
  /** rpm: effective (doppler-scaled) rpm; load 0..1 throttle; vol: linear gain; bright: 0..1 distance brightness */
  set(rpm, load, vol, now, { limiter = false, shifting = false, bright = 1 } = {}) {
    if (this.dead) return;
    const L = this.eng.layers, n = L.length;
    const x = clamp(rpm, L[0].rpm * 0.55, L[n - 1].rpm * 1.6);
    const { a, b, wa, wb } = layerMix(L, x);
    for (let i = 0; i < n; i++) {
      const w = i === a ? wa : i === b ? wb : 0;   // (a === b -> wa = 1, wb = 0)
      if (w > 0.002) {
        const s = this._ensure(i, now); this.idleT[i] = 0;
        s.src.playbackRate.setTargetAtTime(x / L[i].rpm, now, 0.03);
        s.g.gain.setTargetAtTime(w, now, 0.03);
      } else if (this.slots[i]) {
        const s = this.slots[i]; s.g.gain.setTargetAtTime(0, now, 0.03);
        if ((this.idleT[i] += 1) > 30) { try { s.src.stop(); s.src.disconnect(); s.g.disconnect(); } catch (e) { /* already stopped */ } this.slots[i] = null; }
      }
    }
    // on-throttle: bright and loud; lift-off: dark, quieter
    const cutoff = (1400 + load * 9000 + clamp(x / 15000, 0, 1) * 2600) * (0.35 + 0.65 * bright);
    this.lp.frequency.setTargetAtTime(cutoff, now, 0.04);
    let g = vol * (0.42 + 0.58 * load);
    if (shifting) g *= 0.6;
    this.amp.gain.setTargetAtTime(g, now, 0.03);
    this.chop.gain.setTargetAtTime(limiter && this.lfo ? 0.68 : 1, now, 0.01);
    if (this.lfo) this.lfoG.gain.setTargetAtTime(limiter ? 0.3 : 0, now, 0.01);
    this.limiter = limiter;
  }
  silence(now) { if (!this.dead) this.amp.gain.setTargetAtTime(0, now, 0.05); }
  dispose() {
    this.dead = true;
    if (this.lfo) { try { this.lfo.stop(); this.lfo.disconnect(); this.lfoG.disconnect(); } catch (e) { /* noop */ } }
    for (const s of this.slots) if (s) { try { s.src.stop(); s.src.disconnect(); s.g.disconnect(); } catch (e) { /* noop */ } }
    try { this.lp.disconnect(); this.chop.disconnect(); this.amp.disconnect(); if (this.pan) this.pan.disconnect(); } catch (e) { /* noop */ }
  }
}
