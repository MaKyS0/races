// What happens in the first 40 s of a race?  node scripts/start-check.mjs track seed ai
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t = 'monaco', seed = '1', ai = '19'] = process.argv.slice(2);
const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: 3, aiCount: +ai, difficulty: 'pro', autopilotPlayer: true, seed: +seed, wearMult: 3 });
rm.begin(); let nImp = 0, big = 0; const first = [];
while (rm.simTime < 40) {
  rm.step(PHYS_DT);
  for (const e of rm.events) if (e.type === 'impact') { nImp++; if (e.energy > 25000) { big++; if (first.length < 6) first.push(`t=${rm.simTime.toFixed(1)} ${e.wall ? 'wall' : 'car'} ${e.a.d.short}${e.b ? '/' + e.b.d.short : ''} s=${e.a.loc.s | 0} v=${e.a.speed | 0} vn=${e.speed.toFixed(1)} phase=${rm.phase} E=${(e.energy / 1000) | 0}k`); } }
  rm.events.length = 0;
}
console.log(t, 'seed', seed, 'impacts in first 40 s:', nImp, 'big', big, 'phase', rm.phase); first.forEach((x) => console.log(' ', x));
console.log(' positions s at t=40:', rm.drivers.map((d) => d.car.loc.s | 0).sort((a, b) => a - b).join(' '));
