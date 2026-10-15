// For each race print the FIRST serious car-car or wall incident with a compact history of the cars involved.
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const tracks = (process.argv[2] || 'monza,silverstone').split(','), seeds = (process.argv[3] || '1,2,3').split(',').map(Number), laps = +(process.argv[4] || 3), ai = +(process.argv[5] || 15);
for (const t of tracks) for (const seed of seeds) {
  const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps, aiCount: ai, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
  rm.begin(); const hist = new Map(); let k = 0, done = false;
  while (!done && rm.phase !== 'finished' && rm.simTime < laps * 150 + 150) {
    rm.step(PHYS_DT); k++;
    if (k % 36 === 0) for (const c of rm.cars) { let h = hist.get(c); if (!h) hist.set(c, h = []); const a = c.d.ai; h.push(`t${rm.simTime.toFixed(1)} s${c.loc.s | 0} n${c.loc.n.toFixed(1)} v${c.speed | 0}/${a ? a.targetSpeed | 0 : 0} ${c.ctrl.brake > 0.1 ? 'B' + c.ctrl.brake.toFixed(1) : 'T' + c.ctrl.throttle.toFixed(1)} st${c.ctrl.steer.toFixed(2)} ps${a?.passSide} fg${a ? Math.min(a.followGap, 999) | 0 : 0} dm${(c.damage.fwL + c.damage.fwR + c.damage.rw).toFixed(1)}`); if (h.length > 12) h.shift(); }
    for (const e of rm.events) if (!done && e.type === 'impact' && e.energy > 25000 && rm.simTime > 3) {
      done = true; console.log(`\n##### ${t}#${seed} first incident t=${rm.simTime.toFixed(1)} lap ${e.a.d.lapsCompleted + 1} ${e.wall ? 'WALL' : 'CAR-CAR'} ${e.a.d.short}${e.b ? ' x ' + e.b.d.short : ''} vn=${e.speed.toFixed(1)} E=${(e.energy / 1000) | 0}k`);
      for (const c of [e.a, e.b]) if (c) { console.log(' ' + c.d.short); for (const r of hist.get(c).slice(-9)) console.log('   ' + r); }
    }
    rm.events.length = 0;
  }
}
