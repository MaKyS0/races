// OpponentAI: drives a normal physics Vehicle through its control inputs (throttle / brake / steer / DRS), nothing else.
// Racing line + speed profile give the reference; reactive layers handle traffic, overtaking, defending, errors and pit stops.
import { clamp, wrapPi, makeRng } from '../core/math.js';
import { CAR } from '../physics/VehiclePhysics.js';

const WB = CAR.a + CAR.b;

export const PIT = { NONE: 0, ENTRY: 1, TOBOX: 2, SERVICE: 3, EXIT: 4 };

export class DriverAI {
  constructor(car, track, profile, params = {}) {
    this.car = car; this.track = track; this.profile = profile;
    const seed = params.seed ?? (car.id * 7919 + 13);
    this.rng = makeRng(seed);
    this.skill = params.skill ?? 0.95;           // 0.85 .. 1.0 -> pace multiplier on the profile
    this.aggression = params.aggression ?? 0.5;  // willingness to overtake / late-brake
    this.consistency = params.consistency ?? 0.9;
    this.errorScale = params.errorScale ?? 1;
    this.pace = 1;                               // set by RaceManager (quali / out lap / in lap / SC ...)
    this.off = 0;                                // lateral offset from the racing line (m)
    this.passSide = 0; this.passTimer = 0; this.defendTimer = 0;
    this.pit = { state: PIT.NONE, box: 0, timer: 0, serviceTime: 3.2, want: false, served: false };
    this.mistake = { kind: 0, t: 0, mul: 1, cornerDone: -1 };
    this.cornerIdx = -1;
    this.stuckT = 0;
    this.enabled = true;
    this.targetSpeed = 0; this.pressure = 0;
    this.holdPit = false;                        // stay in the garage / box
    this.limiterLane = false;
    this.followGap = 0;
    this.lastCommandSteer = 0;
    this.rejoinMode = false;
    this.drsWanted = false;
  }

  // ------------------------------------------------------------------ helpers
  profAt(i) { return this.profile.v[((i % this.track.N) + this.track.N) % this.track.N]; }

  /** target lateral coordinate n at sample i (racing line + offsets, pit lane overrides) */
  update(dt, ctx) {
    const car = this.car, tr = this.track, loc = car.loc, ctrl = car.ctrl;
    if (!this.enabled) return;
    const N = tr.N, ds = tr.ds;
    const speed = car.speed;
    const i = loc.i;
    const pit = this.pit;
    const rng = this.rng;

    // ---------------------------------------------------------------- pit state machine
    const lim = tr.pitSpeedLimit;
    let pitMode = pit.state !== PIT.NONE;
    if (!pitMode && pit.want && !this.holdPit) {
      const toIn = tr.delta(loc.s, tr.pitInS - 40);
      if (toIn >= 0 && toIn < 260) { pit.state = PIT.ENTRY; pitMode = true; }
    }
    let boxS = 0;
    if (pitMode) {
      boxS = tr.pitBoxes[pit.box].s;
      const toBox = tr.delta(loc.s, boxS);
      if (pit.state === PIT.ENTRY && car.inPit && toBox < 160) pit.state = PIT.TOBOX;
      if (pit.state === PIT.TOBOX && toBox < 2.2 && speed < 0.8) { pit.state = PIT.SERVICE; pit.timer = 0; }
      if (pit.state === PIT.SERVICE) { pit.timer += dt; }
      if (pit.state === PIT.EXIT && !car.inPit) { pit.state = PIT.NONE; pit.want = false; pit.served = true; pitMode = false; }
      if (pit.state === PIT.ENTRY && !car.inPit && tr.delta(loc.s, tr.pitInS) < -400 && toBox > 600) { pit.state = PIT.NONE; pitMode = false; }
    }

    // ---------------------------------------------------------------- reference path
    let look = clamp(7 + 0.42 * speed, 9, 55);
    if (speed < 6) look = 8;
    const iLook = (i + Math.round(look / ds)) % N;
    let nLine = tr.line[iLook];
    let nHere = tr.line[i];

    // lateral planning (traffic) -------------------------------------------------------------
    const wl = tr.wl[iLook] - 1.25, wr = tr.wr[iLook] - 1.25;
    let desiredOff = 0;
    const myN = loc.n;
    this.pressure = 0;
    if (!pitMode && ctx.race !== false) {
      const ah = ctx.ahead, bh = ctx.behind;
      // overtaking
      if (ah && ctx.aheadGap < 34 && ctx.aheadGap > 1 && !ctx.noPass) {
        const closing = speed - ah.speed;
        this.pressure = clamp(1 - ctx.aheadGap / 34, 0, 1);
        if (this.passSide === 0 && (closing > -3 || ctx.aheadGap < 16)) {
          // inside of the next corner, else the side with more room
          let kSum = 0; for (let q = 0; q < 12; q++) kSum += tr.k[(i + 10 + q * 12) % N];
          const aheadN = ah.loc.n;
          let side = kSum > 0 ? 1 : -1;
          const roomL = tr.wl[i] - 1.3 - aheadN, roomR = aheadN + tr.wr[i] - 1.3;
          if ((side > 0 && roomL < 2.0) || (side < 0 && roomR < 2.0)) side = -side;
          if ((side > 0 && roomL < 2.0) && (side < 0 && roomR < 2.0)) side = 0;
          this.passSide = side; this.passTimer = 2.5 + rng() * 1.5;
        }
        if (this.passSide !== 0) {
          const target = ah.loc.n + this.passSide * 2.35;
          desiredOff = clamp(target, -wr, wl) - nLine;
        }
      } else if (this.passSide !== 0) {
        this.passTimer -= dt;
        if (this.passTimer <= 0 || !ah || ctx.aheadGap > 45) this.passSide = 0;
        else if (ah) desiredOff = clamp(ah.loc.n + this.passSide * 2.35, -wr, wl) - nLine;
      }
      // defend: nudge towards the car behind once when it is close and about to try the inside
      if (bh && ctx.behindGap < 14 && this.aggression > 0.45 && this.passSide === 0) {
        const dn = bh.loc.n - myN;
        if (Math.abs(dn) > 0.8) { this.defendTimer = 1.2; }
        if (this.defendTimer > 0) desiredOff += clamp(dn, -1.4, 1.4) * 0.7;
      }
      this.defendTimer = Math.max(0, this.defendTimer - dt);
      // never share the same piece of road with a neighbour
      const nb = ctx.neighbors;
      for (let q = 0; q < ctx.nNeighbors; q++) {
        const o = nb[q];
        if (o === car) continue;
        const ds2 = tr.delta(loc.s, o.loc.s);
        if (Math.abs(ds2) > 7.5) continue;
        const dn = myN - o.loc.n;
        const need = 2.45;
        if (Math.abs(dn) < need) {
          const side = Math.abs(dn) < 0.05 ? (car.id > o.id ? 1 : -1) : Math.sign(dn);
          desiredOff += side * (need - Math.abs(dn)) * 0.9;
          this.pressure = Math.max(this.pressure, 0.6);
        }
      }
    }
    // smooth the offset
    const rate = 3.2 * dt;
    this.off += clamp(desiredOff - this.off, -rate, rate);
    let nTarget = nLine + this.off;
    if (!pitMode) nTarget = clamp(nTarget, -tr.wr[iLook] + 1.0, tr.wl[iLook] - 1.0);

    // pit lane lateral targets
    if (pitMode) {
      const kind = (pit.state === PIT.TOBOX || pit.state === PIT.SERVICE) && tr.delta(loc.s, boxS) < 45 ? 'box' : 'fast';
      nTarget = tr.pitLaneN(iLook, kind);
      if (pit.state === PIT.ENTRY && !car.inPit) {
        // blend from the racing line while the entry ramp opens
        const z = tr.pitZone[iLook];
        if (z === 0) nTarget = nLine;
      }
    }

    // ---------------------------------------------------------------- steering (pure pursuit + slide catching)
    const sn = Math.sin(car.psi), cs = Math.cos(car.psi);
    // target point in world
    const lx = tr.x[iLook] + Math.cos(tr.psi[iLook]) * nTarget;
    const lz = tr.z[iLook] - Math.sin(tr.psi[iLook]) * nTarget;
    const dx = lx - car.x, dz = lz - car.z;
    const fwd = dx * sn + dz * cs, lat = dx * cs - dz * sn;
    const dist = Math.max(4, Math.hypot(fwd, lat));
    let alpha = Math.atan2(lat, Math.max(fwd, 0.5));
    let delta = Math.atan((2 * WB * Math.sin(alpha)) / dist);
    // lateral error feedback (keeps the line against understeer)
    const nErr = (nTarget - myN);
    delta += clamp(nErr * 0.004, -0.02, 0.02);
    // counter-steer when the rear steps out
    const rearSlip = Math.atan2(car.v - car.r * CAR.b, Math.max(4, Math.abs(car.u)));
    if (Math.abs(rearSlip) > 0.05 && speed > 8) delta += clamp(-rearSlip * 0.9, -0.25, 0.25) * clamp((Math.abs(rearSlip) - 0.05) / 0.06, 0, 1);
    const lock = car.steerLock();
    ctrl.steer = clamp(delta / lock, -1, 1);
    // understeer protection: once the front tyres are beyond their peak slip, unwinding the wheel restores grip
    const sFront = Math.max(Math.abs(car.slipA[0]), Math.abs(car.slipA[1]));
    const over = clamp((sFront - 0.12) / 0.10, 0, 1);
    if (over > 0 && speed > 15) ctrl.steer *= 1 - 0.55 * over;

    // ---------------------------------------------------------------- speed target
    const iSpd = (i + Math.round((6 + speed * 0.2) / ds)) % N;
    let vt = this.profAt(iSpd) * this.pace * this.skill * ctx.grip;
    // tyre / damage / fuel pace loss
    vt *= ctx.paceLoss(car);
    // mistakes: overdriving a corner (late brake) or snap throttle on exit
    this.updateMistakes(dt, ctx, loc);
    if (this.mistake.t > 0) { vt *= this.mistake.mul; this.mistake.t -= dt; }
    vt *= 1 - 0.12 * over;
    // aggression lets AI brake a little later when attacking
    if (this.passSide !== 0) vt *= 1 + 0.012 * this.aggression;
    // car following
    const ah = ctx.ahead;
    this.followGap = 999;
    if (ah && !pitMode && ctx.race !== false) {
      const g = ctx.aheadGap;
      const sameLane = Math.abs(ah.loc.n - myN) < 2.4;
      if (g < 40 && sameLane && (this.passSide === 0 || g < 9)) {
        this.followGap = g;
        const des = 6.0 + 0.04 * speed;
        const vFollow = ah.speed + (g - des) * 0.7;
        vt = Math.min(vt, Math.max(vFollow, ah.speed * 0.7));
      }
    }
    // global race-control limits
    if (ctx.sc) vt = Math.min(vt, ctx.scSpeed(car));
    else if (ctx.vsc) vt = Math.min(vt, vt * 0.62);
    if (ctx.yellowNear && ctx.yellowNear(loc.s)) vt *= 0.86;
    // pit lane speed limit & stopping
    this.limiterLane = false;
    if (pitMode) {
      const toLimitPoint = tr.delta(loc.s, tr.pitInS + 20);
      if (toLimitPoint > 0 && pit.state === PIT.ENTRY) vt = Math.min(vt, Math.sqrt(lim * lim + 2 * 22 * toLimitPoint));
      else { vt = Math.min(vt, lim * 0.97); this.limiterLane = true; }
      if (pit.state === PIT.TOBOX || (pit.state === PIT.ENTRY && car.inPit)) {
        const toBox = tr.delta(loc.s, boxS);
        vt = Math.min(vt, Math.max(0.0, Math.sqrt(2 * 9 * Math.max(0, toBox - 0.6))));
      }
      if (pit.state === PIT.SERVICE) vt = 0;
      if (pit.state === PIT.EXIT) { vt = Math.min(vt, lim * 0.97); this.limiterLane = true; }
      if (pit.state === PIT.EXIT && tr.pitZone[i] === 3) { this.limiterLane = true; vt = Math.min(vt, lim); }
    }
    if (this.holdPit) vt = 0;
    // off-track recovery: crawl back
    const edge = myN >= 0 ? tr.wl[i] : tr.wr[i];
    const offTrack = !pitMode && Math.abs(myN) > edge + 1.8;
    if (offTrack) vt = Math.min(vt, 20);
    this.targetSpeed = vt;

    // ---------------------------------------------------------------- pedals
    const err = vt - speed;
    let thr = 0, brk = 0;
    if (err > 0) {
      thr = clamp(err * 0.55 + (vt > 30 ? 0.12 : 0), 0, 1);
      if (vt < 1) thr = 0;
    } else {
      // brake pedal limited by what the tyres can take (a human would modulate; the AI uses a conservative envelope)
      const df = car.aero.downF + car.aero.downR;
      const maxForce = 1.95 * ctx.grip * (car.mass * 9.81 + df);
      const pedalCap = clamp((maxForce * 0.34) / car.brakes.capacity * 0.92, 0.12, 1);
      const want = clamp((-err - 0.4) / 5.0, 0, 1);
      brk = Math.min(want * 1.1, pedalCap);
      if (speed < 2 && vt < 0.5) brk = 0.8;
      // brake-to-throttle blend: coast on small errors
    }
    // friction circle: the more lateral grip is already used, the less throttle / brake pressure is available
    {
      const dfNow = car.aero.downF + car.aero.downR;
      const ayMax = 1.9 * ctx.grip * (9.81 + dfNow / car.mass);
      const used = clamp(Math.abs(car.ayBody) / ayMax, 0, 1.2);
      const thrCap = clamp((1 - used) * 2.4, 0.08, 1);
      if (thr > thrCap) thr = thrCap;
      if (brk > 0) brk *= Math.sqrt(Math.max(0.12, 1 - used * used * 0.9));
    }
    // smooth traction: no throttle if sliding laterally
    const slideLat = Math.abs(rearSlip);
    if (slideLat > 0.10) thr *= clamp(1 - (slideLat - 0.10) / 0.12, 0.1, 1);
    if (over > 0.15) thr *= 1 - 0.8 * over;
    if (this.mistake.kind === 2 && this.mistake.t > 0) thr = 1;
    // launch / pit exit
    ctrl.throttle = thr; ctrl.brake = brk;
    ctrl.limiter = this.limiterLane;
    ctrl.drs = this.drsWanted && Math.abs(ctrl.steer) < 0.12;

    // stuck detection (grass/gravel traps)
    if (!car.retired && !pitMode && !this.holdPit && speed < 1.5 && ctx.race !== false) {
      this.stuckT += dt;
      if (this.stuckT > 12) { car.retired = true; car.retireReason = 'Stuck'; }
    } else this.stuckT = Math.max(0, this.stuckT - dt);
  }

  updateMistakes(dt, ctx, loc) {
    const tr = this.track, mk = this.mistake;
    // detect corner entry: first corner whose entry is within 110 m ahead
    const list = tr.cornerList;
    let idx = -1;
    for (let c = 0; c < list.length; c++) {
      const d = tr.delta(loc.s, list[c].s0);
      if (d > 0 && d < 110) { idx = c; break; }
    }
    if (idx >= 0 && idx !== mk.cornerDone && mk.t <= 0 && ctx.errors) {
      mk.cornerDone = idx;
      const c = list[idx];
      const tight = clamp(1 - c.minR / 200, 0, 1);
      const p = (0.0006 + (1 - this.skill) * 0.28 + (1 - this.consistency) * 0.04 + this.pressure * 0.02 + ctx.wetness * 0.012) * this.errorScale * (0.5 + tight);
      if (this.rng() < p) {
        if (this.rng() < 0.7) { mk.kind = 1; mk.t = 4.2; mk.mul = 1.06 + this.rng() * 0.12 + ctx.wetness * 0.05; }
        else { mk.kind = 2; mk.t = 1.3; mk.mul = 1.0; }
      }
    } else if (idx !== mk.cornerDone && idx >= 0) {
      // keep the memory so we do not roll twice for the same corner
    }
    if (idx < 0) mk.cornerDone = -1;
  }
}
