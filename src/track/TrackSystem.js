// TrackSystem: builds a closed 3D circuit from a compact definition, answers "where is the car on the track"
// (Frenet s/n coordinates), surface / wall / kerb queries, and precomputes the racing line used by the AI.
import { clamp, lerp, wrapPi, TAU, smoothstep } from '../core/math.js';
import { buildTurtle } from './Turtle.js';

export const DS = 2.0; // sample spacing (m)
export const SURF = { ASPHALT: 0, KERB: 1, RUNOFF: 2, GRASS: 3, GRAVEL: 4, PIT: 5, SAND: 6 };
const RO_TYPES = { asphalt: SURF.RUNOFF, gravel: SURF.GRAVEL, grass: SURF.GRASS, sand: SURF.SAND, none: SURF.GRASS };

export class Locator {
  constructor() {
    this.i = 0; this.s = 0; this.n = 0;
    this.tx = 0; this.tz = 1; this.lx = 1; this.lz = 0;
    this.psi = 0; this.y = 0; this.cross = 0; this.slope = 0; this.vcurv = 0; this.k = 0;
    this.dist2 = 0; this.valid = false;
  }
}

function clampSample(i, N) { return ((i % N) + N) % N; }

export class Track {
  constructor(def) {
    this.def = def;
    this.id = def.id; this.name = def.name;
    this.buildCenterline();
    this.buildProfile();
    this.buildCrossSection();
    this.buildPit();
    this.buildGridAndZones();
    this.buildCells();
    this.buildRacingLine();
    this.report = this.validate();
  }

  // ---------------------------------------------------------------- centerline from turtle segments
  buildCenterline() {
    const def = this.def;
    const g = buildTurtle(def.segments);
    this.headingResidual = g.headingResidual;
    this.closureGap = g.gap;
    this.minStraight = g.minStraight;
    this.closureResidual = g.residual;
    this.segmentsClosed = g.segs;
    const p1 = { pts: g.pts };

    // 3. uniform resample
    const pts = p1.pts;
    const M = pts.length / 3;
    const cum = new Float64Array(M);
    for (let i = 1; i < M; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[(i - 1) * 3], pts[i * 3 + 1] - pts[(i - 1) * 3 + 1]);
    const Ltot = cum[M - 1];
    const N = Math.round(Ltot / DS);
    this.N = N; this.ds = Ltot / N; this.length = Ltot;
    const x = new Float64Array(N), z = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = i * this.ds;
      while (j < M - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      x[i] = lerp(pts[j * 3], pts[(j + 1) * 3], f);
      z[i] = lerp(pts[j * 3 + 1], pts[(j + 1) * 3 + 1], f);
    }
    // 4. fine-tune closure: remove sub-DS residual by linear drift (<= a few cm)
    const res = [pts[(M - 1) * 3], pts[(M - 1) * 3 + 1]];
    for (let i = 0; i < N; i++) { x[i] -= (res[0] * i) / N; z[i] -= (res[1] * i) / N; }
    this.x = x; this.z = z;
    // headings & curvature
    const psi = new Float64Array(N), k = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = clampSample(i - 1, N), b = clampSample(i + 1, N);
      psi[i] = Math.atan2(x[b] - x[a], z[b] - z[a]);
    }
    for (let i = 0; i < N; i++) {
      const a = clampSample(i - 1, N), b = clampSample(i + 1, N);
      k[i] = wrapPi(psi[b] - psi[a]) / (2 * this.ds);
    }
    // smooth curvature a little (removes quantisation)
    const k2 = new Float64Array(N);
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < N; i++) k2[i] = 0.25 * k[clampSample(i - 1, N)] + 0.5 * k[i] + 0.25 * k[clampSample(i + 1, N)];
      k.set(k2);
    }
    this.psi = psi; this.k = k;
  }

  // ---------------------------------------------------------------- elevation
  buildProfile() {
    const { N } = this;
    const el = this.def.elevation || [[0, 0], [0.5, 0]];
    const pts = el.map(([f, h]) => [f * this.length, h]);
    const L = this.length;
    const y = new Float64Array(N);
    // periodic Catmull-Rom through control points
    const P = pts.length;
    for (let i = 0; i < N; i++) {
      const s = i * this.ds;
      let a = 0;
      while (a < P - 1 && pts[a + 1][0] <= s) a++;
      const b = (a + 1) % P;
      const p0 = pts[(a - 1 + P) % P], p1 = pts[a], p2 = pts[b], p3 = pts[(b + 1) % P];
      let x1 = p1[0], x2 = p2[0] + (b === 0 ? L : 0);
      const t = (s - x1) / Math.max(1e-6, x2 - x1);
      const h = (q0, q1, q2, q3, u) => 0.5 * ((2 * q1) + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
      y[i] = h(p0[1], p1[1], p2[1], p3[1], t);
    }
    // smooth for a nice second derivative
    const yy = new Float64Array(N);
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < N; i++) yy[i] = 0.25 * y[clampSample(i - 1, N)] + 0.5 * y[i] + 0.25 * y[clampSample(i + 1, N)];
      y.set(yy);
    }
    this.y = y;
    const slope = new Float64Array(N), vcurv = new Float64Array(N), cross = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = clampSample(i - 1, N), b = clampSample(i + 1, N);
      slope[i] = (y[b] - y[a]) / (2 * this.ds);
      vcurv[i] = (y[b] - 2 * y[i] + y[a]) / (this.ds * this.ds);
      // camber: road leans towards the inside of corners
      cross[i] = -clamp(this.k[i] * 22, -0.045, 0.045);
    }
    this.slope = slope; this.vcurv = vcurv; this.cross = cross;
  }

  // ---------------------------------------------------------------- widths, kerbs, runoff, walls
  buildCrossSection() {
    const { N, def } = this;
    const W = def.width || 13;
    const wl = new Float32Array(N), wr = new Float32Array(N);
    const prof = def.widthProfile || [];
    for (let i = 0; i < N; i++) {
      let w = W;
      const s = i * this.ds;
      for (const [a, b, ww] of prof) {
        if (s >= a && s <= b) {
          const e = Math.min(40, (b - a) / 2);
          w = lerp(W, ww, smoothstep(a, a + e, s) * (1 - smoothstep(b - e, b, s)));
        }
      }
      wl[i] = wr[i] = w / 2;
    }
    this.wl = wl; this.wr = wr;
    // kerbs
    const kerbL = new Float32Array(N), kerbR = new Float32Array(N);
    const kerbWidth = def.kerbWidth || 1.5;
    const rIn = def.kerbRadius || 260; // corners tighter than this get inside kerbs
    const rOut = def.kerbOutRadius || 90;
    const mark = (arr, pred) => {
      // keep contiguous runs >= 12 samples
      let i = 0;
      while (i < N) {
        if (!pred(i)) { i++; continue; }
        let j = i;
        while (j < N && pred(j)) j++;
        if (j - i >= 12) for (let q = i; q < j; q++) arr[q] = kerbWidth;
        i = j;
      }
    };
    mark(kerbL, (i) => (this.k[i] > 1 / rIn) || (this.k[i] < -1 / rOut));
    mark(kerbR, (i) => (this.k[i] < -1 / rIn) || (this.k[i] > 1 / rOut));
    // chicane/flat kerbs are wider
    for (const [a, b, side, w] of def.kerbZones || []) {
      for (let i = 0; i < N; i++) {
        const s = i * this.ds;
        if (s >= a && s <= b) { if (side !== 'R') kerbL[i] = w; if (side !== 'L') kerbR[i] = w; }
      }
    }
    this.kerbL = kerbL; this.kerbR = kerbR;
    // run-off: per side type/width, with optional zones
    const mk = () => ({ t: new Uint8Array(N), w: new Float32Array(N), g: new Float32Array(N) });
    const roL = mk(), roR = mk();
    const base = def.runoff || { type: 'gravel', w: 10, grass: 8 };
    const apply = (ro, i, r) => { ro.t[i] = RO_TYPES[r.type]; ro.w[i] = r.type === 'none' ? 0 : r.w; ro.g[i] = r.grass === undefined ? 4 : r.grass; };
    for (let i = 0; i < N; i++) {
      apply(roL, i, base.L || base);
      apply(roR, i, base.R || base);
    }
    for (const z of def.runoffZones || []) {
      const [a, b, side, r] = z;
      for (let i = 0; i < N; i++) {
        const s = i * this.ds;
        if (s >= a && s <= b) {
          if (side !== 'R') apply(roL, i, r);
          if (side !== 'L') apply(roR, i, r);
        }
      }
    }
    // smooth the widths a bit to avoid steps
    for (const ro of [roL, roR]) {
      const tmp = new Float32Array(N);
      for (let it = 0; it < 6; it++) {
        for (let i = 0; i < N; i++) tmp[i] = 0.25 * ro.w[clampSample(i - 1, N)] + 0.5 * ro.w[i] + 0.25 * ro.w[clampSample(i + 1, N)];
        ro.w.set(tmp);
        for (let i = 0; i < N; i++) tmp[i] = 0.25 * ro.g[clampSample(i - 1, N)] + 0.5 * ro.g[i] + 0.25 * ro.g[clampSample(i + 1, N)];
        ro.g.set(tmp);
      }
    }
    this.roL = roL; this.roR = roR;
    const wallL = new Float32Array(N), wallR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      wallL[i] = wl[i] + kerbL[i] + roL.w[i] + roL.g[i] + 0.6;
      wallR[i] = wr[i] + kerbR[i] + roR.w[i] + roR.g[i] + 0.6;
      // never let the inside wall pass the centre of curvature in tight corners: shrink the run-off instead
      const kk = Math.abs(this.k[i]);
      if (kk > 1e-4) {
        const cap = 0.78 / kk;
        const [wall, edge, kerb, ro] = this.k[i] > 0 ? [wallL, wl, kerbL, roL] : [wallR, wr, kerbR, roR];
        if (wall[i] > cap) {
          const fixed = edge[i] + kerb[i] + 0.6;
          const room = Math.max(0.5, cap - fixed);
          const have = ro.w[i] + ro.g[i];
          if (have > room) { const f = room / have; ro.w[i] *= f; ro.g[i] *= f; wall[i] = fixed + room; }
        }
      }
    }
    this.wallL = wallL; this.wallR = wallR;
    this.wallRestitution = def.wallRestitution ?? 0.1;
    this.wallFriction = def.wallFriction ?? 0.35;
  }

  // ---------------------------------------------------------------- pit lane
  buildPit() {
    const { N, def, ds } = this;
    const L = this.length;
    const pit = def.pit || {};
    this.pitSide = pit.side === 'L' ? 1 : -1; // n sign of the pit side (left positive)
    const inS = ((pit.inS ?? -260) + L) % L;
    const outS = ((pit.outS ?? 320) + L) % L;
    this.pitInS = inS; this.pitOutS = outS;
    const ramp = pit.ramp || 110;
    const laneW = pit.laneWidth || 15;  // from pit wall to outer boundary
    const gap = pit.gap || 2.2;
    const pitOuter = new Float32Array(N); // distance from centreline to the outer edge, 0 = none
    const pitWallD = new Float32Array(N); // distance of the pit wall from centreline, 0 = none (ramps)
    const pitZone = new Uint8Array(N);    // 1 entry ramp, 2 lane, 3 exit ramp
    const span = (outS - inS + L) % L;
    this.pitLength = span;
    for (let i = 0; i < N; i++) {
      const s = i * ds;
      const rel = (s - inS + L) % L;
      if (rel > span) continue;
      const edge = this.pitSide > 0 ? this.wl[i] : this.wr[i];
      let f;
      if (rel < ramp) { f = smoothstep(0, ramp, rel); pitZone[i] = 1; }
      else if (rel > span - ramp) { f = smoothstep(0, ramp, span - rel); pitZone[i] = 3; }
      else { f = 1; pitZone[i] = 2; }
      pitOuter[i] = edge + (gap + laneW) * Math.max(f, 0.02);
      if (pitZone[i] === 2) pitWallD[i] = edge + gap;
      else pitWallD[i] = 0;
    }
    // inner wall of the lane stops shortly after the ramps begin
    this.pitOuter = pitOuter; this.pitWallD = pitWallD; this.pitZone = pitZone;
    this.pitGap = gap; this.pitLaneWidth = laneW;
    // lane path (centre of fast lane) and boxes
    const nTeams = 20;
    const boxLen = pit.boxLen || 12;
    const lane0 = ramp + 30;
    this.pitBoxes = [];
    const startRel = Math.max(lane0, (span - nTeams * boxLen) / 2);
    for (let b = 0; b < nTeams; b++) {
      const rel = startRel + (b + 0.5) * boxLen;
      this.pitBoxes.push({ s: (inS + rel) % L, n: this.pitSide * 1, index: b });
    }
    this.pitSpeedLimit = pit.speedLimit || 22.2; // 80 km/h
    // the lateral coordinates of the fast lane and of the working lane (pit side sign applied at use)
    this.pitFastN = gap + laneW * 0.32;  // offset beyond the track edge
    this.pitBoxN = gap + laneW * 0.78;
  }

  /** lateral coordinate (signed n) of the fast lane at sample i; blends from the track at ramps. */
  pitLaneN(i, which = 'fast') {
    const edge = this.pitSide > 0 ? this.wl[i] : this.wr[i];
    const d = which === 'fast' ? this.pitFastN : this.pitBoxN;
    const f = this.pitZone[i] === 2 ? 1 : this.pitOuter[i] > 0 ? clamp((this.pitOuter[i] - edge) / (this.pitGap + this.pitLaneWidth), 0, 1) : 0;
    return this.pitSide * (edge + d * f - (1 - f) * edge * 0.6);
  }
  inPitRange(s) {
    const L = this.length;
    return ((s - this.pitInS + L) % L) <= this.pitLength;
  }

  // ---------------------------------------------------------------- grid, DRS, sectors
  buildGridAndZones() {
    const { def, length: L } = this;
    this.sectors = def.sectors || [L / 3, (2 * L) / 3];
    // drs zone: [startS, lengthM, detectionS?]; negative starts wrap around the line
    this.drsZones = (def.drs || []).map(([a, len, det]) => ({
      start: (a + L) % L, length: len, detect: det !== undefined ? (det + L) % L : (a - 160 + L * 2) % L,
    }));
    // auto-detected corners (numbered in lap order) for HUD / AI braking references
    const N = this.N, list = [];
    let i = 0;
    while (i < N) {
      if (Math.abs(this.k[i]) < 1 / 330) { i++; continue; }
      let j = i, sgn = Math.sign(this.k[i]), kmax = 0, im = i;
      while (j < N && Math.abs(this.k[j]) >= 1 / 330 && Math.sign(this.k[j]) === sgn) { if (Math.abs(this.k[j]) > kmax) { kmax = Math.abs(this.k[j]); im = j; } j++; }
      if (j - i >= 6) list.push({ s0: i * this.ds, s1: j * this.ds, apex: im * this.ds, dir: sgn, minR: 1 / kmax });
      i = j;
    }
    list.forEach((c, n) => { c.n = n + 1; });
    this.cornerList = list;
    this.gridSide = def.gridSide === 'R' ? -1 : 1;
    this.corners = def.corners || [];
  }
  /** grid slot k (0 = pole) -> {s, n} */
  gridSlot(k) {
    const row = k >> 1, col = k & 1;
    const L = this.length;
    const s = (L - 14 - row * 8.5 - (col ? 4.2 : 0) + L) % L;
    const half = Math.min(this.wl[0], this.wr[0]);
    const n = (col === 0 ? 1 : -1) * this.gridSide * Math.min(half * 0.42, 3.4);
    return { s, n };
  }

  // ---------------------------------------------------------------- spatial index
  buildCells() {
    this.cellSize = 120;
    const map = new Map();
    for (let i = 0; i < this.N; i++) {
      const cx = Math.floor(this.x[i] / this.cellSize), cz = Math.floor(this.z[i] / this.cellSize);
      const key = cx * 100003 + cz;
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(i);
    }
    this.cells = map;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < this.N; i++) {
      minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]);
      minZ = Math.min(minZ, this.z[i]); maxZ = Math.max(maxZ, this.z[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  // ---------------------------------------------------------------- queries
  globalLocate(loc, px, pz) {
    const cs = this.cellSize;
    const cx = Math.floor(px / cs), cz = Math.floor(pz / cs);
    let best = -1, bd = 1e30;
    for (let r = 1; r <= 4 && best < 0; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        const arr = this.cells.get((cx + a) * 100003 + (cz + b));
        if (!arr) continue;
        for (let q = 0; q < arr.length; q++) {
          const i = arr[q];
          const dx = this.x[i] - px, dz = this.z[i] - pz;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best < 0) best = 0;
    loc.i = best;
    this.locate(loc, px, pz, 12, true);
    return loc;
  }

  /** Local search around loc.i; fills s, n, frame, elevation. */
  locate(loc, px, pz, win = 10, noGlobal = false) {
    const N = this.N, x = this.x, z = this.z;
    let bi = loc.i, bd = 1e30;
    for (let o = -win; o <= win; o++) {
      let i = loc.i + o;
      if (i < 0) i += N; else if (i >= N) i -= N;
      const dx = x[i] - px, dz = z[i] - pz;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd > 1600 && !noGlobal) { this.globalLocate(loc, px, pz); return loc; }
    // project onto the neighbouring segments
    const i0 = bi;
    const ia = bi === 0 ? N - 1 : bi - 1, ib = bi === N - 1 ? 0 : bi + 1;
    // choose segment (i0 -> ib) or (ia -> i0) by projection
    let tx = x[ib] - x[i0], tz = z[ib] - z[i0];
    let t = ((px - x[i0]) * tx + (pz - z[i0]) * tz) / (tx * tx + tz * tz);
    let segA = i0, segB = ib;
    if (t < 0) {
      tx = x[i0] - x[ia]; tz = z[i0] - z[ia];
      t = ((px - x[ia]) * tx + (pz - z[ia]) * tz) / (tx * tx + tz * tz);
      segA = ia; segB = i0;
    }
    t = clamp(t, 0, 1);
    loc.i = t > 0.5 ? segB : segA;
    let s = (segA + t) * this.ds;
    if (segA === N - 1 && segB === 0) s = (N - 1 + t) * this.ds;
    loc.s = s;
    const cx = lerp(x[segA], x[segB], t), cz = lerp(z[segA], z[segB], t);
    const len = Math.hypot(tx, tz);
    loc.tx = tx / len; loc.tz = tz / len;
    loc.lx = loc.tz; loc.lz = -loc.tx; // left normal for forward (sin,cos): left=(cos,-sin)
    loc.n = (px - cx) * loc.lx + (pz - cz) * loc.lz;
    loc.psi = Math.atan2(loc.tx, loc.tz);
    const ii = loc.i;
    loc.y = lerp(this.y[segA], this.y[segB], t);
    loc.cross = this.cross[ii]; loc.slope = this.slope[ii]; loc.vcurv = this.vcurv[ii]; loc.k = this.k[ii];
    loc.dist2 = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
    loc.valid = true;
    return loc;
  }

  /** Surface id at lateral offset nw (signed, left +) at sample i. */
  surfaceAt(i, nw) {
    const a = nw >= 0 ? nw : -nw;
    const left = nw >= 0;
    const edge = left ? this.wl[i] : this.wr[i];
    if (a <= edge) return SURF.ASPHALT;
    // pit side: tarmac up to the outer boundary of the pit area
    if (this.pitOuter[i] > 0 && (left ? 1 : -1) === this.pitSide) {
      if (a < this.pitOuter[i]) {
        if (this.pitWallD[i] > 0 && a < this.pitWallD[i]) return SURF.KERB;
        return SURF.PIT;
      }
    }
    const d = a - edge;
    const kw = left ? this.kerbL[i] : this.kerbR[i];
    if (d < kw) return SURF.KERB;
    const ro = left ? this.roL : this.roR;
    if (d < kw + ro.w[i]) return ro.t[i];
    return SURF.GRASS;
  }

  /** wall distance for the side of nw at sample i, honouring the pit lane (inPit selects which side of the pit wall). */
  wallDist(i, left, inPit) {
    const pitSideHere = (left ? 1 : -1) === this.pitSide;
    if (pitSideHere && this.pitOuter[i] > 0) {
      if (inPit) return this.pitOuter[i] + 0.4;
      if (this.pitWallD[i] > 0) return this.pitWallD[i];
    }
    return left ? this.wallL[i] : this.wallR[i];
  }
  /** inner pit wall when the car is in the lane: returns distance (on pit side) or 0 */
  pitInnerWall(i) { return this.pitWallD[i]; }

  /** kerb vertical profile (m) at arc position s and depth d into the kerb */
  kerbHeight(s, d, w) {
    if (d < 0.1) return 0.006 * (d / 0.1);
    const edge = clamp((w - d) / 0.25, 0, 1);
    return (0.010 + 0.008 * Math.sin(s * 3.4)) * Math.min(1, d / 0.3) * edge;
  }

  /** world point at (s, n) -> out {x,y,z,psi} */
  pointAt(s, n, out) {
    const L = this.length;
    s = ((s % L) + L) % L;
    const f = s / this.ds;
    const i = Math.floor(f) % this.N, j = (i + 1) % this.N, t = f - Math.floor(f);
    const cx = lerp(this.x[i], this.x[j], t), cz = lerp(this.z[i], this.z[j], t);
    let dp = wrapPi(this.psi[j] - this.psi[i]);
    const psi = this.psi[i] + dp * t;
    const lx = Math.cos(psi), lz = -Math.sin(psi);
    out.x = cx + lx * n; out.z = cz + lz * n;
    out.y = lerp(this.y[i], this.y[j], t) + this.cross[i] * n;
    out.psi = psi;
    return out;
  }
  heightAt(s) {
    const L = this.length;
    s = ((s % L) + L) % L;
    const f = s / this.ds;
    const i = Math.floor(f) % this.N, j = (i + 1) % this.N, t = f - Math.floor(f);
    return lerp(this.y[i], this.y[j], t);
  }
  /** wrapped distance from a to b along the lap (positive if b is ahead) in (-L/2, L/2] */
  delta(a, b) {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
    return d;
  }

  // ---------------------------------------------------------------- racing line (minimum curvature, fixed-bounds)
  buildRacingLine() {
    const { N } = this;
    const stride = 3;                      // solve on every 3rd sample (6 m)
    const M = Math.floor(N / stride);
    const px = new Float64Array(M), pz = new Float64Array(M), nx = new Float64Array(M), nz = new Float64Array(M);
    const lo = new Float64Array(M), hi = new Float64Array(M), n = new Float64Array(M);
    const margin = this.def.lineMargin ?? 1.9;
    for (let m = 0; m < M; m++) {
      const i = m * stride;
      px[m] = this.x[i]; pz[m] = this.z[i];
      nx[m] = Math.cos(this.psi[i]); nz[m] = -Math.sin(this.psi[i]);
      hi[m] = this.wl[i] - margin;          // left bound
      lo[m] = -(this.wr[i] - margin);       // right bound
      n[m] = 0;
    }
    const X = (m, off = 0) => px[m] + nx[m] * n[m] + 0 * off;
    const iters = this.def.lineIters || 1800;
    for (let it = 0; it < iters; it++) {
      for (let m = 0; m < M; m++) {
        const a = (m - 1 + M) % M, b = (m + 1) % M;
        const a2 = (m - 2 + M) % M, b2 = (m + 2) % M;
        const Xm = px[m] + nx[m] * n[m], Zm = pz[m] + nz[m] * n[m];
        const Xa = px[a] + nx[a] * n[a], Za = pz[a] + nz[a] * n[a];
        const Xb = px[b] + nx[b] * n[b], Zb = pz[b] + nz[b] * n[b];
        const Xa2 = px[a2] + nx[a2] * n[a2], Za2 = pz[a2] + nz[a2] * n[a2];
        const Xb2 = px[b2] + nx[b2] * n[b2], Zb2 = pz[b2] + nz[b2] * n[b2];
        // second differences at m-1, m, m+1
        const dmx = Xa - 2 * Xm + Xb, dmz = Za - 2 * Zm + Zb;
        const dax = Xa2 - 2 * Xa + Xm, daz = Za2 - 2 * Za + Zm;
        const dbx = Xm - 2 * Xb + Xb2, dbz = Zm - 2 * Zb + Zb2;
        const num = -2 * (nx[m] * dmx + nz[m] * dmz) + (nx[m] * dax + nz[m] * daz) + (nx[m] * dbx + nz[m] * dbz);
        let dn = -num / 6;
        n[m] = clamp(n[m] + 1.7 * dn, lo[m], hi[m]);
      }
    }
    // interpolate to all samples & smooth
    const line = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const f = i / stride, m0 = Math.floor(f) % M, m1 = (m0 + 1) % M, t = f - Math.floor(f);
      line[i] = lerp(n[m0], n[m1], t);
    }
    const tmp = new Float32Array(N);
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < N; i++) tmp[i] = 0.25 * line[clampSample(i - 1, N)] + 0.5 * line[i] + 0.25 * line[clampSample(i + 1, N)];
      line.set(tmp);
    }
    this.line = line;
    // curvature of the racing line itself
    const lk = new Float32Array(N);
    const lx = new Float64Array(N), lz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      lx[i] = this.x[i] + Math.cos(this.psi[i]) * line[i];
      lz[i] = this.z[i] - Math.sin(this.psi[i]) * line[i];
    }
    for (let i = 0; i < N; i++) {
      const a = clampSample(i - 2, N), b = clampSample(i + 2, N);
      const h1 = Math.atan2(lx[i] - lx[a], lz[i] - lz[a]);
      const h2 = Math.atan2(lx[b] - lx[i], lz[b] - lz[i]);
      const d = Math.hypot(lx[b] - lx[a], lz[b] - lz[a]) / 2;
      lk[i] = wrapPi(h2 - h1) / Math.max(1e-3, d);
    }
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < N; i++) tmp[i] = 0.25 * lk[clampSample(i - 1, N)] + 0.5 * lk[i] + 0.25 * lk[clampSample(i + 1, N)];
      lk.set(tmp);
    }
    this.lineK = lk;
    this.lineX = lx; this.lineZ = lz;
  }

  // ---------------------------------------------------------------- sanity checks
  validate() {
    const N = this.N, out = { ok: true, errors: [], minClearance: 1e9, lengthM: this.length };
    if (this.closureResidual > 1.5) { out.ok = false; out.errors.push(`closure residual ${this.closureResidual.toFixed(2)} m`); }
    if (this.minStraight < 8) { out.ok = false; out.errors.push(`straight shrank to ${this.minStraight.toFixed(1)} m`); }
    // clearance between far-apart parts of the track (barrier to barrier)
    const step = 4;
    for (let i = 0; i < N; i += step) {
      for (let j = i + step; j < N; j += step) {
        const ds = Math.min((j - i) * this.ds, this.length - (j - i) * this.ds);
        if (ds < 250) continue;
        const dx = this.x[i] - this.x[j], dz = this.z[i] - this.z[j];
        const d = Math.hypot(dx, dz);
        const need = Math.max(this.wallL[i], this.wallR[i]) + Math.max(this.wallL[j], this.wallR[j]) + 6;
        const clear = d - need;
        if (clear < out.minClearance) out.minClearance = clear;
        if (clear < 0) { out.ok = false; if (out.errors.length < 5) out.errors.push(`track overlaps itself near s=${(i * this.ds).toFixed(0)} / ${(j * this.ds).toFixed(0)} (${d.toFixed(0)} m apart, need ${need.toFixed(0)})`); }
      }
    }
    let maxK = 0, minR = 1e9;
    for (let i = 0; i < N; i++) maxK = Math.max(maxK, Math.abs(this.k[i]));
    out.minRadius = 1 / maxK;
    // walls must not cross the inside of a corner
    for (let i = 0; i < N; i++) {
      const k = this.k[i];
      const inside = k > 0 ? this.wallL[i] : this.wallR[i];
      if (Math.abs(k) > 1e-4 && inside > 0.9 / Math.abs(k)) { out.ok = false; if (out.errors.length < 8) out.errors.push(`inside wall exceeds corner radius near s=${(i * this.ds).toFixed(0)} (R=${(1 / Math.abs(k)).toFixed(0)} wall=${inside.toFixed(1)})`); i += 20; }
    }
    return out;
  }
}
