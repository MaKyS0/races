// Does the field size matter?  node scripts/n-cars.mjs track seed
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t = 'silverstone', seedS = '3'] = process.argv.slice(2);
for (const ai of [0, 1, 3, 7, 11, 15]) {
  let wall = 0, car = 0, dnf = 0, races = 0;
  for (const seed of [+seedS, +seedS + 1, +seedS + 2]) {
    const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: 3, aiCount: ai, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
    rm.begin();
    while (rm.phase !== 'finished' && rm.simTime < 3 * 150 + 150) { rm.step(PHYS_DT); for (const e of rm.events) if (e.type === 'impact' && e.energy > 25000) { if (e.wall) wall++; else car++; } rm.events.length = 0; }
    dnf += rm.drivers.filter((d) => d.status === 'dnf').length; races++;
  }
  console.log(`${t} AI=${ai} (field ${ai + 1}): wallHits=${wall} carHits=${car} dnf/race=${(dnf / races).toFixed(1)}`);
}
