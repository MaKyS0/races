import { describe, it, expect } from 'vitest';
import { getTrack } from '../src/track/circuits/index.js';
import { Vehicle } from '../src/physics/VehiclePhysics.js';
import { Input } from '../src/core/Input.js';
import { Settings } from '../src/core/Settings.js';
import { runScenario, SCENARIOS } from '../scripts/phys/corner-test.mjs';

const PHYS_DT = 1 / 120;
const track = getTrack('silverstone');
const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 1, forceSurface: 0 };

/** Drive a car with the digital buttons through the same loop structure as Game.js: sample() per frame, update() per fixed step. */
function drive(fps, script, { v0 = 25, seconds = 6, jitter = 0 } = {}) {
  globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
  const input = new Input(new Settings());
  const car = new Vehicle(1); car.setFuel(40); car.fitTyres('medium', 90); Object.assign(car.assists, { tc: 1, abs: 0, steer: 1, autoGear: true });
  car.applySetup(); car.pt.auto = true; car.d = { isPlayer: true }; car.place(track, 800, 0, v0);
  let wall = 0, acc = 0, sim = 0, seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const log = [], all = [];
  while (sim < seconds) {
    const dt = (1 / fps) * (1 + (rnd() - 0.5) * 2 * jitter);
    wall += dt;
    // buttons are sampled at the frame boundary
    for (const k of ['gas', 'brake', 'left', 'right']) {
      input.touch[k] = !!script(wall, k);
      if (!script(wall - dt, k)) for (let q = 0; q < 33; q++) if (script(wall - dt * q / 33, k)) { input.latch(k); break; }   // a new press (rising edge) that came and went inside this frame
    }
    input.sample();
    acc += dt; let steps = 0;
    while (acc >= PHYS_DT && steps < 8) {
      const st = input.update(PHYS_DT, car.speed);
      car.ctrl.throttle = st.throttle; car.ctrl.brake = st.brake; car.ctrl.steer = st.steer;
      car.step(PHYS_DT, track, ENV); acc -= PHYS_DT; sim += PHYS_DT; steps++; all.push({ t: sim, thr: car.ctrl.throttle });
      if (Math.abs(sim * 10 - Math.round(sim * 10)) < PHYS_DT * 5) log.push({ t: +sim.toFixed(1), v: car.speed, x: car.x, z: car.z, thr: car.ctrl.throttle });
    }
  }
  return { car, input, log, all, sim };
}
const script = (t, k) => (k === 'gas' ? t > 0.5 && t < 3.0 : k === 'left' ? t > 1.5 && t < 2.2 : k === 'brake' ? t > 3.4 && t < 4.4 : k === 'right' ? t > 3.6 && t < 4.0 : false);

describe('digital controls', () => {
  it('GAS: held -> accelerates; released -> throttle off and the car coasts (no instant stop, no further drive)', () => {
    const r = drive(60, (t, k) => k === 'gas' && t > 0.5 && t < 2.5, { seconds: 5 });
    const at = (t) => r.log.find((l) => l.t === t);
    expect(at(2.0).v).toBeGreaterThan(at(1.0).v + 4);         // accelerating while held
    expect(at(2.9).thr).toBe(0);                              // off shortly after release
    expect(at(4.9).v).toBeGreaterThan(at(2.9).v * 0.75);      // coasts: loses speed gradually (drag / rolling), not abruptly
    expect(at(4.9).v).toBeLessThan(at(2.9).v);
  });
  it('BRAKE: held -> decelerates hard but not instantaneously; released -> brake force off', () => {
    const r = drive(60, (t, k) => k === 'brake' && t > 0.5 && t < 2.0, { v0: 60, seconds: 4 });
    const at = (t) => r.log.find((l) => l.t === t);
    expect(at(0.4).v).toBeGreaterThan(55);
    expect(at(0.9).v).toBeGreaterThan(at(2.0).v);             // still braking later
    expect(at(1.0).v).toBeGreaterThan(30);                    // 0.5 s of braking does not stop a 60 m/s car
    const slowing = at(1.9).v < at(0.6).v - 25;               // but it is strong (> 5 m/s^2 average)
    expect(slowing).toBe(true);
    const after = at(3.5).v, soon = at(2.4).v;
    expect(after).toBeGreaterThan(soon * 0.65);                // after release it is only drag, not braking
  });
  it('steering + GAS and steering + BRAKE act at the same time', () => {
    const r = drive(60, script, { seconds: 5 });
    expect(r.input.state.steer).toBe(0);
    const a = drive(60, (t, k) => (k === 'gas' || k === 'left') && t > 0.5, { seconds: 2.5 });
    expect(a.input.state.throttle).toBeGreaterThan(0.99); expect(a.input.state.steer).toBeGreaterThan(0.2);
    const b = drive(60, (t, k) => (k === 'brake' || k === 'right') && t > 0.5, { seconds: 2.5, v0: 50 });
    expect(b.input.state.brake).toBeGreaterThan(0.99); expect(b.input.state.steer).toBeLessThan(-0.2);
  });
  it('releaseAll() clears every held input (focus loss / pause)', () => {
    const r = drive(60, (t, k) => k === 'gas' || k === 'left', { seconds: 1 });
    r.input.releaseAll();
    r.input.update(PHYS_DT, 20);
    expect(r.input.state.throttle).toBe(0); expect(r.input.state.steer).toBe(0); expect(r.input.touch.gas).toBe(false);
  });
});

describe('frame-rate independence of the control feel', () => {
  it('30, 45, 60, 90 and 120 FPS (also with +-40 % frame jitter) give the same trajectory', () => {
    const ref = drive(120, script, { seconds: 6 });
    for (const fps of [30, 45, 60, 90]) for (const jitter of [0, 0.4]) {
      const r = drive(fps, script, { seconds: 6, jitter });
      const dv = Math.abs(r.car.speed - ref.car.speed) / ref.car.speed;
      const dp = Math.hypot(r.car.x - ref.car.x, r.car.z - ref.car.z);
      expect(dv, `speed ${fps} fps jitter ${jitter}`).toBeLessThan(0.03);
      expect(dp, `position ${fps} fps jitter ${jitter}`).toBeLessThan(6);       // metres after 6 s at up to 70 m/s (press time is frame-quantised)
    }
  });
  it('a press shorter than a frame at 30 FPS still produces a (short) response and then releases', () => {
    const r = drive(30, (t, k) => k === 'gas' && t > 0.5 && t < 0.52, { seconds: 2 });
    expect(Math.max(...r.all.filter((l) => l.t >= 0.5 && l.t <= 0.8).map((l) => l.thr))).toBeGreaterThan(0.02);   // felt for (at least) one frame
    expect(r.log.find((l) => l.t === 1.5).thr).toBe(0);
  });
});

describe('traction / grip on corner exit (the "excess spin" fix)', () => {
  const byName = (n) => SCENARIOS.find((s) => s.name.startsWith(n));
  it('smooth gas out of a slow corner: car holds the line, small wheelspin only', () => {
    for (const tc of [1, 2]) { const r = runScenario(byName('1 '), { tc }); expect(r.maxBetaDeg).toBeLessThan(8); expect(r.maxRearSlipDeg).toBeLessThan(8); expect(r.maxKappa).toBeLessThan(0.2); expect(r.spinS).toBe(0); }
  });
  it('abrupt full gas out of a slow corner / hairpin: only a small slide, never a spin (default assists)', () => {
    for (const n of ['2 ', '6 ']) { const r = runScenario(byName(n), { tc: 1 }); expect(r.maxBetaDeg).toBeLessThan(12); expect(r.spinS).toBe(0); expect(r.yawOvershoot).toBeLessThan(1.8); }
  });
  it('even with traction control off the car no longer spins out of a corner (only slight wheelspin)', () => {
    for (const n of ['1 ', '2 ', '6 ']) { const r = runScenario(byName(n), { tc: 0 }); expect(r.maxBetaDeg).toBeLessThan(15); expect(r.spinS).toBe(0); expect(r.maxKappa).toBeGreaterThan(0.1); }
  });
  it('fast corners and the braking-in-corner case stay controllable', () => {
    for (const n of ['3 ', '4 ', '10']) { const r = runScenario(byName(n), { tc: 1 }); expect(r.maxBetaDeg).toBeLessThan(8); expect(r.spinS).toBe(0); }
    const b = runScenario(byName('5 '), { tc: 1 }); expect(b.spinS).toBe(0); expect(b.maxBetaDeg).toBeLessThan(20);
  });
  it('grip can still be lost: too much speed for the corner gives sustained understeer (steering saturated)', () => {
    const r = runScenario(byName('7 '), { tc: 1 }); expect(r.steerSatS).toBeGreaterThan(2); expect(r.yawErr).toBeGreaterThan(0.3);
  });
  it('wet track: slow-corner exit on slicks is slower but stable', () => {
    const w = runScenario(byName('9 '), { tc: 1 }); expect(w.spinS).toBe(0); expect(w.maxBetaDeg).toBeLessThan(10);
  });
  it('yaw rate follows the steering without violent swings (no sudden lateral-speed jumps)', () => {
    for (const n of ['1 ', '2 ', '6 ']) {
      const r = runScenario(byName(n), { tc: 1 });
      let worst = 0; for (let i = 1; i < r.log.length; i++) worst = Math.max(worst, Math.abs(r.log[i].beta - r.log[i - 1].beta));
      expect(worst).toBeLessThan(0.06);    // body slip changes by < 3.4 deg per 0.1 s
    }
  });
});
