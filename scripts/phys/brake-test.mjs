// Digital brake button (instant pedal 1.0 into the pressure ramp): stopping behaviour, lock-ups, ramps
import { getTrack } from '../../src/track/circuits/index.js';
import { Vehicle } from '../../src/physics/VehiclePhysics.js';
const track = getTrack('silverstone'); const DT = 1 / 120;
for (const abs of [0, 1]) for (const v0 of [80, 50, 25, 10]) for (const ramp of [0, 4.2]) {
  const c = new Vehicle(1); c.setFuel(40); c.fitTyres('medium', 90); Object.assign(c.assists, { abs, tc: 1, steer: 1, autoGear: true }); c.applySetup(); c.pt.auto = true; c.d = { isPlayer: true };
  c.place(track, 800, 0, v0); c.brakes.temp.fill(300);
  for (let i = 0; i < 40; i++) { c.ctrl.throttle = 0.4; c.step(DT, track, { water: 0, tAir: 25, tTrack: 35, wearMult: 1, forceSurface: 0 }); }
  c.vx = Math.sin(c.psi) * v0; c.vz = Math.cos(c.psi) * v0;
  let t = 0, b = 0, lockT = 0, peakDec = 0, vPrev = c.speed, dist0 = c.distance, lastV = v0, d10 = 0;
  while (c.speed > 0.5 && t < 12) {
    b = ramp ? Math.min(1, b + ramp * DT) : 1; c.ctrl.brake = b; c.ctrl.throttle = 0;
    c.step(DT, track, { water: 0, tAir: 25, tTrack: 35, wearMult: 1, forceSurface: 0 }); t += DT;
    if (Math.min(c.kappa[0], c.kappa[1]) < -0.4 || Math.min(c.kappa[2], c.kappa[3]) < -0.4) lockT += DT;
    const dec = (vPrev - c.speed) / DT; if (t > 0.3) peakDec = Math.max(peakDec, dec); vPrev = c.speed;
  }
  console.log(`abs${abs} v0=${String(v0).padEnd(2)} ramp=${ramp ? 'kb' : 'inst'} stop ${t.toFixed(2)}s dist ${(c.distance - dist0).toFixed(0)}m peakDecel ${(peakDec / 9.81).toFixed(1)}g lockedTime ${lockT.toFixed(2)}s`);
}
