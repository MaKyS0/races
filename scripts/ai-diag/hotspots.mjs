// Histogram of serious impact locations (per 100 m of track) over several races -> shows systematic trouble spots.
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const tracks = (process.argv[2] || 'monza').split(','), seeds = (process.argv[3] || '1,2,3,4').split(',').map(Number), laps = +(process.argv[4] || 3), ai = +(process.argv[5] || 15);
for (const t of tracks) {
  const bins = new Map(); let tr;
  for (const seed of seeds) {
    const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps, aiCount: ai, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 }); tr = rm.track;
    rm.begin();
    while (rm.phase !== 'finished' && rm.simTime < laps * 150 + 150) {
      rm.step(PHYS_DT);
      for (const e of rm.events) if (e.type === 'impact' && e.energy > 25000) { const k = Math.floor(e.a.loc.s / 100); const b = bins.get(k) || { car: 0, wall: 0 }; if (e.wall) b.wall++; else b.car++; bins.set(k, b); }
      rm.events.length = 0;
    }
  }
  console.log(`== ${t} (length ${tr.length | 0} m) impacts per 100 m over ${seeds.length} races`);
  const corners = tr.cornerList.map((c) => `${c.s0 | 0}-${(c.s0 + c.len) | 0}`).join(' ');
  console.log('corners:', corners);
  for (const [k, b] of [...bins].sort((a, b) => b[1].car + b[1].wall - a[1].car - a[1].wall).slice(0, 10)) console.log(`  s=${k * 100}..${k * 100 + 100}: car ${b.car} wall ${b.wall}`);
}
