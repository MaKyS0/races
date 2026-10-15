// OpponentAI: drives a normal physics Vehicle through its control inputs (throttle / brake / steer / DRS), nothing else.
// Racing line + speed profile give the reference; reactive layers handle traffic, overtaking, defending, errors and pit stops.
import { clamp, wrapPi, makeRng } from '../core/math.js';
import { CAR } from '../physics/VehiclePhysics.js';

const WB = CAR.a + CAR.b;
const PASS_OFF = 3.6;   // max lateral offset from the racing line while passing (m)
const IDM_A = 9;   // following law: free-road acceleration scale (m/s^2)

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
    this.squeeze = 0;
    this.exitWait = 0; this.offCmd = 0;
    this.merge = null;       // {n, s0}: smooth join from the pit exit onto the racing line
    this.startLane = null;   // {n, s0}: hold the grid lane until the field has spread out
  }

  // ------------------------------------------------------------------ helpers
  /** usable half-widths for the car CENTRE at sample j: inside the track edge and clear of the barrier (car half width + tyre + margin) */
  limL(j) { const tr = this.track; return Math.min(tr.wl[j] - 1.0, tr.wallL[j] - 2.5); }
  limR(j) { const tr = this.track; return Math.min(tr.wr[j] - 1.0, tr.wallR[j] - 2.5); }
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
      if (pit.state === PIT.TOBOX && toBox < 4.5 && toBox > -5 && speed < 0.8) { pit.state = PIT.SERVICE; pit.timer = 0; }
      if (pit.state === PIT.SERVICE) { pit.timer += dt; }
      if (pit.state === PIT.EXIT && !car.inPit) { pit.state = PIT.NONE; pit.want = false; pit.served = true; pitMode = false; this.merge = { n: loc.n, s0: loc.s }; this.exitWait = 0; }
      if (pit.state === PIT.ENTRY && !car.inPit && tr.delta(loc.s, tr.pitInS) < -400 && toBox > 600) { pit.state = PIT.NONE; pitMode = false; }
    }

    // ---------------------------------------------------------------- reference path
    let look = clamp(7 + 0.42 * speed, 9, 55);
    if (speed < 6) look = 8;
    const iLook = (i + Math.round(look / ds)) % N;
    if (this.merge) { const dm = tr.delta(this.merge.s0, loc.s); if (dm > 260 || dm < -50) this.merge = null; }
    if (this.startLane) { const dd = tr.delta(this.startLane.s0, loc.s); if (dd > 800 || dd < -50) this.startLane = null; }
    let nLine = this.baseN(iLook);

    // lateral planning (traffic) -------------------------------------------------------------
    const wl = this.limL(iLook) - 0.25, wr = this.limR(iLook) - 0.25;
    let desiredOff = 0;
    const myN = loc.n;
    this.pressure = 0;
    if (!pitMode && ctx.race !== false) {
      const ah = this.startLane ? null : ctx.ahead, bh = this.startLane ? null : ctx.behind;
      // overtaking
      if (ah && ctx.aheadGap < 55 && ctx.aheadGap > 1 && !ctx.noPass) {
        const closing = speed - ah.speed;
        this.pressure = clamp(1 - ctx.aheadGap / 55, 0, 1);
        // a braking zone / corner entry within ~130 m: do not start a new pass (the path back to the line would be too sharp)
        const iZone = (i + Math.round((70 + speed * 1.6) / ds)) % N;
        const zoneAhead = this.profAt(iZone) < 0.86 * speed;
        if (this.passSide === 0 && !zoneAhead && (closing > -3 || ctx.aheadGap < 26)) {
          // inside of the next corner, else the side with more room
          let kSum = 0; for (let q = 0; q < 12; q++) kSum += tr.k[(i + 10 + q * 12) % N];
          const aheadN = ah.loc.n;
          let side = kSum > 0 ? 1 : -1;
          const dn0 = myN - ah.loc.n; if (Math.abs(dn0) > 1.0) side = dn0 > 0 ? 1 : -1;   // never cross the leader's path
          const roomL = tr.wl[i] - 1.3 - aheadN, roomR = aheadN + tr.wr[i] - 1.3;
          if ((side > 0 && roomL < 2.0) || (side < 0 && roomR < 2.0)) side = Math.abs(dn0) > 1.0 ? 0 : -side;
          if ((side > 0 && roomL < 2.0) && (side < 0 && roomR < 2.0)) side = 0;
          this.passSide = side; this.passTimer = 2.5 + rng() * 1.5;
        }
        if (this.passSide !== 0) {
          const target = ah.loc.n + this.passSide * 2.9;
          desiredOff = clamp(clamp(target, -wr, wl) - nLine, -PASS_OFF, PASS_OFF);
        }
      } else if (this.passSide !== 0) {
        this.passTimer -= dt;
        if (this.passTimer <= 0 || !ah || ctx.aheadGap > 70 || (this.profAt((i + Math.round((60 + speed * 1.2) / ds)) % N) < 0.8 * speed && ctx.aheadGap > 6)) this.passSide = 0;
        else if (ah) desiredOff = clamp(clamp(ah.loc.n + this.passSide * 2.9, -wr, wl) - nLine, -PASS_OFF, PASS_OFF);
      }
      // defend: nudge towards the car behind once when it is close and about to try the inside
      if (bh && ctx.behindGap < 14 && this.aggression > 0.45 && this.passSide === 0 && Math.abs(bh.loc.n - myN) < 3.4 && speed > 25) {
        const dn = bh.loc.n - myN;
        if (Math.abs(dn) > 0.8) { this.defendTimer = 1.2; }
        if (this.defendTimer > 0) desiredOff += clamp(dn, -1.4, 1.4) * 0.7;
      }
      this.defendTimer = Math.max(0, this.defendTimer - dt);
    }
    // smooth the offset
    const rate = 3.2 * dt;
    this.off += clamp(desiredOff - this.off, -rate, rate);
    let nTarget = nLine + this.off;
    if (!pitMode) nTarget = clamp(nTarget, -this.limR(iLook), this.limL(iLook));
    // never share the same piece of road with a neighbour: keep the lateral target at least `need` metres away from
    // anyone alongside (hard constraint; the speed controller handles the rest)
    if (!pitMode || car.inPit) {
      const nb = ctx.neighbors;
      let minT = -1e9, maxT = 1e9;
      for (let q = 0; q < ctx.nNeighbors; q++) {
        const o = nb[q];
        if (o === car || o.inPit !== car.inPit) continue;
        const ds2 = tr.delta(loc.s, o.loc.s);
        if (Math.abs(ds2) > 8.5) continue;
        const need = 2.6 + Math.min(0.6, Math.abs(car.speed - o.speed) * 0.03);
        if (o.loc.n > myN) { if (o.loc.n - need < maxT) maxT = o.loc.n - need; }
        else { if (o.loc.n + need > minT) minT = o.loc.n + need; }
        this.pressure = Math.max(this.pressure, 0.6);
      }
      if (minT > -1e8 || maxT < 1e8) {
        const lo = -this.limR(iLook), hi = this.limL(iLook);
        if (minT > maxT) { nTarget = 0.5 * (minT + maxT); this.squeeze = 1; }
        else { nTarget = clamp(nTarget, minT, maxT); this.squeeze = 0; }
        // never leave the road to make room; if there is no room, lift instead
        if (nTarget < lo || nTarget > hi) { nTarget = clamp(nTarget, lo, hi); this.squeeze = 1; }
      } else this.squeeze = 0;
    }

    // the final lateral command (after the hard constraints) moves at a limited lateral speed: no step inputs to the steering
    if (!pitMode) {
      const want = nTarget - nLine, lim2 = clamp(speed * 0.09, 1.8, 5.5) * dt;
      this.offCmd += clamp(want - this.offCmd, -lim2, lim2);
      nTarget = nLine + this.offCmd;
    } else this.offCmd = nTarget - nLine;
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

    // ---------------------------------------------------------------- steering: curvature feed-forward + Stanley feedback
    const sn = Math.sin(car.psi), cs = Math.cos(car.psi);
    // path (racing line + lateral offsets) at the car and a short way ahead
    const iA = i, iB = (i + 6) % N;
    const nA = this.pathN(iA, nTarget, nLine, pitMode, tr, loc);
    const nB = this.pathN(iB, nTarget, nLine, pitMode, tr, loc);
    const ax = tr.x[iA] + Math.cos(tr.psi[iA]) * nA, az = tr.z[iA] - Math.sin(tr.psi[iA]) * nA;
    const bx = tr.x[iB] + Math.cos(tr.psi[iB]) * nB, bz = tr.z[iB] - Math.sin(tr.psi[iB]) * nB;
    const phi = Math.atan2(bx - ax, bz - az);
    const ect = (ax - car.x) * Math.cos(phi) + (az - car.z) * (-Math.sin(phi));
    const course = speed > 8 ? Math.atan2(car.vx, car.vz) : car.psi;
    const ePsi = wrapPi(phi - course);
    // feed-forward from the curvature of the path a fraction of a second ahead
    const iF = (i + Math.max(1, Math.round((3 + speed * 0.13) / ds))) % N;
    let kF = tr.lineK[iF];
    if (pitMode) kF = tr.k[iF];
    let dFF = Math.atan(WB * kF) + 0.0006 * speed * speed * kF;
    let delta = dFF + 0.9 * ePsi + Math.atan((1.6 * ect) / (speed + 4));
    // counter-steer when the rear steps out
    const rearSlip = Math.atan2(car.v - car.r * CAR.b, Math.max(4, Math.abs(car.u)));
    if (Math.abs(rearSlip) > 0.05 && speed > 8) delta += clamp(-rearSlip * 0.9, -0.25, 0.25) * clamp((Math.abs(rearSlip) - 0.05) / 0.06, 0, 1);
    // never ask for more steering than the tyres can use
    {
      const dfS = car.aero.downF + car.aero.downR;
      const ayCap = 1.9 * (9.81 + dfS / car.mass);
      const dCap = (WB * ayCap) / Math.max(speed * speed, 25) + 0.075;
      delta = clamp(delta, -dCap, dCap);
    }
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
    if (this.squeeze) vt *= 0.9;
    vt *= 1 - clamp(Math.abs(this.offCmd) * 0.018, 0, 0.1);   // a path away from the racing line is longer / tighter
    // aggression lets AI brake a little later when attacking
    if (this.passSide !== 0) vt *= 1 + 0.012 * this.aggression;
    // car following: IDM-style law. The desired gap grows with speed and with the closing speed, and the leader's own
    // braking (measured deceleration, looked 0.35 s ahead) counts as closing speed, so a braking zone does not cascade.
    const ah = ctx.ahead;
    this.followGap = 999;
    if (ah && !pitMode && ctx.race !== false) {
      const g = ctx.aheadGap;
      // in the way if it is beside me now OR will be on the line I am about to take
      const iAh = (i + Math.round(Math.max(0, ctx.aheadGap + 5) / ds)) % N;
      const nPathAh = tr.line[iAh] + this.off;
      const sameLane = Math.abs(ah.loc.n - myN) < 2.3 || Math.abs(ah.loc.n - nPathAh) < 2.3;
      if (g < 200 && sameLane && (this.passSide === 0 || g < 9)) {
        this.followGap = g;
        const lead = ah.retired || ah.speed < 3 ? 0 : Math.max(0, -ah.axBody) * 0.35;
        const dvC = Math.max(0, speed - ah.speed + lead);              // closing speed incl. the leader's own braking
        const need = (dvC * dvC) / (2 * Math.max(g - 2, 0.3));         // deceleration needed to match speeds before contact
        const hold = 2.5 + 0.32 * speed;                                // wanted gap
        const restore = Math.min(IDM_A * (hold / Math.max(g, 0.4)) ** 2, 12);
        const sp = Math.min(speed / Math.max(vt, 10), 2);
        const aF = IDM_A * (1 - sp * sp * sp * sp) - restore - 1.25 * need;
        if (aF < 0) vt = Math.min(vt, Math.max(0, speed + aF * 0.6));
      }
    }
    // time-to-collision layer: independent of lanes and of who is 'ahead'. Constant-velocity prediction of every nearby car
    // (stopped wrecks included) against my box; brake so the predicted contact cannot happen.
    if (!pitMode || car.inPit) {
      const sn2 = Math.sin(car.psi), cs2 = Math.cos(car.psi);
      let aNeed = 0;
      for (let q = 0; q < ctx.nNear; q++) {
        const o = ctx.near[q];
        const dx = o.x - car.x, dz = o.z - car.z;
        const x0 = dx * sn2 + dz * cs2, y0 = dx * cs2 - dz * sn2;
        if (x0 < 0.5) continue;                                   // only things in front: whoever is behind brakes for me
        const dvx = o.vx - car.vx, dvz = o.vz - car.vz;
        const vxr = dvx * sn2 + dvz * cs2, vyr = dvx * cs2 - dvz * sn2;
        if (vxr > -0.5) continue;                                 // not closing
        const hx = 5.7, hy = 2.5;                                 // combined half extents + margin
        let ty0, ty1;
        if (Math.abs(vyr) < 0.05) { if (Math.abs(y0) >= hy) continue; ty0 = 0; ty1 = 99; }
        else { const a1 = (-hy - y0) / vyr, a2 = (hy - y0) / vyr; ty0 = Math.min(a1, a2); ty1 = Math.max(a1, a2); }
        const tx0 = (x0 - hx) / -vxr, tx1 = (x0 + hx) / -vxr;
        const tIn = Math.max(tx0, ty0, 0), tOut = Math.min(tx1, ty1);
        if (tIn >= tOut || tIn > 2.6) continue;
        const gap = Math.max(x0 - hx, 0.3), vc = -vxr;
        const a = (vc * vc) / (2 * gap);                            // constant deceleration that just avoids contact
        if (a > aNeed) aNeed = a;
      }
      if (aNeed > 2.5) vt = Math.min(vt, Math.max(0, speed - aNeed * 0.8));
    }
    this.aNeed = 0;
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
        vt = Math.min(vt, Math.max(0.0, Math.sqrt(2 * 5 * Math.max(0, toBox - 1.2))));
      }
      if (pit.state === PIT.SERVICE) vt = 0;
      if (pit.state === PIT.EXIT) { vt = Math.min(vt, lim * 0.97); this.limiterLane = true; }
      if (pit.state === PIT.EXIT && tr.pitZone[i] === 3) { this.limiterLane = true; vt = Math.min(vt, lim); }
      // red light at the pit exit while a fast car is about to pass the merge point (max 12 s)
      if (pit.state === PIT.EXIT && ctx.pitExitBusy && this.exitWait < 12) {
        const toOut = tr.delta(loc.s, tr.pitOutS);
        if (toOut > 0 && toOut < 70) { vt = Math.min(vt, Math.max(0, Math.sqrt(2 * 8 * Math.max(0, toOut - 12)))); if (speed < 3) this.exitWait += dt; }
      }
    }
    if (this.holdPit) vt = 0;
    // off-track recovery: crawl back
    const edge = myN >= 0 ? tr.wl[i] : tr.wr[i];
    const offTrack = !pitMode && Math.abs(myN) > edge + 1.8;
    if (offTrack) vt = Math.min(vt, speed > 25 ? Math.max(20, speed - 15) : 20);
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
      const thrCap = clamp((1 - used) * 1.9, 0.08, 1) * (speed < 40 ? clamp(1 - 0.7 * Math.abs(ctrl.steer), 0.25, 1) : 1);   // less power while the wheel is turned (slow corners)
      if (thr > thrCap) thr = thrCap;
      if (brk > 0) brk *= Math.sqrt(Math.max(0.12, 1 - used * used * 0.9));
    }
    // smooth traction: no throttle if sliding laterally
    const slideLat = Math.abs(rearSlip);
    if (slideLat > 0.10) thr *= clamp(1 - (slideLat - 0.10) / 0.12, 0.1, 1);
    if (over > 0.15) thr *= 1 - 0.8 * over;
    if (this.mistake.kind === 2 && this.mistake.t > 0) thr = 1;
    // launch / pit exit
    // throttle slew: a sudden lift in the middle of a corner is what unsettles the rear
    { const prev = ctrl.throttle; const up = 7 * dt, down = (car.speed > 25 ? 3.2 : 8) * dt; thr = clamp(thr, prev - down, prev + up); if (brk > 0.05) thr = 0; }
    ctrl.throttle = thr; ctrl.brake = brk;
    ctrl.limiter = this.limiterLane;
    ctrl.drs = this.drsWanted && Math.abs(ctrl.steer) < 0.12;

    // stuck detection (grass/gravel traps)
    if (!car.retired && !pitMode && !this.holdPit && speed < 1.5 && ctx.race !== false) {
      this.stuckT += dt;
      if (this.stuckT > 30) { car.retired = true; car.retireReason = 'Stuck'; }
    } else this.stuckT = Math.max(0, this.stuckT - dt);
  }

  /** lateral coordinate of the intended path at sample j (line + the current offsets, pit lane when in pit mode) */
  pathN(j, nTarget, nLineHere, pitMode, tr, loc) {
    if (pitMode) {
      const kind = this.pit.state === PIT.TOBOX || this.pit.state === PIT.SERVICE ? 'box' : 'fast';
      return tr.pitZone[j] === 0 ? tr.line[j] : tr.pitLaneN(j, kind);
    }
    // keep the offset implied by nTarget (which already contains the lane/neighbour constraints)
    return this.baseN(j) + (nTarget - nLineHere);
  }
  /** racing line, or the grid lane blended into it during the first metres of a race */
  baseN(j) {
    const tr = this.track;
    const line = tr.line[j];
    if (this.merge) {
      const dm = tr.delta(this.merge.s0, j * tr.ds);
      const w = Math.min(1, Math.max(0, dm / 170)), sw = w * w * (3 - 2 * w);
      return this.merge.n * (1 - sw) + line * sw;
    }
    if (!this.startLane) return line;
    const dist = tr.delta(this.startLane.s0, j * tr.ds);
    const w = Math.min(1, Math.max(0, (dist - 180) / 520)), sw = w * w * (3 - 2 * w);
    return this.startLane.n * (1 - sw) + line * sw;
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
