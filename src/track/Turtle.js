// Turtle geometry: a circuit is a list of ['S', length] straights and ['C', radius, signedAngleDeg, {ease,free}] corners
// (positive = left). buildTurtle closes the loop exactly: the "free" corner absorbs the heading error and the
// straights absorb the position error (minimum relative change), so every definition produces a smooth closed ribbon.
import { TAU } from '../core/math.js';

export function integrate(segs, lens, fine = 0.5, keep = true) {
  const pts = keep ? [0, 0, 0] : null;
  let x = 0, z = 0, psi = 0, li = 0, len = 0;
  const dirs = [];
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si];
    if (sg[0] === 'S') {
      const L = lens[li++];
      dirs.push([Math.sin(psi), Math.cos(psi), L]);
      const n = Math.max(1, Math.round(L / fine)), d = L / n;
      const sx = Math.sin(psi) * d, sz = Math.cos(psi) * d;
      for (let k = 0; k < n; k++) { x += sx; z += sz; if (keep) pts.push(x, z, psi); }
      len += L;
    } else {
      const r = sg[1], a = (sg[2] * Math.PI) / 180, opt = sg[3] || {};
      const A = Math.abs(a), sgn = a >= 0 ? 1 : -1;
      const ease = opt.ease === undefined ? 0.25 : opt.ease;
      const Ls = Math.min(ease * A * r, 0.45 * A * r);
      const Lc = A * r - Ls;
      const tot = Ls * 2 + Lc;
      const n = Math.max(2, Math.round(tot / fine)), d = tot / n;
      const norm = A / ((1 / r) * (Ls + Lc));
      for (let k = 0; k < n; k++) {
        const sm = (k + 0.5) * d;
        let cur;
        if (sm < Ls) cur = sm / Ls / r;
        else if (sm > tot - Ls) cur = (tot - sm) / Ls / r;
        else cur = 1 / r;
        const dpsi = sgn * cur * norm * d;
        const pm = psi + dpsi * 0.5;
        x += Math.sin(pm) * d; z += Math.cos(pm) * d;
        psi += dpsi;
        if (keep) pts.push(x, z, psi);
      }
      len += tot;
    }
  }
  return { pts, x, z, dirs, length: len };
}

export function buildTurtle(defSegs, fine = 0.5) {
  const segs = defSegs.map((sg) => sg.slice());
  const total = () => segs.reduce((a, sg) => a + (sg[0] === 'C' ? (sg[2] * Math.PI) / 180 : 0), 0);
  const T = total();
  const want = (T >= 0 ? 1 : -1) * TAU;
  const freeIdx = segs.findIndex((sg) => sg[0] === 'C' && sg[3] && sg[3].free);
  if (freeIdx >= 0) segs[freeIdx][2] += ((want - T) * 180) / Math.PI;
  const headingResidual = ((total() - want) * 180) / Math.PI;
  const lens0 = segs.filter((sg) => sg[0] === 'S').map((sg) => sg[1]);
  const p0 = integrate(segs, lens0, fine, false);
  let m00 = 0, m01 = 0, m11 = 0;
  for (const [tx, tz, len] of p0.dirs) { m00 += len * tx * tx; m01 += len * tx * tz; m11 += len * tz * tz; }
  const det = m00 * m11 - m01 * m01 || 1e-9;
  const gx = p0.x, gz = p0.z;
  const lx = (m11 * gx - m01 * gz) / det, lz = (-m01 * gx + m00 * gz) / det;
  const lens1 = lens0.map((len, i) => len - len * (p0.dirs[i][0] * lx + p0.dirs[i][1] * lz));
  const p1 = integrate(segs, lens1, fine, true);
  return {
    segs, lens: lens1, pts: p1.pts, gap: Math.hypot(gx, gz), residual: Math.hypot(p1.x, p1.z), headingResidual,
    minStraight: Math.min(...lens1), minRel: Math.min(...lens1.map((l, i) => l / lens0[i])), maxRel: Math.max(...lens1.map((l, i) => l / lens0[i])),
    length: p1.length,
  };
}
