// Solo AI laps with different starting tyre temperature: does the AI lose the car in chicanes when tyres are cold?
import { getTrack } from '../../src/track/circuits/index.js';
import { Vehicle } from '../../src/physics/VehiclePhysics.js';
import { buildSpeedProfile } from '../../src/ai/SpeedProfile.js';
import { DriverAI } from '../../src/ai/OpponentAI.js';
import { PHYS_DT } from '../../src/race/RaceManager.js';
import { clamp, table } from '../../src/core/math.js';
const STEPMUL = +(process.env.STEPMUL || 1);
const [tid = 'monza', comp = 'medium', skill = '0.95'] = process.argv.slice(2);
const track = getTrack(tid), prof = buildSpeedProfile(track);
const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 3 };
for (const T of [60, 70, 80, 95]) {
  const car = new Vehicle(1); car.assists.tc = 2; car.assists.steer = 0; car.setFuel(+(process.env.FUEL || 60)); car.fitTyres(comp, T);
  const slot = track.gridSlot(5); car.place(track, slot.s, slot.n, 0);
  const ai = new DriverAI(car, track, prof, { skill: +skill, seed: 5 });
  const ctx = { race: false, ahead: null, aheadGap: 999, behind: null, behindGap: 999, neighbors: [], nNeighbors: 0, grip: 1, paceLoss: (c) => { let g = 0; for (let i = 0; i < 4; i++) { const t = c.tires[i]; g += t.tempGrip() * t.wearGrip(); } return Math.sqrt(clamp(g * 0.25 / 0.985, 0.35, 1)); }, sc: false, vsc: false, errors: false, wetness: 0, yellowNear: null, noPass: true };
  let t = 0, maxSlip = 0, spins = 0, off = 0, laps = 0, last = car.loc.s, inSpin = false, lapStart = 0, lapTimes = [];
  let tick = 0;
  while (t < prof.lapTime * 3.2) { tick++; if (STEPMUL === 2 && (tick & 1)) { t += PHYS_DT; continue; }
    ai.update(PHYS_DT, ctx); car.step(PHYS_DT * STEPMUL, track, ENV); t += PHYS_DT;
    const slip = Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 1)));
    if (car.speed > 20) { maxSlip = Math.max(maxSlip, slip); if (slip > 0.35 && !inSpin) { inSpin = true; spins++; } if (slip < 0.15) inSpin = false; }
    const edge = car.loc.n >= 0 ? track.wl[car.loc.i] : track.wr[car.loc.i]; if (Math.abs(car.loc.n) - edge > 1.2) off += PHYS_DT;
    if (last > track.length * 0.9 && car.loc.s < track.length * 0.1) { laps++; lapTimes.push(+(t - lapStart).toFixed(1)); lapStart = t; } last = car.loc.s;
  }
  console.log(`${tid} ${comp} start ${T}C: laps=${laps} times=${lapTimes} maxSlip=${maxSlip.toFixed(2)} spins=${spins} offTrack=${off.toFixed(1)}s  tyreT=${car.tires.map((x) => x.tSurf | 0)}`);
}
