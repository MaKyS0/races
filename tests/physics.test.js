import { describe, it, expect } from 'vitest';
import { getTrack } from '../src/track/circuits/index.js';
import { Vehicle, CAR } from '../src/physics/VehiclePhysics.js';
import { Tire, shape, COMPOUNDS, SURFACES } from '../src/physics/TireModel.js';
import { computeWake } from '../src/physics/Aerodynamics.js';
import { RPM_LIMIT, GEAR_RATIOS } from '../src/physics/EngineAndTransmission.js';

const track = getTrack('monza');
const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 1 };
const DT = 1 / 120;
function car(opts = {}) {
  const c = new Vehicle(0);
  c.assists.tc = opts.tc ?? 0; c.assists.abs = opts.abs ?? 0; c.assists.steer = 0;
  Object.assign(c.setup, opts.setup || {}); c.applySetup();
  c.setFuel(opts.fuel ?? 50); c.fitTyres(opts.compound || 'soft', opts.temp ?? 95);
  c.place(track, opts.s ?? 5600, 0, opts.v ?? 0);
  return c;
}

describe('tyre model', () => {
  it('force curve peaks at normalised slip 1 and falls off gently afterwards', () => {
    let best = 0, at = 0;
    for (let s = 0.05; s < 4; s += 0.01) { const v = shape(s); if (v > best) { best = v; at = s; } }
    expect(at).toBeCloseTo(1, 1); expect(best).toBeCloseTo(1, 2);
    expect(shape(3)).toBeLessThan(shape(1)); expect(shape(3)).toBeGreaterThan(0.6);
  });
  it('grip depends on temperature, wear, water and surface', () => {
    const t = new Tire('soft', 95);
    const grip = (setup) => { setup(t); t.eval(3500, 0, 0.1, SURFACES.asphalt, t._w || 0, 30, 1); return t.mu; };
    const base = grip(() => {});
    t.tSurf = 40; t.tCore = 40; expect(grip(() => {})).toBeLessThan(base * 0.9);
    t.tSurf = 95; t.tCore = 90; t.wear = 0.9; expect(grip(() => {})).toBeLessThan(base * 0.8);
    t.wear = 0;
    t.eval(3500, 0, 0.1, SURFACES.asphalt, 0.8, 20, 1); expect(t.mu).toBeLessThan(base * 0.45);        // slick in heavy water
    const w = new Tire('wet', 60); w.eval(3500, 0, 0.1, SURFACES.asphalt, 0.8, 20, 1); expect(w.mu).toBeGreaterThan(t.mu * 2);
    t.eval(3500, 0, 0.1, SURFACES.grass, 0, 20, 1); expect(t.mu).toBeLessThan(base * 0.55);
  });
  it('aquaplanes at speed on wet tarmac', () => {
    const w = new Tire('inter', 70);
    w.eval(3500, 0, 0.1, SURFACES.asphalt, 0.8, 20, 1); const slow = w.mu;
    w.eval(3500, 0, 0.1, SURFACES.asphalt, 0.8, 95, 1); expect(w.mu).toBeLessThan(slow * 0.7);
  });
  it('wears and heats with slip energy', () => {
    const t = new Tire('soft', 60); t.eval(3500, 0.05, 0.12, SURFACES.asphalt, 0, 50, 1);
    for (let i = 0; i < 600; i++) { t.eval(3500, 0.05, 0.12, SURFACES.asphalt, 0, 50, 1); t.thermal(DT, 3500, 3, 5, 50, 25, 35, 300, 0, 1); }
    expect(t.tSurf).toBeGreaterThan(70); expect(t.wear).toBeGreaterThan(0);
  });
});

describe('vehicle dynamics', () => {
  it('accelerates realistically from standstill (traction control on)', () => {
    const c = car({ tc: 1 }); c.ctrl.throttle = 1;
    let t = 0, t100 = 0, t200 = 0;
    for (let i = 0; i < 120 * 12; i++) { c.step(DT, track, ENV); t += DT; if (!t100 && c.speed * 3.6 >= 100) t100 = t; if (!t200 && c.speed * 3.6 >= 200) t200 = t; }
    expect(t100).toBeGreaterThan(1.9); expect(t100).toBeLessThan(3.2);
    expect(t200).toBeGreaterThan(4.0); expect(t200).toBeLessThan(6.5);
    expect(c.pt.gear).toBeGreaterThanOrEqual(5);
  });
  it('spins the driven wheels when traction control is off', () => {
    const c = car({ tc: 0 }); c.ctrl.throttle = 1; let kmax = 0;
    for (let i = 0; i < 120 * 2; i++) { c.step(DT, track, ENV); kmax = Math.max(kmax, c.kappa[2]); }
    expect(kmax).toBeGreaterThan(0.25);
  });
  it('top speed is limited by drag and depends on wing setting', () => {
    const vmax = (w) => {
      const c = car({ setup: { frontWing: w, rearWing: w }, tc: 1 }); c.place(track, 5000, 0, 70); c.ctrl.throttle = 1;
      let m = 0; for (let i = 0; i < 120 * 30; i++) { c.step(DT, track, { ...ENV, forceSurface: 0 }); c.ctrl.steer = Math.max(-1, Math.min(1, -c.loc.n * 0.15)); m = Math.max(m, c.speed); if (c.distance > 4000) break; }
      return m * 3.6;
    };
    const lo = vmax(0), hi = vmax(10);
    expect(lo).toBeGreaterThan(300); expect(lo).toBeLessThan(380); expect(hi).toBeLessThan(lo - 15);
  });
  it('downforce grows with the square of speed', () => {
    const c = car(); const d = (v) => { c.speed = v; c.aero.update(0.5 * 1.2 * v * v, 0, 0, c.damage); return c.aero.downF + c.aero.downR; };
    expect(d(80) / d(40)).toBeCloseTo(4, 1);
    expect(d(83.3)).toBeGreaterThan(11000);
  });
  it('slipstream cuts drag and dirty air cuts downforce', () => {
    const a = car({ s: 3000 }), b = car({ s: 3012 }); b.id = 1;
    a.x = 0; a.z = 0; a.psi = 0; b.x = 0; b.z = 14; b.psi = 0;   // b is 14 m ahead of a
    computeWake(a, [a, b], 2);
    expect(a.aero.wake).toBeGreaterThan(0.4); expect(a.aero.dirty).toBeGreaterThan(0.3);
    const q = 0.5 * 1.2 * 80 * 80;
    a.aero.update(q, 0, 0, a.damage); const dragWake = a.aero.drag, down = a.aero.downF;
    a.aero.wake = 0; a.aero.dirty = 0; a.aero.update(q, 0, 0, a.damage);
    expect(dragWake).toBeLessThan(a.aero.drag * 0.85); expect(down).toBeLessThan(a.aero.downF);
  });
  it('DRS lowers drag', () => {
    const c = car(); const q = 0.5 * 1.2 * 80 * 80;
    c.aero.drsOpen = 0; c.aero.update(q, 0, 0, c.damage); const closed = c.aero.drag;
    c.aero.drsOpen = 1; c.aero.update(q, 0, 0, c.damage); expect(c.aero.drag).toBeLessThan(closed * 0.92);
  });
  it('braking: weight transfer, lock-up, wet and worn tyres lengthen the stopping distance', () => {
    const run = (o) => {
      const c = car({ v: 300 / 3.6, s: 300, abs: o.abs }); c.pt.gear = 8; c.ctrl.brake = 0; c.step(DT, track, { ...ENV, water: o.water || 0, forceSurface: 0 });
      if (o.worn) for (const t of c.tires) t.wear = o.worn;
      c.ctrl.brake = o.pedal ?? 1;
      let dist = 0, tt = 0, lock = 0, front0 = c.fz[0] + c.fz[1], maxFront = 0, peak = 0;
      while (c.speed * 3.6 > 80 && tt < 20) { c.step(DT, track, { ...ENV, water: o.water || 0, forceSurface: 0 }); dist += c.speed * DT; tt += DT; if (c.kappa[0] < -0.4) lock += DT; maxFront = Math.max(maxFront, c.fz[0] + c.fz[1]); peak = Math.max(peak, -c.axBody / 9.81); }
      return { dist, lock, front0, maxFront, peak, t: tt };
    };
    const dry = run({}), wet = run({ water: 0.6 }), worn = run({ worn: 0.9 }), abs = run({ abs: 2 }), soft = run({ pedal: 0.28 });
    expect(dry.peak).toBeGreaterThan(4.5); expect(dry.peak).toBeLessThan(7.0);
    expect(dry.maxFront).toBeGreaterThan(dry.front0 * 1.3);              // load transfer to the front axle
    expect(dry.lock).toBeGreaterThan(0.3);                                // full pedal locks the fronts
    expect(wet.dist).toBeGreaterThan(dry.dist * 1.8);
    expect(worn.dist).toBeGreaterThan(dry.dist * 1.25);
    expect(abs.lock).toBeLessThan(dry.lock * 0.6);                        // ABS helps ...
    expect(abs.dist).toBeLessThanOrEqual(dry.dist * 1.05);                // ... without being magic
    expect(soft.t).toBeGreaterThan(dry.t);                                // brake force follows the pedal, not instantaneous
    expect(dry.dist).toBeGreaterThan(70); expect(dry.dist).toBeLessThan(200);
  });
  it('brake pressure builds progressively (no instant deceleration)', () => {
    const c = car({ v: 80, s: 300 }); c.ctrl.brake = 1; const env = { ...ENV, forceSurface: 0 };
    c.step(DT, track, env); const a0 = -c.axBody; for (let i = 0; i < 24; i++) c.step(DT, track, env);
    expect(a0).toBeLessThan(-c.axBody * 0.6);
  });
  it('brake discs heat up, fade when too hot and are weak when cold', () => {
    const c = car({ v: 90, s: 300 }); const cold = c.brakes.temp[0];
    c.ctrl.brake = 0.5; for (let i = 0; i < 300; i++) c.step(DT, track, { ...ENV, forceSurface: 0 });   // modulated braking: discs, not tyres, dissipate the energy
    expect(c.brakes.temp[0]).toBeGreaterThan(cold + 150);
    expect(c.brakes.efficiency[0]).toBeGreaterThan(0.8);
    const k = car(); k.brakes.temp.fill(60); k.ctrl.brake = 1; k.step(DT, track, ENV); expect(k.brakes.efficiency[0]).toBeLessThan(0.6);
  });
  it('a corner taken too fast leaves the car understeering wide (physical consequence)', () => {
    const lat = (v) => { const c = car({ v, s: 300 }); c.assists.steer = 0; c.steer = 0.1; c.ctrl.steer = 0.1 / 0.36; const e = { ...ENV, forceSurface: 0 }; for (let i = 0; i < 240; i++) { c.ctrl.throttle = c.speed < v ? 0.7 : 0.05; c.step(DT, track, e); } return { ay: Math.abs(c.ayBody) / 9.81, v: c.speed }; };
    const slow = lat(25), fast = lat(80);
    const kin = (v) => (v * v * Math.tan(0.1)) / (CAR.a + CAR.b) / 9.81; // lateral g the geometry alone would demand
    expect(fast.ay).toBeLessThan(kin(80) * 0.8);
    expect(slow.ay).toBeGreaterThan(kin(25) * 0.7);
  });
  it('load transfer: braking loads the front, accelerating loads the rear, cornering loads the outside', () => {
    const c = car({ v: 70, s: 300 }); const e = { ...ENV, forceSurface: 0 };
    c.ctrl.brake = 0.6; for (let i = 0; i < 60; i++) c.step(DT, track, e); expect(c.fz[0] + c.fz[1]).toBeGreaterThan(c.fz[2] + c.fz[3] - 2500);
    const d = car({ v: 60, s: 300 }); d.assists.steer = 0; d.steer = 0.08; d.ctrl.steer = 0.08 / 0.3; d.ctrl.throttle = 0.4;
    for (let i = 0; i < 120; i++) d.step(DT, track, e);
    expect(d.fz[1] + d.fz[3]).toBeGreaterThan(d.fz[0] + d.fz[2]);      // left turn -> right (outer) tyres loaded
  });
  it('off-track surfaces reduce braking grip (grass/gravel need much more room than tarmac)', () => {
    const stop = (surface) => {
      const c = car({ v: 60, s: 1500 }); c.ctrl.brake = 0; c.step(DT, track, { ...ENV, forceSurface: surface }); c.ctrl.brake = 0.5; let d = 0, t = 0;
      while (c.speed > 15 && t < 20) { c.step(DT, track, { ...ENV, forceSurface: surface }); d += c.speed * DT; t += DT; }
      return d;
    };
    const asph = stop(0), grass = stop(3), gravel = stop(4);
    expect(grass).toBeGreaterThan(asph * 1.3);
    expect(gravel).toBeLessThan(grass);                       // gravel traps stop cars (high rolling resistance)
  });
  it('gear logic: limiter, automatic shifting and refusal of over-revving downshifts', () => {
    const c = car({ tc: 1 }); c.ctrl.throttle = 1; let sawLimiter = false, up = 0, last = 1;
    for (let i = 0; i < 120 * 20; i++) { c.step(DT, track, ENV); if (c.pt.limiter) sawLimiter = true; if (c.pt.gear > last) up++; last = c.pt.gear; }
    expect(up).toBeGreaterThanOrEqual(6); expect(c.pt.rpm).toBeLessThanOrEqual(RPM_LIMIT + 300);
    const m = car({ v: 90, s: 300 }); m.pt.auto = false; m.assists.autoGear = false; m.pt.gear = 8; m.ctrl.down = true; m.ctrl.throttle = 0; m.step(DT, track, { ...ENV, forceSurface: 0 });
    for (let k = 0; k < 6; k++) { m.ctrl.down = true; m.step(DT, track, { ...ENV, forceSurface: 0 }); for (let i = 0; i < 25; i++) m.step(DT, track, { ...ENV, forceSurface: 0 }); }
    expect(m.pt.rpm).toBeLessThan(RPM_LIMIT + 1200);
  });
  it('burns fuel and gets lighter', () => {
    const c = car({ tc: 1, fuel: 30 }); c.ctrl.throttle = 1; const m0 = c.mass;
    for (let i = 0; i < 120 * 10; i++) c.step(DT, track, ENV);
    expect(c.pt.fuel).toBeLessThan(30 - 0.15); expect(c.mass).toBeLessThan(m0);
  });
  it('ERS deploys and recharges under braking', () => {
    const c = car({ tc: 1 }); c.pt.ers = 2e6; c.ctrl.throttle = 1;
    for (let i = 0; i < 120 * 3; i++) c.step(DT, track, ENV); const afterDeploy = c.pt.ers;
    expect(afterDeploy).toBeLessThan(2e6);
    c.ctrl.throttle = 0; c.ctrl.brake = 0.8; for (let i = 0; i < 120 * 3; i++) c.step(DT, track, ENV); expect(c.pt.ers).toBeGreaterThan(afterDeploy);
  });
  it('stays finite under abusive inputs', () => {
    const c = car({ v: 60, s: 800 }); let r = 12345;
    const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
    for (let i = 0; i < 120 * 60; i++) { if (i % 20 === 0) { c.ctrl.throttle = rnd(); c.ctrl.brake = rnd() < 0.3 ? rnd() : 0; c.ctrl.steer = rnd() * 2 - 1; c.ctrl.up = rnd() < 0.05; c.ctrl.down = rnd() < 0.05; } c.step(DT, track, ENV); }
    for (const v of [c.x, c.z, c.vx, c.vz, c.r, c.psi, c.h, ...c.fz, ...c.wOmega]) expect(Number.isFinite(v)).toBe(true);
  });
  it('is consistent between 120 Hz and 60 Hz physics steps', () => {
    const run = (m) => { const c = car({ tc: 1 }); c.ctrl.throttle = 1; for (let i = 0; i < 120 * 6 / m; i++) { if (i === 120 * 3 / m) { c.ctrl.throttle = 0; c.ctrl.brake = 1; } c.step(DT * m, track, ENV); } return c.distance; };
    const a = run(1), b = run(2); expect(Math.abs(a - b) / a).toBeLessThan(0.03);
  });
  it('allocates (almost) no memory in the step loop', () => {
    const c = car({ tc: 1, v: 50 }); c.ctrl.throttle = 0.6;
    for (let i = 0; i < 2000; i++) c.step(DT, track, ENV);
    if (global.gc) global.gc();
    const m0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 60000; i++) { c.ctrl.steer = Math.sin(i * 0.01) * 0.2; c.step(DT, track, ENV); }
    const grew = process.memoryUsage().heapUsed - m0;
    expect(grew).toBeLessThan(40 * 1024 * 1024); // 60k steps; any per-step allocation would be many hundreds of MB
  });
});
