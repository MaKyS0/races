// Headless physics sanity runs (prints numbers; unit tests assert on them).
import { getTrack } from '../src/track/circuits/index.js';
import { Vehicle } from '../src/physics/VehiclePhysics.js';
const t0 = performance.now();
const track = getTrack('monza');
console.log('track build ms', (performance.now() - t0).toFixed(0), 'len', track.length.toFixed(0));
const env = { water: 0, tAir: 25, tTrack: 35, wearMult: 1 };
function mk(opts = {}) {
  const c = new Vehicle(0);
  c.assists.tc = opts.tc ?? 0; c.assists.abs = opts.abs ?? 0; c.assists.steer = 0;
  Object.assign(c.setup, opts.setup || {}); c.applySetup();
  c.setFuel(opts.fuel ?? 50); c.fitTyres(opts.compound || 'soft', opts.temp || 95);
  c.place(track, opts.s ?? 5800 - 200, 0, opts.v ?? 0);
  return c;
}
const dt = 1 / 120;
// 1. standing start
{
  const c = mk({ tc: 1 });
  let t = 0, t100 = 0, t200 = 0, t300 = 0;
  c.ctrl.throttle = 1;
  const log = [];
  for (let i = 0; i < 120 * 30; i++) {
    c.step(dt, track, env); t += dt;
    if (!t100 && c.speed * 3.6 >= 100) t100 = t;
    if (!t200 && c.speed * 3.6 >= 200) t200 = t;
    if (!t300 && c.speed * 3.6 >= 300) t300 = t;
    if (i % 60 === 0 && t < 12) log.push(`${t.toFixed(1)}s v=${(c.speed * 3.6).toFixed(0)} g${c.pt.gear} rpm${c.pt.rpm.toFixed(0)} kRL=${c.kappa[2].toFixed(2)} tc=${c.tcCut.toFixed(2)}`);
  }
  console.log('launch: 0-100', t100.toFixed(2), '0-200', t200.toFixed(2), '0-300', t300.toFixed(2), 'vmax', (c.speed * 3.6).toFixed(0), 'fuel', c.fuel.toFixed(2));
  console.log(log.join('\n'));
}
// 2. braking
for (const [label, o, w] of [['dry soft', {}, 0], ['wet slick', {}, 0.6], ['dry worn', { worn: 0.9 }, 0]]) {
  const c = mk({ v: 300 / 3.6, s: 300 });
  if (o.worn) for (const t of c.tires) t.wear = o.worn;
  c.pt.gear = 8;
  c.pt.auto = true;
  const e = { ...env, water: w };
  c.ctrl.throttle = 0; c.ctrl.brake = 0; c.step(dt, track, e); c.ctrl.brake = 1;
  let dist = 0, t = 0, peak = 0, lock = 0;
  while (c.speed * 3.6 > 80 && t < 15) {
    c.step(dt, track, e); dist += c.speed * dt; t += dt; peak = Math.max(peak, -c.axBody / 9.81);
    if (c.kappa[0] < -0.4) lock += dt;
  }
  console.log(`brake 300->80 ${label}: ${dist.toFixed(0)} m ${t.toFixed(2)} s peak ${peak.toFixed(2)} g frontLock ${lock.toFixed(2)}s discT=${c.brakes.temp[0].toFixed(0)}`);
}
// 3. skidpad
for (const kmh of [60, 100, 150, 200, 250]) {
  const c = mk({ v: kmh / 3.6, s: 300 });
  c.ctrl.throttle = 0.3; 
  // brute force: hold constant steer, increase until limit - measure max lat g over a ramp of steering
  let best = 0;
  for (let st = 0.004; st < 0.36; st += 0.004) {
    const cc = mk({ v: kmh / 3.6, s: 300 }); const envF = { ...env, forceSurface: 0 };
    cc.assists.steer = 0;
    cc.ctrl.steer = st / 0.36; cc.steer = st; 
    let sumG = 0, n = 0;
    for (let i = 0; i < 360; i++) {
      // simple speed hold
      cc.ctrl.throttle = cc.speed < kmh / 3.6 ? 0.7 : 0.1;
      cc.step(dt, track, envF);
      if (i > 240) { sumG += Math.abs(cc.ayBody) / 9.81; n++; }
    }
    best = Math.max(best, sumG / n);
  }
  console.log(`max lateral g @ ${kmh} km/h ~ ${best.toFixed(2)}`);
}
// 4. top speed with wing settings
for (const w of [[0, 0], [5, 5], [10, 10]]) {
  const c = mk({ setup: { frontWing: w[0], rearWing: w[1] }, tc: 1, s: 5800 - 800 });
  c.ctrl.throttle = 1;
  c.place(track, 5000, 0, 60);
  let vmax = 0, dn = 0;
  for (let i = 0; i < 120 * 40; i++) { c.step(dt, track, env); vmax = Math.max(vmax, c.speed); if (i % 4 === 0) { c.ctrl.steer = Math.max(-1, Math.min(1, -c.loc.n * 0.2 - Math.sin(c.psi - c.loc.psi) * 2)); } if (c.loc.s < 1000 && c.distance > 500) break; }
  console.log(`wings ${w}: vmax ${(vmax * 3.6).toFixed(0)} km/h, downforce@300 ~ ${(0.5 * 1.2 * 83.3 ** 2 * c.aero.cla / 1000).toFixed(1)} kN (ClA=${c.aero.cla.toFixed(2)}, CdA=${c.aero.cda.toFixed(2)})`);
}
