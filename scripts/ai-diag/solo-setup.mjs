import { getTrack } from '../../src/track/circuits/index.js';
import { Vehicle, DEFAULT_SETUP } from '../../src/physics/VehiclePhysics.js';
import { buildSpeedProfile } from '../../src/ai/SpeedProfile.js';
import { DriverAI } from '../../src/ai/OpponentAI.js';
import { PHYS_DT } from '../../src/race/RaceManager.js';
import { clamp } from '../../src/core/math.js';
const [tid = 'silverstone', skill = '0.98'] = process.argv.slice(2);
const track = getTrack(tid), prof = buildSpeedProfile(track);
const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 3 };
for (const [fw, rw] of [[5, 5], [4, 4], [4, 6], [6, 4], [6, 6], [4, 5]]) for (const comp of ['soft', 'hard']) {
  const car = new Vehicle(1); car.assists.tc = 2; car.assists.steer = 0; car.setFuel(40); car.fitTyres(comp, 75);
  car.setup = { ...DEFAULT_SETUP, frontWing: fw, rearWing: rw, brakeBias: 0.57 }; car.applySetup();
  const slot = track.gridSlot(5); car.place(track, slot.s, slot.n, 0);
  const ai = new DriverAI(car, track, prof, { skill: +skill, seed: 5 });
  const ctx = { race: false, ahead: null, aheadGap: 999, behind: null, behindGap: 999, neighbors: [], nNeighbors: 0, near: [], nNear: 0, grip: 1, paceLoss: (c) => { let g = 0; for (let i = 0; i < 4; i++) { const t = c.tires[i]; g += t.tempGrip() * t.wearGrip(); } return Math.sqrt(clamp(g * 0.25 / 0.985, 0.35, 1)); }, sc: false, vsc: false, errors: false, wetness: 0, yellowNear: null, noPass: true };
  let t = 0, maxSlip = 0, off = 0, laps = 0, last = car.loc.s;
  while (t < prof.lapTime * 3.2) {
    ai.update(PHYS_DT, ctx); car.step(PHYS_DT, track, ENV); t += PHYS_DT;
    if (car.speed > 20) maxSlip = Math.max(maxSlip, Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 1))));
    const edge = car.loc.n >= 0 ? track.wl[car.loc.i] : track.wr[car.loc.i]; if (Math.abs(car.loc.n) - edge > 1.2) off += PHYS_DT;
    if (last > track.length * 0.9 && car.loc.s < track.length * 0.1) laps++; last = car.loc.s;
  }
  console.log(`${tid} fw${fw} rw${rw} ${comp}: laps=${laps} maxSlip=${maxSlip.toFixed(2)} offTrack=${off.toFixed(1)}s`);
}
