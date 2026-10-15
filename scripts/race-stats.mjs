import { RaceManager, MODE, PHYS_DT } from '../src/race/RaceManager.js';
const tracks = (process.argv[2] || 'monza,silverstone').split(',');
const seeds = (process.argv[3] || '1,2,3').split(',').map(Number);
const laps = +(process.argv[4] || 3);
for (const t of tracks) for (const seed of seeds) {
  const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps, aiCount: +(process.env.AI || 19), difficulty: process.env.DIFF || 'pro', weather: process.env.WX || 'dry', autopilotPlayer: true, seed, wearMult: 3 });
  rm.begin();
  let imp = 0, big = 0, sc = 0, pits = 0;
  while (rm.phase !== 'finished' && rm.simTime < laps * 150 + 150) {
    rm.step(PHYS_DT);
    for (const e of rm.events) { if (e.type === 'impact') { imp++; if (e.energy > 30000) big++; } if (e.type === 'sc' && e.on) sc++; if (e.type === 'pitService') pits++; }
    rm.events.length = 0;
  }
  const fin = rm.drivers.filter((d) => d.status === 'finished').length;
  const ret = rm.drivers.filter((d) => d.status === 'dnf').length;
  const lead = rm.order[0];
  console.log(`${t} seed ${seed}: phase=${rm.phase} t=${rm.simTime.toFixed(0)}s finished=${fin} dnf=${ret} impacts=${imp} big=${big} sc=${sc} pitStops=${pits} winnerBest=${isFinite(lead.best) ? lead.best.toFixed(1) : '-'}`);
}
