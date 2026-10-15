// Trace single-car crashes in small fields and show who was near.  node scripts/pack-trace.mjs track ai seeds maxShow
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t = 'silverstone', aiS = '3', seedsS = '3,4,5', maxS = '4'] = process.argv.slice(2);
let shown = 0;
for (const seed of seedsS.split(',').map(Number)) {
  const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: 3, aiCount: +aiS, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
  rm.begin(); const hist = new Map(); let k = 0; const done = new Set();
  while (rm.phase !== 'finished' && rm.simTime < 3 * 150 + 150 && shown < +maxS) {
    rm.step(PHYS_DT); k++;
    if (k % 12 === 0) { const row = rm.cars.map((c) => ({ c, a: c.d.ai })); for (const { c, a } of row) { let h = hist.get(c); if (!h) hist.set(c, h = []); h.push({ t: rm.simTime, s: c.loc.s, n: c.loc.n, v: c.speed, vt: a ? a.targetSpeed : 0, thr: c.ctrl.throttle, brk: c.ctrl.brake, st: c.ctrl.steer, slipF: Math.max(Math.abs(c.slipA[0]), Math.abs(c.slipA[1])), slipR: Math.max(Math.abs(c.slipA[2]), Math.abs(c.slipA[3])), off: a?.offCmd ?? 0, ps: a?.passSide, sq: a?.squeeze, fg: a ? Math.min(a.followGap, 999) : 0, pr: a?.pressure, mk: a?.mistake.t > 0 ? a.mistake.kind : 0 }); if (h.length > 40) h.shift(); } }
    for (const e of rm.events) if (e.type === 'impact' && e.wall && e.energy > 25000 && !done.has(e.a) && shown < +maxS) {
      done.add(e.a); shown++; const c = e.a;
      console.log(`\n##### ${t}#${seed} AI=${aiS} t=${rm.simTime.toFixed(1)} lap ${c.d.lapsCompleted + 1} WALL ${c.d.short} vn=${e.speed.toFixed(1)} s=${c.loc.s | 0}`);
      const h = hist.get(c); for (const r of h.slice(-(+process.env.ROWS || 14))) {
        const others = rm.cars.filter((o) => o !== c).map((o) => { const hh = hist.get(o); const q = hh.reduce((b, x) => Math.abs(x.t - r.t) < Math.abs(b.t - r.t) ? x : b, hh[0]); return { n: o.d.short, ds: +(rm.track.delta(r.s, q.s)).toFixed(0), dn: +(q.n - r.n).toFixed(1) }; }).filter((o) => Math.abs(o.ds) < 60);
        console.log(`  t${r.t.toFixed(1)} s${r.s | 0} n${r.n.toFixed(1)} v${r.v | 0}/${r.vt | 0} T${r.thr.toFixed(2)} B${r.brk.toFixed(2)} st${r.st.toFixed(2)} sF${r.slipF.toFixed(2)} sR${r.slipR.toFixed(2)} off${r.off.toFixed(1)} ps${r.ps} sq${r.sq} fg${r.fg | 0} pr${(r.pr || 0).toFixed(1)} mk${r.mk} near:${others.map((o) => `${o.n}(${o.ds},${o.dn})`).join(' ')}`);
      }
    }
    rm.events.length = 0;
  }
}
