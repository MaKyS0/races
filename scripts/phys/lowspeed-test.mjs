// Low-speed behaviour: open-loop steering / throttle / brake abuse from 0..25 m/s. The car must not rotate wildly:
// body slip beta, peak yaw rate and the yaw-rate excess over the kinematic (Ackermann) value are reported.
//   node scripts/phys/lowspeed-test.mjs [tc=1] [steerAssist=1]
import { getTrack } from '../../src/track/circuits/index.js';
import { Vehicle, CAR } from '../../src/physics/VehiclePhysics.js';
const TC = +(process.argv[2] ?? 1), SA = +(process.argv[3] ?? 1), DT = 1 / 120, track = getTrack('silverstone');
const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 1, forceSurface: 0 };
const WB = CAR.a + CAR.b;
export function run({ v0, steer, thr, brk, T = 5, tc = TC, sa = SA, tyreT = 90, fuel = 40, water = 0 }) {
  const c = new Vehicle(1); c.setFuel(fuel); c.fitTyres('medium', tyreT); Object.assign(c.assists, { abs: 0, tc, steer: sa, autoGear: true });
  c.applySetup(); c.pt.auto = true; c.d = { isPlayer: true }; c.brakes.temp.fill(300); c.place(track, 800, 0, v0);
  const env = { ...ENV, water };
  for (let i = 0; i < 60; i++) { c.ctrl.throttle = v0 > 1 ? 0.25 : 0; c.step(DT, track, env); }
  c.vx = Math.sin(c.psi) * v0; c.vz = Math.cos(c.psi) * v0;
  const psi0 = c.psi; let t = 0, maxBeta = 0, maxR = 0, maxExcess = 0, spinT = 0, maxKRear = 0;
  while (t < T) {
    const on = t >= 0.5;
    c.ctrl.steer = on ? steer : 0; c.ctrl.throttle = thr(t); c.ctrl.brake = brk ? brk(t) : 0;
    c.step(DT, track, env); t += DT;
    const sp = c.speed, beta = Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1.5)));
    if (sp > 1.5) { maxBeta = Math.max(maxBeta, beta); if (beta > 0.52) spinT += DT; }
    // kinematic yaw rate for the actual front steer angle (what a car without slip would do)
    const delta = c.steerAngle ?? (c.ctrl.steer * c.steerLock()); const rKin = Math.abs(sp * Math.tan(delta) / WB);
    maxR = Math.max(maxR, Math.abs(c.r)); if (sp > 1.5) maxExcess = Math.max(maxExcess, Math.abs(c.r) - rKin * 1.6 - 0.15);
    maxKRear = Math.max(maxKRear, c.kappa[2], c.kappa[3]);
  }
  const turned = Math.abs(((c.psi - psi0 + Math.PI) % (2 * Math.PI)) - Math.PI) * 57.3;
  return { betaDeg: maxBeta * 57.3, spinT, maxR, maxExcess, kRear: maxKRear, vEnd: c.speed };
}
if (process.argv[1].endsWith('lowspeed-test.mjs')) {
  let bad = 0, n = 0;
  const thrs = { 'gas0': () => 0, 'gas50': () => 0.5, 'gas100': () => 1, 'gasSlam@1s': (t) => (t < 1 ? 0 : 1) };
  const brks = { none: null, brake: (t) => (t > 0.5 ? 1 : 0) };
  for (const v0 of [0, 2, 4, 7, 10, 15, 20, 25]) for (const steer of [0.25, 0.6, 1.0]) for (const [tn, thr] of Object.entries(thrs)) for (const [bn, brk] of Object.entries(brks)) {
    if (bn === 'brake' && tn !== 'gas0') continue;
    const r = run({ v0, steer, thr, brk }); n++;
    const flag = r.betaDeg > 25 || r.spinT > 0.2 || r.maxExcess > 0.25;
    if (flag) { bad++; console.log(`BAD v0=${String(v0).padStart(2)} steer=${steer} ${tn.padEnd(10)} ${bn.padEnd(5)} β=${r.betaDeg.toFixed(0)}° spin=${r.spinT.toFixed(2)}s yawMax=${r.maxR.toFixed(2)} excess=${r.maxExcess.toFixed(2)} κrear=${r.kRear.toFixed(2)} vEnd=${r.vEnd.toFixed(1)}`); }
  }
  console.log(`${bad}/${n} scenarios flagged (tc=${TC}, steerAssist=${SA})`);
}
