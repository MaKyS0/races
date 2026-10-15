// CollisionAndDamage: broad-phase spatial grid + OBB/OBB (SAT) car contacts, one-sided Frenet barriers, sequential
// impulse resolution with friction/restitution, and a component damage model (wings, floor, suspension, tyres, chassis).
import { clamp } from '../core/math.js';
import { CAR, WX, WY } from './VehiclePhysics.js';

const HX = 2.72, HY = 0.97, CX0 = 0.12;            // OBB half extents / centre offset in the body frame
const E_CAR = 0.10, MU_CAR = 0.28;
const MAX_CARS = 40;

class Contact { constructor() { this.px = 0; this.pz = 0; this.nx = 0; this.nz = 0; this.pen = 0; this.lax = 0; this.lay = 0; this.lbx = 0; this.lby = 0; } }

export class ImpactEvent {
  constructor() { this.type = ''; this.a = null; this.b = null; this.x = 0; this.z = 0; this.nx = 0; this.nz = 0; this.speed = 0; this.energy = 0; this.wall = false; this.striker = null; this.partLost = ''; this.lx = 0; this.ly = 0; }
}

export class CollisionSystem {
  constructor() {
    this.cell = 12;
    this.heads = new Map();
    this.next = new Int32Array(MAX_CARS);
    this.contacts = [new Contact(), new Contact(), new Contact(), new Contact()];
    this.nContacts = 0;
    this.pool = []; for (let i = 0; i < 96; i++) this.pool.push(new ImpactEvent());
    this.poolIdx = 0;
    this.events = [];
    this.cx = new Float64Array(8); this.cz = new Float64Array(8); // scratch corner arrays
    this.corners = new Float64Array(8);
    this.rng = Math.random;
    this.pairCount = 0;
  }

  ev() { const e = this.pool[this.poolIdx++ % this.pool.length]; this.events.push(e); e.partLost = ''; e.striker = null; e.wall = false; e.b = null; return e; }
  clearEvents() { this.events.length = 0; }

  // ------------------------------------------------------------------- main entry
  update(cars, n, track, dt) {
    // lane flags (pit lane side of the pit wall)
    for (let i = 0; i < n; i++) this.updateLane(cars[i], track);
    // walls
    for (let i = 0; i < n; i++) if (!cars[i].noCollide) this.wallContacts(cars[i], track);
    // broad phase: uniform grid keyed by cell
    const heads = this.heads;
    heads.clear();
    const cs = this.cell;
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      if (c.noCollide) continue;
      const key = Math.floor(c.x / cs) * 65536 + Math.floor(c.z / cs);
      this.next[i] = heads.has(key) ? heads.get(key) : -1;
      heads.set(key, i);
    }
    this.pairCount = 0;
    for (let i = 0; i < n; i++) {
      const A = cars[i];
      if (A.noCollide) continue;
      const gx = Math.floor(A.x / cs), gz = Math.floor(A.z / cs);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        let j = heads.get((gx + dx) * 65536 + (gz + dz));
        if (j === undefined) continue;
        while (j !== -1) {
          if (j > i) { this.carCar(A, cars[j], track); }
          j = this.next[j];
        }
      }
    }
  }

  updateLane(c, track) {
    const loc = c.loc;
    const left = loc.n >= 0;
    const a = Math.abs(loc.n);
    const onPitSide = (left ? 1 : -1) === track.pitSide;
    const edge = left ? track.wl[loc.i] : track.wr[loc.i];
    const z = track.pitZone[loc.i];
    if (!track.inPitRange(loc.s)) { c.inPit = false; return; }
    if (z === 1 && onPitSide && a > edge + 1.2 && c.inPit === false && track.pitOuter[loc.i] > 0 && a > edge + 0.5 * (track.pitOuter[loc.i] - edge)) c.inPit = true;
    else if (z === 3 && (!onPitSide || a < edge + 0.3)) c.inPit = false;
    else if (z === 0) c.inPit = false;
  }

  // ------------------------------------------------------------------- walls
  wallContacts(c, track) {
    const loc = c.loc;
    const i = loc.i;
    const sn = Math.sin(c.psi), cs = Math.cos(c.psi);
    // 8 test points: 4 corners and 4 edge mid-points
    for (let k = 0; k < 8; k++) {
      let bx, by;
      switch (k) {
        case 0: bx = CX0 + HX; by = HY; break; case 1: bx = CX0 + HX; by = -HY; break;
        case 2: bx = CX0 - HX; by = HY; break; case 3: bx = CX0 - HX; by = -HY; break;
        case 4: bx = CX0 + HX; by = 0; break; case 5: bx = CX0 - HX; by = 0; break;
        case 6: bx = CX0 + 0.8; by = HY; break; default: bx = CX0 + 0.8; by = -HY; break;
      }
      const ox = sn * bx + cs * by, oz = cs * bx - sn * by;
      const np = loc.n + ox * loc.lx + oz * loc.lz;
      const left = np >= 0;
      const a = Math.abs(np);
      let wall = track.wallDist(i, left, c.inPit);
      let dir = left ? -1 : 1; // push direction (towards the track centre) in n
      let pen = a - wall;
      // pit wall seen from the pit lane side
      if (pen <= 0 && c.inPit && (left ? 1 : -1) === track.pitSide) {
        const iw = track.pitInnerWall(i);
        if (iw > 0 && a < iw + 0.05) { pen = iw + 0.05 - a; dir = left ? 1 : -1; }
      }
      if (pen <= 0) continue;
      this.wallImpulse(c, track, c.x + ox, c.z + oz, dir * loc.lx, dir * loc.lz, pen, bx, by);
    }
  }

  wallImpulse(c, track, px, pz, nx, nz, pen, lx, ly) {
    const rx = px - c.x, rz = pz - c.z;
    // positional correction
    const corr = Math.min(pen, 1.5) * 0.9;
    c.x += nx * corr; c.z += nz * corr;
    // velocity at the point (world): v + r*(rz, -rx)
    const vx = c.vx + c.r * rz, vz = c.vz - c.r * rx;
    const vn = vx * nx + vz * nz;
    if (vn >= 0) return;
    const m = c.mass, I = 1050 * m / 800;
    const rn = rz * nx - rx * nz;              // cross2(r, n)
    const effN = 1 / m + (rn * rn) / I;
    const e = Math.abs(vn) > 2 ? c.wallE : 0;
    const j = -(1 + e) * vn / effN;
    c.vx += (j * nx) / m; c.vz += (j * nz) / m;
    c.r += (j * rn) / I;
    // friction (scrape)
    const tx = -nz, tz = nx;
    const vt = vx * tx + vz * tz;
    const rt = rz * tx - rx * tz;
    const effT = 1 / m + (rt * rt) / I;
    let jt = -vt / effT;
    const maxF = c.wallMu * j;
    jt = clamp(jt, -maxF, maxF);
    c.vx += (jt * tx) / m; c.vz += (jt * tz) / m;
    c.r += (jt * rt) / I;
    // events + damage
    const speedN = -vn;
    const energy = 0.5 * m * speedN * speedN;
    if (speedN > 1.2) {
      const e2 = this.ev();
      e2.type = 'impact'; e2.a = c; e2.wall = true; e2.x = px; e2.z = pz; e2.nx = nx; e2.nz = nz;
      e2.speed = speedN; e2.energy = energy; e2.lx = lx; e2.ly = ly;
      this.applyDamage(c, lx, ly, energy, e2);
    }
    c.lastImpact = Math.max(c.lastImpact, speedN);
    c.scrape = Math.max(c.scrape || 0, Math.abs(vt));
  }

  // ------------------------------------------------------------------- car vs car (OBB SAT)
  carCar(A, B, track) {
    this.pairCount++;
    const dx = B.x - A.x, dz = B.z - A.z;
    if (dx * dx + dz * dz > 36) return;           // > 6 m apart: no overlap possible (half length 2.7 + 2.7)
    // axes
    const sA = Math.sin(A.psi), cA = Math.cos(A.psi), sB = Math.sin(B.psi), cB = Math.cos(B.psi);
    // box centres in world
    const aCx = A.x + sA * CX0, aCz = A.z + cA * CX0, bCx = B.x + sB * CX0, bCz = B.z + cB * CX0;
    // axes: A forward/left, B forward/left
    const ax = [sA, cA, cA, -sA, sB, cB, cB, -sB];
    const ext = [HX, HY, HX, HY];
    const tx = bCx - aCx, tz = bCz - aCz;
    let bestPen = 1e9, bestAxis = -1, bestSign = 1;
    for (let k = 0; k < 4; k++) {
      const nx = ax[k * 2], nz = ax[k * 2 + 1];
      // projections of both boxes onto this axis
      const rA = k < 2 ? ext[k] : (Math.abs(nx * sA + nz * cA) * HX + Math.abs(nx * cA - nz * sA) * HY);
      const rB = k >= 2 ? ext[k] : (Math.abs(nx * sB + nz * cB) * HX + Math.abs(nx * cB - nz * sB) * HY);
      const dist = tx * nx + tz * nz;
      const pen = rA + rB - Math.abs(dist);
      if (pen <= 0) return;
      if (pen < bestPen) { bestPen = pen; bestAxis = k; bestSign = dist >= 0 ? 1 : -1; }
    }
    // reference box = owner of the best axis; normal points from A to B
    const nx = ax[bestAxis * 2] * bestSign, nz = ax[bestAxis * 2 + 1] * bestSign;
    const refA = bestAxis < 2;
    const R = refA ? A : B, I = refA ? B : A;
    const nr = refA ? 1 : -1;                              // normal oriented from reference box outwards
    const rnx = nx * (refA ? 1 : -1) * 1, rnz = nz * (refA ? 1 : -1) * 1; // outward normal of reference face
    // incident corners behind the reference face
    const sI = Math.sin(I.psi), cI = Math.cos(I.psi);
    const iCx = I.x + sI * CX0, iCz = I.z + cI * CX0;
    const rCx = refA ? aCx : bCx, rCz = refA ? aCz : bCz;
    const sR = Math.sin(R.psi), cR = Math.cos(R.psi);
    // reference face tangent (the other axis of R)
    const tanX = (bestAxis % 2 === 0) ? cR : sR, tanZ = (bestAxis % 2 === 0) ? -sR : cR;
    const faceHalf = (bestAxis % 2 === 0) ? HY : HX;
    const faceDist = (bestAxis % 2 === 0) ? HX : HY;
    this.nContacts = 0;
    let deepest = -1e9, dI = null;
    for (let k = 0; k < 4; k++) {
      const lx = (k & 1 ? -1 : 1) * HX, ly = (k & 2 ? -1 : 1) * HY;
      const wx = iCx + sI * lx + cI * ly, wz = iCz + cI * lx - sI * ly;
      const relx = wx - rCx, relz = wz - rCz;
      const dn = relx * rnx + relz * rnz - faceDist;   // >0 outside the reference face
      const dt2 = relx * tanX + relz * tanZ;
      if (dn < 0 && Math.abs(dt2) <= faceHalf + 0.05) {
        if (this.nContacts < 4) {
          const c = this.contacts[this.nContacts++];
          c.px = wx; c.pz = wz; c.pen = -dn;
        }
      }
      if (-dn > deepest) { deepest = -dn; dI = [wx, wz]; }
    }
    if (this.nContacts === 0 && dI) { const c = this.contacts[this.nContacts++]; c.px = dI[0]; c.pz = dI[1]; c.pen = Math.max(0.001, Math.min(deepest, bestPen)); }
    if (this.nContacts === 0) return;
    // resolve: normal from A to B
    this.resolve(A, B, nx, nz, bestPen, track);
  }

  resolve(A, B, nx, nz, pen, track) {
    const mA = A.mass, mB = B.mass;
    const IA = 1050 * mA / 800, IB = 1050 * mB / 800;
    // positional separation
    const sepTotal = Math.min(pen, 1.2) * 0.85;
    const wA = (1 / mA) / (1 / mA + 1 / mB);
    A.x -= nx * sepTotal * wA; A.z -= nz * sepTotal * wA;
    B.x += nx * sepTotal * (1 - wA); B.z += nz * sepTotal * (1 - wA);
    let maxVn = 0, px0 = 0, pz0 = 0;
    for (let iter = 0; iter < 4; iter++) {
      for (let k = 0; k < this.nContacts; k++) {
        const c = this.contacts[k];
        const rax = c.px - A.x, raz = c.pz - A.z, rbx = c.px - B.x, rbz = c.pz - B.z;
        const vax = A.vx + A.r * raz, vaz = A.vz - A.r * rax;
        const vbx = B.vx + B.r * rbz, vbz = B.vz - B.r * rbx;
        const vn = (vax - vbx) * nx + (vaz - vbz) * nz;      // >0 closing
        if (vn <= 0) continue;
        const rnA = raz * nx - rax * nz, rnB = rbz * nx - rbx * nz;
        const eff = 1 / mA + 1 / mB + (rnA * rnA) / IA + (rnB * rnB) / IB;
        const e = vn > 2.5 ? E_CAR : 0;
        const j = ((1 + e) * vn) / (eff * this.nContacts);
        A.vx -= (j * nx) / mA; A.vz -= (j * nz) / mA; A.r -= (j * rnA) / IA;
        B.vx += (j * nx) / mB; B.vz += (j * nz) / mB; B.r += (j * rnB) / IB;
        // friction
        const tx = -nz, tz = nx;
        const vtt = (vax - vbx) * tx + (vaz - vbz) * tz;
        const rtA = raz * tx - rax * tz, rtB = rbz * tx - rbx * tz;
        const effT = 1 / mA + 1 / mB + (rtA * rtA) / IA + (rtB * rtB) / IB;
        let jt = -vtt / (effT * this.nContacts);
        const mx = MU_CAR * j;
        jt = clamp(jt, -mx, mx);
        A.vx += (jt * tx) / mA; A.vz += (jt * tz) / mA; A.r += (jt * rtA) / IA;
        B.vx -= (jt * tx) / mB; B.vz -= (jt * tz) / mB; B.r -= (jt * rtB) / IB;
        if (iter === 0 && vn > maxVn) { maxVn = vn; px0 = c.px; pz0 = c.pz; }
      }
    }
    if (maxVn > 0.8) {
      const mRed = (mA * mB) / (mA + mB);
      const energy = 0.5 * mRed * maxVn * maxVn;
      const e = this.ev();
      e.type = 'impact'; e.a = A; e.b = B; e.x = px0; e.z = pz0; e.nx = nx; e.nz = nz; e.speed = maxVn; e.energy = energy; e.wall = false;
      // local contact points on both cars
      const lA = this.toLocal(A, px0, pz0), lB = this.toLocal(B, px0, pz0);
      // who struck whom: nose of one into the tail/side of the other
      const aFront = lA[0] > 1.8 && Math.abs(lA[1]) < 1.1, bFront = lB[0] > 1.8 && Math.abs(lB[1]) < 1.1;
      const aRear = lA[0] < -1.8, bRear = lB[0] < -1.8;
      if (aFront && !bFront) e.striker = A; else if (bFront && !aFront) e.striker = B;
      else if (aRear && !bRear) e.striker = B; else if (bRear && !aRear) e.striker = A;
      e.lx = lA[0]; e.ly = lA[1];
      this.applyDamage(A, lA[0], lA[1], energy, e);
      this.applyDamage(B, lB[0], lB[1], energy, null);
      A.lastImpact = Math.max(A.lastImpact, maxVn); B.lastImpact = Math.max(B.lastImpact, maxVn);
    }
  }

  toLocal(c, wx, wz) {
    const sn = Math.sin(c.psi), cs = Math.cos(c.psi);
    const rx = wx - c.x, rz = wz - c.z;
    this.tmpL = this.tmpL || [0, 0];
    this.tmpL = [rx * sn + rz * cs, rx * cs - rz * sn];
    return this.tmpL;
  }

  // ------------------------------------------------------------------- damage model
  applyDamage(c, lx, ly, energy, ev) {
    const dm = c.damage;
    const E0 = 700;
    if (energy < E0) return;
    const rnd = this.rng;
    const eff = energy - E0;
    const lost = (name) => { if (ev && !ev.partLost) ev.partLost = name; c.partsLost++; };
    // chassis cumulative
    dm.chassis = clamp(dm.chassis + Math.max(0, energy - 25000) / 330000, 0, 1);
    const front = lx > 1.7, rear = lx < -1.7;
    const axleF = Math.abs(lx - CAR.a) < 0.95, axleR = Math.abs(lx + CAR.b) < 0.95;
    const sideL = ly > 0;
    const wheelZone = Math.abs(ly) > 0.55;
    if (front) {
      // front wing: distribute by lateral position; an end-plate strike hurts one half
      const amount = clamp(eff / 5200, 0, 1.4);
      const wl = clamp(0.5 + ly * 0.45, 0, 1), wr = 1 - wl;
      const prevL = dm.fwL, prevR = dm.fwR;
      dm.fwL = clamp(dm.fwL + amount * (0.35 + wl), 0, 1);
      dm.fwR = clamp(dm.fwR + amount * (0.35 + wr), 0, 1);
      if (prevL < 0.9 && dm.fwL >= 0.9) lost('front wing (left)');
      if (prevR < 0.9 && dm.fwR >= 0.9) lost('front wing (right)');
      if (wheelZone && eff > 3500) this.hitCorner(c, sideL ? 0 : 1, eff * 0.7, ev, lost);
    } else if (rear) {
      const amount = clamp(eff / 5600, 0, 1.4);
      const prev = dm.rw;
      dm.rw = clamp(dm.rw + amount, 0, 1);
      dm.floor = clamp(dm.floor + amount * 0.35, 0, 1);
      if (prev < 0.9 && dm.rw >= 0.9) lost('rear wing');
      if (eff > 60000) dm.engine = clamp(dm.engine + (eff - 60000) / 220000, 0, 1);
      if (wheelZone && eff > 3500) this.hitCorner(c, sideL ? 2 : 3, eff * 0.6, ev, lost);
    } else {
      // side impact: sidepod/floor and the wheels that stick out
      dm.floor = clamp(dm.floor + eff / 26000, 0, 1);
      if (wheelZone) {
        if (axleF) this.hitCorner(c, sideL ? 0 : 1, eff, ev, lost);
        else if (axleR) this.hitCorner(c, sideL ? 2 : 3, eff, ev, lost);
        else dm.floor = clamp(dm.floor + eff / 40000, 0, 1);
      }
    }
    // power unit damage from big rear / heavy hits
    if (eff > 120000) dm.engine = clamp(dm.engine + (eff - 120000) / 400000, 0, 1);
    c.pt.health = 1 - 0.8 * dm.engine;
    // retirement
    const off = dm.wheelOff[0] + dm.wheelOff[1] + dm.wheelOff[2] + dm.wheelOff[3];
    if (!c.retired) {
      if (dm.chassis >= 1) { c.retired = true; c.retireReason = 'Accident damage'; }
      else if (dm.engine >= 0.95) { c.retired = true; c.retireReason = 'Power unit'; }
      else if (off >= 2) { c.retired = true; c.retireReason = 'Suspension'; }
    }
  }

  hitCorner(c, i, eff, ev, lost) {
    const dm = c.damage;
    const before = dm.sus[i];
    dm.sus[i] = clamp(dm.sus[i] + eff / 16000, 0, 1);
    // tyre puncture chance grows with energy
    const pP = clamp((eff - 2500) / 14000, 0, 0.95);
    if (!dm.tyrePunct[i] && this.rng() < pP) { dm.tyrePunct[i] = 1; c.tires[i].leak = 0.05 + this.rng() * 0.18; }
    if (before < 1 && dm.sus[i] >= 1 && !dm.wheelOff[i]) {
      dm.wheelOff[i] = 1;
      lost('wheel ' + ['FL', 'FR', 'RL', 'RR'][i]);
    }
  }
}
