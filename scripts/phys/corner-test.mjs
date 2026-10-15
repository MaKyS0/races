// Cornering / traction scenarios on open asphalt with a yaw-rate-holding "driver" (keeps the car on a circle of radius R).
// Reports peak body slip, peak rear slip angle, yaw-rate overshoot, wheelspin and whether the driver lost the car.
//   node scripts/phys/corner-test.mjs [tc=1] [dtMul=1]
import { getTrack } from '../../src/track/circuits/index.js';
import { Vehicle } from '../../src/physics/VehiclePhysics.js';
import { clamp } from '../../src/core/math.js';

const TC = +(process.argv[2] ?? 1), FPS_STEP = 1 / 120;
const track = getTrack('silverstone');
const ENV0 = { water: 0, tAir: 25, tTrack: 35, wearMult: 1, forceSurface: 0 };

export function runScenario(sc, opts = {}) {
  const car = new Vehicle(1); car.setFuel(40); car.fitTyres('medium', opts.tyreT ?? 90);
  Object.assign(car.assists, { abs: 0, tc: opts.tc ?? TC, steer: opts.steerAssist ?? 1, autoGear: true });
  car.applySetup(); car.pt.auto = true; car.d = { isPlayer: true }; car.brakes.temp.fill(450);
  car.place(track, 800, 0, sc.v0);
  // let the gearbox settle on the right gear
  for (let i = 0; i < 60; i++) { car.ctrl.throttle = 0.3; car.step(FPS_STEP, track, ENV0); }
  car.vx = Math.sin(car.psi) * sc.v0; car.vz = Math.cos(car.psi) * sc.v0;
  const rT = sc.v0 / sc.R;
  let t = 0, maxBeta = 0, maxRearSlip = 0, maxKappa = 0, rOver = 0, satT = 0, minV = 1e9, tSpin = 0, rSteadyErr = 0, n = 0;
  const log = [];
  const T = sc.T;
  while (t < T) {
    const speed = Math.max(car.speed, 3);
    // driver: yaw-rate target follows the circle (r* = v / R), steer = feed-forward + feedback on yaw rate
    const rStar = sc.fixedR ? speed / sc.R : rT;
    const ff = Math.atan(3.6 * rStar / speed) * (1 + (speed / 60) ** 2 * 0.6);
    const fb = 0.10 * (rStar - car.r);
    const lock = car.steerLock();
    car.ctrl.steer = sc.steerFn ? sc.steerFn(t, car) : clamp((ff + fb) / lock, -1, 1);
    car.ctrl.throttle = sc.thr(t); car.ctrl.brake = sc.brk ? sc.brk(t) : 0;
    car.step(FPS_STEP, track, sc.water ? { ...ENV0, water: sc.water } : ENV0); t += FPS_STEP; n++;
    const beta = Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 2)));
    maxBeta = Math.max(maxBeta, beta);
    const rs = Math.max(Math.abs(car.slipA[2]), Math.abs(car.slipA[3])); maxRearSlip = Math.max(maxRearSlip, rs);
    maxKappa = Math.max(maxKappa, car.kappa[2], car.kappa[3]);
    if (t > 0.5) { rOver = Math.max(rOver, Math.abs(car.r) / Math.max(rStar, 0.05)); rSteadyErr += Math.abs(car.r - rStar); }
    if (Math.abs(car.ctrl.steer) > 0.97) satT += FPS_STEP;
    if (beta > 0.5) tSpin += FPS_STEP;
    minV = Math.min(minV, car.speed);
    if (n % 12 === 0) log.push({ t: +t.toFixed(2), v: +car.speed.toFixed(1), r: +car.r.toFixed(2), rStar: +rStar.toFixed(2), beta: +beta.toFixed(2), kapR: +Math.max(car.kappa[2], car.kappa[3]).toFixed(2), slipR: +rs.toFixed(2), thr: +car.ctrl.throttle.toFixed(2), gear: car.pt.gear, tc: +car.tcCut.toFixed(2) });
  }
  return { name: sc.name, vEnd: car.speed, maxBetaDeg: maxBeta * 57.3, maxRearSlipDeg: maxRearSlip * 57.3, maxKappa, yawOvershoot: rOver, steerSatS: satT, spinS: tSpin, minV, yawErr: rSteadyErr / n, log };
}
const ramp = (a, b, T0 = 0.5) => (t) => clamp((t - T0) / (b - a || 1e-6), 0, 1);
export const SCENARIOS = [
  { name: '1 slow corner, smooth gas (ramp 1.5 s)', R: 35, v0: 18, T: 7, thr: (t) => clamp((t - 0.5) / 1.5, 0, 1) },
  { name: '2 slow corner, abrupt gas (0.1 s)', R: 35, v0: 18, T: 7, thr: (t) => (t < 0.5 ? 0 : clamp((t - 0.5) / 0.1, 0, 1)) },
  { name: '3 medium corner R90, gas ramp 1 s', R: 90, v0: 35, T: 7, thr: (t) => clamp((t - 0.5) / 1.0, 0, 1) },
  { name: '4 fast corner R250, 70 % gas hold', R: 250, v0: 62, T: 6, thr: (t) => 0.7 },
  { name: '5 brake in corner R150 (60 m/s, 1.0 brake)', R: 150, v0: 60, T: 4, thr: () => 0, brk: (t) => (t < 0.5 ? 0 : 1) },
  { name: '6 hairpin R20, abrupt gas', R: 20, v0: 12, T: 6, thr: (t) => (t < 0.5 ? 0 : clamp((t - 0.5) / 0.1, 0, 1)) },
  { name: '7 too fast for the corner (R60 at 75 m/s)', R: 60, v0: 75, T: 4, thr: () => 0.5 },
  { name: '8 violent steering flick at 60 m/s (open loop)', R: 1e9, v0: 60, T: 4, thr: () => 0.6, steerFn: (t) => (t < 0.5 ? 0 : t < 1.0 ? 1 : t < 1.4 ? -1 : 0) },
  { name: '9 wet (0.25 water, slicks) slow-corner smooth gas', R: 35, v0: 14, T: 7, water: 0.25, thr: (t) => clamp((t - 0.5) / 1.5, 0, 1) },
  { name: '10 lift-off mid-corner at the limit (R120, 62 m/s)', R: 120, v0: 62, T: 4, thr: (t) => (t < 1 ? 1 : 0) },
  { name: '11 near-limit corner (R45 at 28 m/s) + abrupt full gas', R: 45, v0: 28, T: 5, fixedR: true, thr: (t) => (t < 0.8 ? 0.2 : 1) },
  { name: '12 same, gas ramp 2 s', R: 45, v0: 28, T: 5, fixedR: true, thr: (t) => clamp(0.2 + (t - 0.8) * 0.4, 0.2, 1) },
];
if (process.argv[1].endsWith('corner-test.mjs')) {
  for (const sc of SCENARIOS) {
    const r = runScenario(sc);
    console.log(`${r.name.padEnd(46)} vEnd=${r.vEnd.toFixed(1)} β=${r.maxBetaDeg.toFixed(1)}° rearSlip=${r.maxRearSlipDeg.toFixed(1)}° κ=${r.maxKappa.toFixed(2)} yawOvershoot=${r.yawOvershoot.toFixed(2)} steerSat=${r.steerSatS.toFixed(2)}s spin=${r.spinS.toFixed(2)}s yawErr=${r.yawErr.toFixed(3)}`);
    if (process.env.LOG && process.env.LOG === sc.name[0]) for (const l of r.log) console.log('  ', JSON.stringify(l));
  }
}
