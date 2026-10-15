// Trace cars that hit the wall within an s-window: node scripts/spot-trace.mjs track s0 s1 seeds laps ai maxShow
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t, s0, s1, seedsS = '1,2,3,4', lapsS = '3', aiS = '15', maxS = '6'] = process.argv.slice(2);
let shown = 0;
for (const seed of seedsS.split(',').map(Number)) {
  const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: +lapsS, aiCount: +aiS, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
  rm.begin(); const hist = new Map(); let k = 0; const done = new Set();
  while (rm.phase !== 'finished' && rm.simTime < +lapsS * 150 + 150 && shown < +maxS) {
    rm.step(PHYS_DT); k++;
    if (k % 24 === 0) for (const c of rm.cars) { let h = hist.get(c); if (!h) hist.set(c, h = []); const a = c.d.ai; h.push(`t${rm.simTime.toFixed(1)} s${c.loc.s | 0} n${c.loc.n.toFixed(1)} v${c.speed | 0}/${a ? a.targetSpeed | 0 : 0} ${c.ctrl.brake > 0.05 ? 'B' + c.ctrl.brake.toFixed(2) : 'T' + c.ctrl.throttle.toFixed(2)} st${c.ctrl.steer.toFixed(2)} sF${Math.max(Math.abs(c.slipA[0]), Math.abs(c.slipA[1])).toFixed(2)} sR${Math.max(Math.abs(c.slipA[2]), Math.abs(c.slipA[3])).toFixed(2)} ps${a?.passSide} fg${a ? Math.min(a.followGap, 999) | 0 : 0} dm${(c.damage.fwL + c.damage.fwR + c.damage.rw).toFixed(1)} Tf${c.tires[0].tSurf | 0}`); if (h.length > 14) h.shift(); }
    for (const e of rm.events) if (e.type === 'impact' && e.wall && e.energy > 25000 && e.a.loc.s >= +s0 && e.a.loc.s < +s1 && !done.has(e.a) && shown < +maxS) {
      done.add(e.a); shown++; console.log(`\n##### ${t}#${seed} t=${rm.simTime.toFixed(1)} lap ${e.a.d.lapsCompleted + 1} WALL ${e.a.d.short} vn=${e.speed.toFixed(1)}`);
      for (const r of hist.get(e.a).slice(-12)) console.log('   ' + r);
    }
    rm.events.length = 0;
  }
}
