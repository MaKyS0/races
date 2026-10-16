import { describe, it, expect } from 'vitest';
import { layerMix } from '../src/audio/EngineBank.js';

const L = [5000, 7000, 9500, 12500].map((rpm) => ({ rpm }));

describe('engine sample bank – layer mixing', () => {
  it('uses a single layer below / above the recorded range', () => {
    expect(layerMix(L, 3000)).toEqual({ a: 0, b: 0, wa: 1, wb: 0 });
    expect(layerMix(L, 15000)).toEqual({ a: 3, b: 3, wa: 1, wb: 0 });
  });
  it('is exactly one layer on a layer rpm and cross-fades between layers with constant power', () => {
    const m0 = layerMix(L, 7000); expect(m0.wa + m0.wb).toBeGreaterThan(0.99);
    let prev = -1;
    for (let x = 5100; x < 12400; x += 100) {
      const m = layerMix(L, x);
      expect(L[m.a].rpm).toBeLessThanOrEqual(x); expect(L[m.b].rpm).toBeGreaterThanOrEqual(x);
      expect(m.wa ** 2 + m.wb ** 2).toBeCloseTo(1, 6);
      expect(m.a * 10 + m.wb).toBeGreaterThanOrEqual(prev - 1e-9);        // moves monotonically up the layers
      prev = m.a * 10 + m.wb;
    }
  });
  it('a single-layer bank never goes out of range', () => {
    expect(layerMix([{ rpm: 8000 }], 12000)).toEqual({ a: 0, b: 0, wa: 1, wb: 0 });
  });
});

import { trackPitch, SR } from '../scripts/audio/build-bank.mjs';

describe('engine bank build tool – firing-frequency tracker', () => {
  it('recovers the rpm of an accelerating V8-like harmonic signal within 3 %', () => {
    const T = 6, n = SR * T, x = new Float32Array(n); let ph = 0;
    const rpmAt = (t) => 5000 + 8000 * (t / T);
    for (let i = 0; i < n; i++) { const t = i / SR; ph += 2 * Math.PI * (rpmAt(t) / 60 * 4) / SR; let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(h * ph + h * h * 0.3) / Math.pow(h, 0.9); x[i] = v * 0.1 + (Math.random() - 0.5) * 0.05; }
    const tr = trackPitch(x);
    let worst = 0;
    for (let i = 3; i < tr.times.length - 3; i++) { const rpm = tr.f[i] * 60 / 4, truth = rpmAt(tr.times[i]); worst = Math.max(worst, Math.abs(rpm - truth) / truth); }
    expect(worst).toBeLessThan(0.03);
  });
});

import { synthLayer, SYNTH_SPECS, SYNTH_LAYER_RPM } from '../src/audio/EngineSynth.js';
const goertzel = (x, sr, f) => { const w = 2 * Math.PI * f / sr; let c = 0, s = 0; for (let i = 0; i < x.length; i++) { c += x[i] * Math.cos(w * i); s += x[i] * Math.sin(w * i); } return Math.hypot(c, s) / x.length; };

describe('synthesised engine layers', () => {
  for (const spec of SYNTH_SPECS) {
    it(`${spec.id}: the firing frequency dominates at every layer rpm and the loop is seamless`, () => {
      for (const rpm of [SYNTH_LAYER_RPM[0], SYNTH_LAYER_RPM[3], SYNTH_LAYER_RPM[5]]) {
        const l = synthLayer(spec, rpm, true, 1), fire = rpm / 60 * spec.cyl / 2;
        // energy in the first few firing orders vs between them
        let on = 0, off = 0;
        for (let j = 1; j <= 3; j++) on += goertzel(l.data, l.sampleRate, fire * j);
        for (const k of [0.62, 1.37, 2.41]) off += goertzel(l.data, l.sampleRate, fire * k);
        expect(on).toBeGreaterThan(off * 2.5);
        // seamless: the step across the loop point is no bigger than the largest step inside the loop
        let maxStep = 0; for (let i = 1; i < l.data.length; i++) maxStep = Math.max(maxStep, Math.abs(l.data[i] - l.data[i - 1]));
        expect(Math.abs(l.data[0] - l.data[l.data.length - 1])).toBeLessThanOrEqual(maxStep * 1.05);
        // level / finite
        let ss = 0, peak = 0; for (const v of l.data) { expect(Number.isFinite(v)).toBe(true); ss += v * v; peak = Math.max(peak, Math.abs(v)); }
        expect(Math.sqrt(ss / l.data.length)).toBeGreaterThan(0.05); expect(peak).toBeLessThanOrEqual(0.95);
        expect(Math.abs(l.rpm - rpm)).toBeLessThan(1);
      }
    });
  }
  it('is deterministic, and the over-run layer is darker than the throttle-open layer', () => {
    const spec = SYNTH_SPECS[1];
    const a = synthLayer(spec, 9300, true, 3), b = synthLayer(spec, 9300, true, 3);
    expect(Array.from(a.data.slice(0, 50))).toEqual(Array.from(b.data.slice(0, 50)));
    const hi = (l) => { let e = 0, t = 0; for (let f = 200; f < 6000; f += 97) { const g = goertzel(l.data, l.sampleRate, f) ** 2; t += g; if (f > 2500) e += g; } return e / t; };
    expect(hi(synthLayer(spec, 9300, false, 3))).toBeLessThan(hi(a));
  });
});
