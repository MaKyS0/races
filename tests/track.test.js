import { describe, it, expect } from 'vitest';
import { CIRCUITS, getTrack } from '../src/track/circuits/index.js';
import { SURF } from '../src/track/TrackSystem.js';
import { Locator } from '../src/track/TrackSystem.js';

describe('circuits', () => {
  for (const def of CIRCUITS) {
    describe(def.name, () => {
      const t = getTrack(def.id);
      it('is a closed, valid, self-avoiding circuit of the intended length', () => {
        expect(t.report.errors).toEqual([]);
        expect(t.closureResidual).toBeLessThan(1.5);
        expect(Math.abs(t.length - def.lengthM) / def.lengthM).toBeLessThan(0.06);
        expect(t.cornerList.length).toBeGreaterThan(8);
        expect(Math.abs(t.psi[0] - t.psi[t.N - 1])).toBeLessThan(0.05);
      });
      it('has consistent surface / wall geometry', () => {
        for (let i = 0; i < t.N; i += 37) {
          expect(t.surfaceAt(i, 0)).toBe(SURF.ASPHALT);
          expect(t.wallL[i]).toBeGreaterThan(t.wl[i]); expect(t.wallR[i]).toBeGreaterThan(t.wr[i]);
          expect(Number.isFinite(t.y[i]) && Number.isFinite(t.k[i]) && Number.isFinite(t.line[i])).toBe(true);
          expect(Math.abs(t.line[i])).toBeLessThan(Math.max(t.wl[i], t.wr[i]));
        }
        expect(t.surfaceAt(100, t.wl[100] + 0.5 + 100)).toBe(SURF.GRASS);
      });
      it('locates a car from its world position (round trip of pointAt)', () => {
        const loc = new Locator(), out = { x: 0, y: 0, z: 0, psi: 0 };
        for (let s = 10; s < t.length; s += 311) {
          t.pointAt(s, 2.5, out); t.globalLocate(loc, out.x, out.z);
          expect(Math.abs(t.delta(s, loc.s))).toBeLessThan(0.3); expect(loc.n).toBeCloseTo(2.5, 0);
          t.pointAt(s + 5, -1.5, out); t.locate(loc, out.x, out.z);
          expect(Math.abs(t.delta(s + 5, loc.s))).toBeLessThan(0.3);
        }
      });
      it('has a starting grid on the straight, pit lane + boxes and DRS zones', () => {
        const a = t.gridSlot(0), b = t.gridSlot(19);
        expect(t.length - b.s).toBeLessThan(t.length * 0.1);
        expect(Math.abs(a.n)).toBeLessThan(t.wl[0]); expect(Math.abs(b.n)).toBeLessThan(t.wl[0]);
        expect(t.pitBoxes.length).toBe(20); expect(t.pitLength).toBeGreaterThan(250);
        expect(t.drsZones.length).toBeGreaterThan(0);
        for (const z of t.drsZones) expect(z.length).toBeGreaterThan(100);
        expect(t.racingLineTime ?? 1).toBeGreaterThan(0);
      });
      it('racing line stays on the track', () => {
        for (let i = 0; i < t.N; i += 11) expect(Math.abs(t.line[i])).toBeLessThan(Math.min(t.wl[i], t.wr[i]) + 0.1);
      });
    });
  }
  it('circuits differ in character (length, elevation, corner count)', () => {
    const info = CIRCUITS.map((d) => { const t = getTrack(d.id); return { len: Math.round(t.length / 100), elev: Math.round(Math.max(...t.y) - Math.min(...t.y)), c: t.cornerList.length }; });
    expect(new Set(info.map((x) => x.len)).size).toBeGreaterThan(4);
    expect(Math.max(...info.map((x) => x.elev))).toBeGreaterThan(40);
    expect(Math.min(...info.map((x) => x.elev))).toBeLessThan(8);
  });
});
