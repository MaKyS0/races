import { getTrack } from '../src/track/circuits/index.js';
import { Vehicle } from '../src/physics/VehiclePhysics.js';
const track = getTrack('monza');
const env = { water: 0, tAir: 25, tTrack: 35, wearMult: 1, forceSurface: 0 };
const dt = 1 / 120;
for (const kmh of [80, 160, 250]) {
  for (const steer of [0.03, 0.06, 0.09, 0.12, 0.16]) {
    const c = new Vehicle(0); c.assists.tc = 0; c.assists.steer = 0; c.setFuel(50); c.fitTyres('soft', 95);
    c.place(track, 300, 0, kmh / 3.6);
    c.steer = steer; c.ctrl.steer = steer / 0.36;
    let n = 0, sf = 0, sr = 0, ay = 0;
    for (let i = 0; i < 480; i++) {
      c.ctrl.throttle = c.speed < kmh / 3.6 ? 0.8 : 0.05; c.ctrl.steer = steer / 0.36 * 0.36 / c.steerLock() * 1; 
      c.step(dt, track, env);
      if (i > 300) { n++; sf += (Math.abs(c.slipA[0]) + Math.abs(c.slipA[1])) / 2; sr += (Math.abs(c.slipA[2]) + Math.abs(c.slipA[3])) / 2; ay += Math.abs(c.ayBody) / 9.81; }
    }
    console.log(`${kmh} km/h steer ${steer.toFixed(2)}: ay=${(ay / n).toFixed(2)}g  slip front ${(sf / n).toFixed(3)} rear ${(sr / n).toFixed(3)} -> ${sf > sr ? 'understeer' : 'oversteer'}  v=${(c.speed * 3.6).toFixed(0)}`);
  }
}
