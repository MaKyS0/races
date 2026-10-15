// VehiclePhysics: planar rigid-body car with 4 independent tyre contacts, a 3-DOF sprung body (heave/pitch/roll)
// for load transfer + kerb response, powertrain, aero, brakes and damage. World frame state, body-frame forces.
// Everything in the step path is allocation free.
import { clamp, expK, G } from '../core/math.js';
import { Tire, SURFACE_LIST } from './TireModel.js';
import { BrakeSystem } from './BrakeSystem.js';
import { Powertrain } from './EngineAndTransmission.js';
import { Aerodynamics, AIR_RHO } from './Aerodynamics.js';
import { Locator } from '../track/TrackSystem.js';

export const CAR = {
  mass0: 800,            // kg incl. driver, without fuel
  a: 1.962, b: 1.638,    // CG to front / rear axle
  tf: 1.60, tr: 1.55,    // track widths
  hcg: 0.28, hRcF: 0.04, hRcR: 0.10, hDrag: 0.27,
  Iz0: 1050, Ip0: 1400, Ir0: 360,
  Rw: [0.335, 0.335, 0.345, 0.345], Iw: 1.3,
  kS: [230e3, 230e3, 270e3, 270e3], cS: 7200, arbF: 70e3, arbR: 45e3,
  antiPitch: 0.25,
  length: 5.45, width: 1.95,
  steerMax: 0.36, steerRate: 1.5,
  toeStiff: 1.0,
};
export const WX = [CAR.a, CAR.a, -CAR.b, -CAR.b];
export const WY = [CAR.tf / 2, -CAR.tf / 2, CAR.tr / 2, -CAR.tr / 2];
const WNAMES = ['FL', 'FR', 'RL', 'RR'];
export { WNAMES };
const WB = CAR.a + CAR.b;
const K_DIFF = 140; // Nm per rad/s LSD coupling

export const DEFAULT_SETUP = { frontWing: 5, rearWing: 5, brakeBias: 0.575, diffPreload: 120, diffPower: 0.35, engineBraking: 0.7 };
export const DEFAULT_ASSISTS = { abs: 0, tc: 1, steer: 1, autoGear: true, brakeHelp: 0 };

export class Vehicle {
  constructor(id = 0) {
    this.id = id;
    this.name = 'Car';
    this.x = 0; this.z = 0; this.y = 0; this.psi = 0;
    this.vx = 0; this.vz = 0; this.r = 0;
    this.u = 0; this.v = 0; this.speed = 0; this.ax = 0; this.ay = 0; this.ayBody = 0; this.axBody = 0;
    this.mass = CAR.mass0 + 100;
    this.wOmega = new Float64Array(4);
    this.steer = 0;
    this.ctrl = { throttle: 0, brake: 0, steer: 0, up: false, down: false, drs: false, limiter: false };
    this.assists = { ...DEFAULT_ASSISTS };
    this.setup = { ...DEFAULT_SETUP };
    // body DOFs
    this.h = 0; this.hv = 0; this.th = 0; this.thv = 0; this.ph = 0; this.phv = 0;
    this.gf = new Float64Array(4); this.gfPrev = new Float64Array(4);
    this.d = new Float64Array(4);        // spring compression (m)
    this.fz = new Float64Array(4);       // tyre loads (N)
    this.fxw = new Float64Array(4); this.fyw = new Float64Array(4); // tyre-frame forces
    this.kappa = new Float64Array(4);
    this.slipA = new Float64Array(4);
    this.surf = new Uint8Array(4);
    this.skid = new Float32Array(4);     // 0..1.5 sliding intensity for smoke/sfx
    this.tires = [new Tire('medium'), new Tire('medium'), new Tire('medium'), new Tire('medium')];
    this.brakes = new BrakeSystem();
    this.pt = new Powertrain();
    this.aero = new Aerodynamics();
    this.loc = new Locator();
    this.inPit = false;
    this.damage = { fwL: 0, fwR: 0, rw: 0, floor: 0, sus: new Float64Array(4), wheelOff: new Uint8Array(4), engine: 0, chassis: 0, tyrePunct: new Uint8Array(4) };
    this.partsLost = 0;
    this.retired = false; this.retireReason = '';
    this.tcCut = 0; this.tcActive = false; this.absActive = false;
    this.sparks = 0; this.kerbShake = 0; this.dragN = 0; this.downN = 0;
    this.lastImpact = 0;
    this.lod = 0; this.lodCount = 0;
    this.drsAllowed = false; this.drsOpen = false;
    this.rideF = 0; this.rideR = 0;
    this.wheelAngle = new Float64Array(4); // accumulated spin for visuals
    this.dtmp = new Float64Array(4);
    this.tireTempAir = 25;
    this.wearMult = 1;
    this.regenNow = 0;
    this.distance = 0; // odometer
    this.rest = false;
    this.wallE = 0.1; this.wallMu = 0.35; this.noCollide = false; this.scrape = 0;
    this.applySetup();
  }

  applySetup() {
    const s = this.setup;
    this.aero.setup.frontWing = s.frontWing; this.aero.setup.rearWing = s.rearWing;
    this.brakes.bias = s.brakeBias;
    this.pt.engineBraking = s.engineBraking;
    this.pt.auto = this.assists.autoGear;
  }

  setFuel(kg) { this.pt.fuel = kg; this.mass = CAR.mass0 + kg; }
  fitTyres(compound, temp = 75) { for (let i = 0; i < 4; i++) this.tires[i].fit(compound, temp); this.brakes.temp.set([260, 260, 210, 210]); }
  get compound() { return this.tires[0].compound; }

  /** Put the car at track coords (s, n) facing along the track, standing still or at speed. */
  place(track, s, n, speed = 0, nOffsetHeading = 0) {
    const p = track.pointAt(s, n, { x: 0, y: 0, z: 0, psi: 0 });
    this.x = p.x; this.z = p.z; this.y = p.y; this.psi = p.psi + nOffsetHeading;
    this.vx = Math.sin(this.psi) * speed; this.vz = Math.cos(this.psi) * speed; this.r = 0;
    for (let i = 0; i < 4; i++) { this.wOmega[i] = speed / CAR.Rw[i]; this.fz[i] = 0; this.kappa[i] = 0; this.tires[i].syRelax = 0; }
    this.h = this.th = this.ph = this.hv = this.thv = this.phv = 0;
    this.gf.fill(0); this.gfPrev.fill(0);
    this.steer = 0;
    this.pt.gear = speed > 5 ? Math.min(8, 1 + Math.floor(speed / 14)) : 1;
    this.pt.rpm = 4500;
    this.brakes.pedal = 0;
    track.globalLocate(this.loc, this.x, this.z);
    this.inPit = track.inPitRange(this.loc.s) && Math.abs(this.loc.n) > ((this.loc.n > 0 ? track.wl[this.loc.i] : track.wr[this.loc.i]) + 0.5) && (this.loc.n > 0 ? 1 : -1) === track.pitSide;
    this.retired = false; this.retireReason = '';
  }

  get fuel() { return this.pt.fuel; }

  /** current max front-wheel angle (rad) after speed-sensitive steering limits */
  steerLock() {
    const sp = this.speed;
    const sa = this.assists.steer;
    if (sa > 0) return CAR.steerMax * Math.max(1 / (1 + (sp / 48) * (sp / 48) * (sa === 1 ? 1.5 : 3)), 0.08);
    return CAR.steerMax / (1 + (sp / 95) * (sp / 95));
  }

  /** Step the simulation by dt seconds. env = {water, tAir, tTrack, wearMult, wind}. */
  step(dt, track, env) {
    const C = CAR;
    const ctrl = this.ctrl, loc = this.loc, pt = this.pt, brakes = this.brakes, aero = this.aero, dm = this.damage;
    const retired = this.retired;
    const water = env.water, tAir = env.tAir, tTrack = env.tTrack;

    track.locate(loc, this.x, this.z, 10);
    this.y = loc.y;
    const sn = Math.sin(this.psi), cs = Math.cos(this.psi);
    const u = this.vx * sn + this.vz * cs;
    const v = this.vx * cs - this.vz * sn;
    const speed = Math.hypot(u, v);
    this.u = u; this.v = v; this.speed = speed;
    const m = this.mass = C.mass0 + pt.fuel;
    const mScale = m / 800;
    const Iz = C.Iz0 * mScale;
    const mS = m * 0.92;                 // sprung mass
    const Ip = C.Ip0 * mScale, Ir = C.Ir0 * mScale;

    // ------------------------------------------------------ driver inputs (retired cars just roll to a stop)
    let thr = retired ? 0 : ctrl.throttle, brk = retired ? 0.6 : ctrl.brake;
    if (this.rest) { thr = 0; brk = Math.max(brk, 0.3); }

    // ------------------------------------------------------ steering with assists
    const sa = this.assists.steer;
    let lock = C.steerMax;
    if (sa > 0) {
      const f = 1 / (1 + (speed / 48) * (speed / 48) * (sa === 1 ? 1.5 : 3));
      lock = C.steerMax * Math.max(f, 0.08);
    } else {
      lock = C.steerMax / (1 + (speed / 95) * (speed / 95));
    }
    let target = (retired ? 0 : ctrl.steer) * lock;
    if (sa > 0 && !retired) {
      // mild counter-steer help from rear slip angle; capped so it can never replace the driver
      const rearSlip = Math.atan2(v - this.r * C.b, Math.max(5, Math.abs(u)));
      if (Math.abs(rearSlip) > 0.07 && speed > 12) {
        const corr = clamp(-rearSlip * (sa === 1 ? 0.55 : 0.9), -0.35 * lock, 0.35 * lock);
        target += corr * clamp((Math.abs(rearSlip) - 0.07) / 0.1, 0, 1);
      }
    }
    // damaged steering link limits lock
    const maxDmg = Math.max(dm.sus[0], dm.sus[1]);
    target = clamp(target, -C.steerMax * (1 - 0.25 * maxDmg), C.steerMax * (1 - 0.25 * maxDmg));
    const dSteer = clamp(target - this.steer, -C.steerRate * dt, C.steerRate * dt);
    this.steer += dSteer;
    const steer = this.steer;
    const cdl = Math.cos(steer), sdl = Math.sin(steer);

    // ------------------------------------------------------ DRS
    this.drsOpen = this.drsAllowed && ctrl.drs && thr > 0.9 && brk < 0.05 && !retired;
    aero.drsOpen += ((this.drsOpen ? 1 : 0) - aero.drsOpen) * expK(this.drsOpen ? 9 : 14, dt);

    // ------------------------------------------------------ sprung body kinematics -> corner compression & loads
    const lpK = expK(150, dt);
    const hv = this.hv, thv = this.thv, phv = this.phv;
    let sumF = 0, momP = 0, momR = 0;
    let fyF = 0, fyR = 0;
    for (let i = 0; i < 4; i++) { if (i < 2) fyF += this.fyw[i]; else fyR += this.fyw[i]; }
    const antiLong = C.antiPitch * (-this.axBody * m * C.hcg) / WB; // + loads the front under braking
    const extraDown = m * speed * speed * loc.vcurv;                  // crest/compression
    for (let i = 0; i < 4; i++) {
      const bx = WX[i], by = WY[i];
      const ox = sn * bx + cs * by, oz = cs * bx - sn * by;
      const nw = loc.n + ox * loc.lx + oz * loc.lz;
      const sid = env.forceSurface !== undefined ? env.forceSurface : track.surfaceAt(loc.i, nw);
      this.surf[i] = sid;
      // road disturbance: kerb profile, rough off-track surface
      let bump = 0;
      const sf = SURFACE_LIST[sid];
      if (sid === 1) {
        const left = nw >= 0;
        const edge = left ? track.wl[loc.i] : track.wr[loc.i];
        const kw = left ? track.kerbL[loc.i] : track.kerbR[loc.i];
        bump = track.kerbHeight(loc.s, Math.abs(nw) - edge, kw) ;
        if (dm.wheelOff[i]) bump = 0;
      } else if (sf.rough > 0) {
        bump = sf.rough * 0.012 * Math.sin(loc.s * 2.9 + i * 1.7) * Math.sin(loc.s * 6.3 + i);
      }
      this.gfPrev[i] = this.gf[i];
      this.gf[i] += (bump - this.gf[i]) * lpK;
      const z = this.h + bx * this.th + by * this.ph;
      const di = this.gf[i] - z;
      this.d[i] = di;
    }
    // spring/damper/ARB forces
    const kS = C.kS, cS = C.cS;
    const F0 = this.dtmp;
    for (let i = 0; i < 4; i++) {
      const bx = WX[i], by = WY[i];
      const dd = (this.gf[i] - this.gfPrev[i]) / dt - (hv + bx * thv + by * phv);
      let f = kS[i] * this.d[i] + cS * dd;
      F0[i] = f;
    }
    const arbF = C.arbF * (this.d[0] - this.d[1]), arbR = C.arbR * (this.d[2] - this.d[3]);
    F0[0] += arbF; F0[1] -= arbF; F0[2] += arbR; F0[3] -= arbR;
    // static weight per wheel
    const Wf = (m * G * C.b) / WB / 2, Wr = (m * G * C.a) / WB / 2;
    const geoRollF = (fyF * C.hRcF) / C.tf, geoRollR = (fyR * C.hRcR) / C.tr; // left force -> load to the right tyre
    for (let i = 0; i < 4; i++) {
      let fz = (i < 2 ? Wf : Wr) + F0[i];
      // geometric (instant) transfers
      fz += (i < 2 ? antiLong : -antiLong) * 0.5;
      const sideLeft = i === 0 || i === 2;
      fz += (sideLeft ? -1 : 1) * (i < 2 ? geoRollF : geoRollR);
      this.fz[i] = fz;
    }
    // ---------- aero (uses ride heights from the body state)
    this.rideF = -1000 * (this.h + C.a * this.th);
    this.rideR = -1000 * (this.h - C.b * this.th);
    const q = 0.5 * AIR_RHO * speed * speed;
    aero.update(q, this.rideF, this.rideR, dm);
    // ---------- tyres
    let FxB = 0, FyB = 0, Mz = 0;
    const absLevel = this.assists.abs;
    for (let i = 0; i < 4; i++) {
      const tire = this.tires[i];
      let fz = this.fz[i];
      if (fz < 0) fz = 0;
      const bx = WX[i], by = WY[i];
      const di = i < 2 ? steer + dm.sus[i] * (i === 0 ? 0.06 : -0.06) : 0;
      const cdi = i < 2 ? Math.cos(di) : 1, sdi = i < 2 ? Math.sin(di) : 0;
      const vwx = u - this.r * by, vwy = v + this.r * bx;
      const vl = vwx * cdi + vwy * sdi;
      const vt = -vwx * sdi + vwy * cdi;
      const R = C.Rw[i] * (1 - 0.1 * tire.puncture);
      const w = this.wOmega[i];
      const den = Math.max(Math.abs(vl), 3.0);
      let kappa = (w * R - vl) / den;
      kappa = clamp(kappa, -1.2, 1.2);
      // lateral slip with relaxation length (~0.7 m) -> smooth transient
      const tgt = vt / den;
      const rl = 1 - Math.exp(-Math.max(Math.abs(vl), 2.5) * dt / 0.7);
      tire.syRelax += (clamp(tgt, -3, 3) - tire.syRelax) * rl;
      const sf = SURFACE_LIST[this.surf[i]];
      const wheelOff = dm.wheelOff[i];
      if (wheelOff) {
        // wheel gone: the corner drags on its skid pad
        const mu = 0.5 * fz;
        const mag = Math.hypot(vl, vt) + 1e-3;
        this.fxw[i] = -mu * vl / Math.max(mag, 1.5);
        this.fyw[i] = -mu * vt / Math.max(mag, 1.5);
        this.kappa[i] = 0; this.slipA[i] = 0;
        this.skid[i] = 1.2 * (fz > 100 ? 1 : 0);
        tire.fx = this.fxw[i]; tire.fy = this.fyw[i]; tire.mu = 0.5; tire.sliding = 2;
      } else {
        tire.eval(fz, kappa, tire.syRelax, sf, water, speed, 1 - 0.38 * dm.sus[i]);
        let fx = tire.fx, fy = tire.fy;
        // rolling resistance / digging (grass, gravel)
        const rr = sf.crr * (1 + 1.4 * tire.puncture) + sf.dig * 0.0008 * speed;
        fx -= rr * fz * Math.tanh(vl / 0.6);
        // keep forces from over-correcting at very low speed
        const lim = (0.25 * m * Math.abs(vt)) / dt + 40;
        if (fy > lim) fy = lim; else if (fy < -lim) fy = -lim;
        const limx = (0.25 * m * Math.abs(vl)) / dt + 40;
        if (kappa < 0 && fx < -limx) fx = -limx;
        this.fxw[i] = fx; this.fyw[i] = fy;
        this.kappa[i] = kappa; this.slipA[i] = tire.syRelax;
        const sl = tire.sliding;
        this.skid[i] = fz > 150 ? clamp(sl - 0.95, 0, 1.5) : 0;
      }
      // to body frame
      const fbx = this.fxw[i] * cdi - this.fyw[i] * sdi;
      const fby = this.fxw[i] * sdi + this.fyw[i] * cdi;
      FxB += fbx; FyB += fby;
      Mz += bx * fby - by * fbx;
      // thermal / wear
      tire.thermal(dt, fz, w * R - vl, vt, speed, tAir, tTrack, i < 2 ? brakes.temp[i] : brakes.temp[i] * 0.9, water, env.wearMult);
    }

    // ------------------------------------------------------ brakes
    const wRearAvg = 0.5 * (this.wOmega[0 + 2] + this.wOmega[3]);
    const regenAvail = pt.regenAvailable(brk, wRearAvg, speed);
    brakes.update(dt, brk, this.kappa, absLevel, regenAvail, clamp(water * 2, 0, 1), speed, null);
    let absOn = false;
    for (let i = 0; i < 4; i++) if (brakes.absRelease[i] > 0.05) absOn = true;
    this.absActive = absOn;
    this.regenNow = brakes.regenTorque;

    // ------------------------------------------------------ traction control (reduces torque, not a physics replacement)
    const tcL = this.assists.tc;
    let tcCut = 0;
    if (tcL > 0 && thr > 0.05 && !retired) {
      const kmax = Math.max(this.kappa[2], this.kappa[3]);
      const tgtK = tcL === 1 ? 0.22 : tcL === 2 ? 0.15 : 0.11;
      tcCut = clamp((kmax - tgtK) / 0.08, 0, 1) * (tcL === 1 ? 0.6 : 0.8);
      // lateral slip also lowers the allowance (keeps the tail in line without cutting power in a straight line)
      const sy = Math.max(Math.abs(this.slipA[2]), Math.abs(this.slipA[3]));
      if (sy > 0.16) tcCut = Math.max(tcCut, clamp((sy - 0.16) / 0.12, 0, 1) * 0.5 * (tcL / 3));
    }
    this.tcCut += (tcCut - this.tcCut) * expK(25, dt);
    this.tcActive = this.tcCut > 0.05;

    // ------------------------------------------------------ powertrain
    const axleT = retired ? 0 : pt.update(dt, thr, brk, wRearAvg, speed, ctrl.up, ctrl.down, brakes.regenTorque, this.tcCut, ctrl.limiter);
    if (retired) { pt.rpm = Math.max(0, pt.rpm - 3000 * dt); }
    ctrl.up = false; ctrl.down = false;

    // ------------------------------------------------------ wheel spin integration (semi-implicit)
    const Iw = C.Iw;
    // fronts
    for (let i = 0; i < 2; i++) {
      if (dm.wheelOff[i]) { this.wOmega[i] = 0; continue; }
      const R = C.Rw[i] * (1 - 0.1 * this.tires[i].puncture);
      const net = -this.fxw[i] * R - 0.012 * this.fz[i] * R * 0.3 * Math.sign(this.wOmega[i]);
      const k = this.tires[i].slopeX(this.fz[i]) * R / Math.max(Math.abs(u), 3.0);
      const a = (dt * R * k) / Iw;
      let w = this.wOmega[i] + (dt * net) / Iw / (1 + a);
      w = this.applyBrake(w, brakes.torque[i], Iw, dt);
      this.wOmega[i] = w;
    }
    // rear axle (common + differential mode)
    {
      const iL = 2, iR = 3;
      const RL = C.Rw[iL] * (1 - 0.1 * this.tires[iL].puncture), RR = C.Rw[iR] * (1 - 0.1 * this.tires[iR].puncture);
      const wL = this.wOmega[iL], wR = this.wOmega[iR];
      const wd = wL - wR;
      // LSD: preload + load-dependent locking
      const lockMax = this.setup.diffPreload + this.setup.diffPower * Math.abs(axleT);
      let tLock = clamp(K_DIFF * wd, -lockMax, lockMax);
      const driveL = axleT * 0.5 - tLock, driveR = axleT * 0.5 + tLock;
      const dL = dm.wheelOff[iL], dR = dm.wheelOff[iR];
      const netL = dL ? 0 : driveL - this.fxw[iL] * RL;
      const netR = dR ? 0 : driveR - this.fxw[iR] * RR;
      const kL = this.tires[iL].slopeX(this.fz[iL]) * RL / Math.max(Math.abs(u), 3.0);
      const kR = this.tires[iR].slopeX(this.fz[iR]) * RR / Math.max(Math.abs(u), 3.0);
      const Iref = pt.reflectedInertia();
      const Ic = 2 * Iw + Iref;
      const S = netL + netR, D = netL - netR;
      const ac = (dt * ((RL * kL) + (RR * kR))) / Ic;
      const ad = (dt * ((RL * kL + RR * kR) * 0.5 + 2 * K_DIFF)) / Iw;
      const dwc = (dt * S) / Ic / (1 + ac);
      const dwd = (dt * D) / Iw / (1 + ad);
      const wc = 0.5 * (wL + wR) + dwc;
      const wdn = wd + dwd;
      let nl = wc + 0.5 * wdn, nr = wc - 0.5 * wdn;
      if (dL) nl = 0; if (dR) nr = 0;
      nl = this.applyBrake(nl, brakes.torque[iL], Iw + Iref * 0.5, dt);
      nr = this.applyBrake(nr, brakes.torque[iR], Iw + Iref * 0.5, dt);
      this.wOmega[iL] = nl; this.wOmega[iR] = nr;
    }
    for (let i = 0; i < 4; i++) this.wheelAngle[i] += this.wOmega[i] * dt;

    // ------------------------------------------------------ chassis forces
    const dragF = aero.drag;
    const sp = speed > 0.5 ? speed : 0.5;
    const Fdx = -dragF * u / sp, Fdy = -dragF * v / sp * 1.5;
    FxB += Fdx; FyB += Fdy;
    this.dragN = dragF; this.downN = aero.downF + aero.downR;
    // gravity on slopes (world frame): downhill = -grad(y)
    const gx = -G * (loc.slope * loc.tx + loc.cross * loc.lx);
    const gz = -G * (loc.slope * loc.tz + loc.cross * loc.lz);
    const ax = (FxB * sn + FyB * cs) / m + gx;
    const az = (FxB * cs - FyB * sn) / m + gz;
    this.ax = ax; this.ay = az;
    this.axBody = FxB / m; this.ayBody = FyB / m;
    // aero yaw damping (small) + damage-induced asymmetric drag/downforce
    let Mdam = 0;
    Mdam += (dm.fwR - dm.fwL) * 0.3 * aero.drag * 0.18;
    const yawDamp = -0.2 * speed * this.r * m * 0.02;
    this.vx += ax * dt; this.vz += az * dt;
    this.r += ((Mz + Mdam + yawDamp) / Iz) * dt;
    // rest / parking hold
    if (speed < 0.4 && thr < 0.02 && (brk > 0.1 || retired || this.rest)) {
      this.vx *= 0.9; this.vz *= 0.9; this.r *= 0.9;
    }
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.psi += this.r * dt;
    if (this.psi > Math.PI) this.psi -= 2 * Math.PI; else if (this.psi < -Math.PI) this.psi += 2 * Math.PI;
    this.distance += speed * dt;

    // ------------------------------------------------------ body DOFs integration (using this step's forces)
    const FzSum = F0[0] + F0[1] + F0[2] + F0[3];
    const Fx_gnd = FxB - Fdx; // ground forces only
    const Mpitch = (C.hcg * (1 - C.antiPitch)) * (Fx_gnd) + aero.drag * C.hDrag + (-aero.downF * C.a + aero.downR * C.b)
      + (F0[0] * C.a + F0[1] * C.a - F0[2] * C.b - F0[3] * C.b);
    const Fy_gnd = FyB - Fdy;
    const hRc = 0.5 * (C.hRcF + C.hRcR);
    const Mroll = Fy_gnd * (C.hcg - hRc) + (F0[0] * C.tf / 2 - F0[1] * C.tf / 2 + F0[2] * C.tr / 2 - F0[3] * C.tr / 2);
    this.hv += ((FzSum - this.downN - extraDown) / mS) * dt;
    this.thv += (Mpitch / Ip) * dt;
    this.phv += (Mroll / Ir) * dt;
    this.h += this.hv * dt; this.th += this.thv * dt; this.ph += this.phv * dt;
    // soft stops (plank / bump stops)
    if (this.h < -0.045) { this.h = -0.045; if (this.hv < 0) this.hv *= -0.2; }
    if (this.h > 0.05) { this.h = 0.05; if (this.hv > 0) this.hv = 0; }
    this.th = clamp(this.th, -0.05, 0.05); this.ph = clamp(this.ph, -0.05, 0.05);
    // floor contact -> sparks
    const lowest = Math.max(-(this.h + C.a * this.th), -(this.h - C.b * this.th)) * 1000; // mm of compression front/rear
    this.sparks = clamp((lowest - 38) / 14, 0, 1) * (speed > 15 ? 1 : 0);
    this.kerbShake = Math.abs(this.gf[0] - this.gfPrev[0]) + Math.abs(this.gf[1] - this.gfPrev[1]);

    // ------------------------------------------------------ brake heat (uses new wheel speeds)
    brakes.heat(dt, this.wOmega, speed, tAir);

    // ------------------------------------------------------ sanity
    if (!(Math.abs(this.x) < 1e6) || !(Math.abs(this.vx) < 500) || !(Math.abs(this.vz) < 500) || !(Math.abs(this.r) < 60)) this.recover(track);
  }

  applyBrake(w, T, I, dt) {
    if (T <= 0) return w;
    const dw = (dt * T) / I;
    if (Math.abs(w) <= dw) return 0;
    return w > 0 ? w - dw : w + dw;
  }

  recover(track) {
    const s = this.loc.s;
    this.place(track, s, 0, 0);
  }

  get speedKmh() { return this.speed * 3.6; }
}
