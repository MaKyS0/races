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
