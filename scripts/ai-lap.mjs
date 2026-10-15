import { getTrack, CIRCUITS } from '../src/track/circuits/index.js';
import { Vehicle } from '../src/physics/VehiclePhysics.js';
import { buildSpeedProfile } from '../src/ai/SpeedProfile.js';
import { DriverAI } from '../src/ai/OpponentAI.js';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : CIRCUITS.map((c) => c.id);
const env = { water: 0, tAir: 25, tTrack: 35, wearMult: 1 };
const dt = 1 / 120;
for (const id of ids) {
  const track = getTrack(id);
  const prof = buildSpeedProfile(track, { muLat: +(process.env.MU || 1.75), muBrake: +(process.env.MUB || 1.75) });
  const car = new Vehicle(1);
  car.assists.tc = 2; car.assists.steer = 0; car.assists.abs = 0;
  car.setFuel(40); car.fitTyres('soft', 95);
  car.place(track, track.gridSlot(0).s, track.gridSlot(0).n, 0);
  const ai = new DriverAI(car, track, prof, { skill: +(process.env.SKILL || 0.97) });
  const ctx = { race: false, ahead: null, aheadGap: 999, behind: null, behindGap: 999, neighbors: [], nNeighbors: 0, grip: 1, paceLoss: () => 1, sc: false, vsc: false, errors: false, wetness: 0, yellowNear: null, noPass: true };
  let t = 0, lastS = car.loc.s, lapStart = 0, laps = [], off = 0, maxOff = 0, offTime = 0, crashes = 0, vmax = 0, minV = 1e9;
  const timeLimit = 3 * (prof.lapTime * 1.5 + 30);
  while (t < timeLimit && laps.length < 3) {
    ai.update(dt, ctx);
    car.step(dt, track, env);
    t += dt;
    const s = car.loc.s;
    if (lastS > track.length * 0.9 && s < track.length * 0.1) { laps.push(t - lapStart); lapStart = t; }
    lastS = s;
    const edge = car.loc.n >= 0 ? track.wl[car.loc.i] : track.wr[car.loc.i];
    const o = Math.abs(car.loc.n) - edge;
    if (o > 1.2) offTime += dt;
    maxOff = Math.max(maxOff, o);
    vmax = Math.max(vmax, car.speed);
    if (car.retired) break;
  }
  console.log(`${id.padEnd(12)} profile=${prof.lapTime.toFixed(1)}s laps=${laps.map((l) => l.toFixed(1)).join(', ')} offTrack=${offTime.toFixed(1)}s maxOff=${maxOff.toFixed(1)}m vmax=${(vmax * 3.6).toFixed(0)} fuelLeft=${car.fuel.toFixed(1)} tyreWear=${car.tires.map((x) => x.wear.toFixed(2)).join('/')} tTyre=${car.tires.map((x) => x.tSurf.toFixed(0)).join('/')} ${car.retired ? 'RETIRED ' + car.retireReason : ''}`);
}
