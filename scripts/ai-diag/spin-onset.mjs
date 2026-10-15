// Detect the ONSET of a spin (body slip crossing 0.3 rad at speed > 40 m/s, or yaw rate > 1 rad/s at v>30) with no contact
// in the previous 3 s; print the 1.2 s that led to it.
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const tracks = (process.argv[2] || 'monza,silverstone').split(','), seeds = (process.argv[3] || '1,2,3').split(',').map(Number), laps = +(process.argv[4] || 3), ai = +(process.argv[5] || 15), maxShow = +(process.argv[6] || 6);
let shown = 0, total = 0; const kinds = {};
for (const t of tracks) for (const seed of seeds) {
  const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps, aiCount: ai, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
  rm.begin(); const lastHit = new Map(), cool = new Map(), hist = new Map(); let k = 0;
  while (rm.phase !== 'finished' && rm.simTime < laps * 150 + 150) {
    rm.step(PHYS_DT); k++;
    for (const e of rm.events) if (e.type === 'impact') { lastHit.set(e.a, rm.simTime); if (e.b) lastHit.set(e.b, rm.simTime); }
    rm.events.length = 0;
    if (k % 24 === 0) for (const c of rm.cars) { let h = hist.get(c); if (!h) hist.set(c, h = []); const a = c.d.ai; h.push({ t: +rm.simTime.toFixed(1), s: c.loc.s | 0, n: +c.loc.n.toFixed(1), v: c.speed | 0, vt: a ? a.targetSpeed | 0 : 0, ayG: +(c.ayBody / 9.81).toFixed(2), r: +c.r.toFixed(2), st: +c.ctrl.steer.toFixed(2), th: +c.ctrl.throttle.toFixed(2), br: +c.ctrl.brake.toFixed(2), sF: +Math.max(Math.abs(c.slipA[0]), Math.abs(c.slipA[1])).toFixed(2), sR: +Math.max(Math.abs(c.slipA[2]), Math.abs(c.slipA[3])).toFixed(2), TfL: c.tires[0].tSurf | 0, TrL: c.tires[2].tSurf | 0, mk: a ? a.mistake.t > 0 ? a.mistake.kind : 0 : 0, fg: a ? Math.min(a.followGap, 999) | 0 : 0, wet: rm.env.water, lod: c.lod, off: a ? +a.off.toFixed(1) : 0, sq: a?.squeeze, ps: a?.passSide, pace: a ? +a.pace.toFixed(2) : 0, skill: a ? +a.skill.toFixed(2) : 0, fuel: c.fuel | 0, dmg: +(c.damage.fwL + c.damage.fwR + c.damage.rw).toFixed(2), grip: +[0,1,2,3].reduce((q,i)=>q+c.tires[i].tempGrip()*c.tires[i].wearGrip(),0).toFixed(2)/4 }); if (h.length > 8) h.shift(); }
    for (const c of rm.cars) {
      if (c.retired || c.inPit || !c.d.ai || rm.simTime < 10) continue;
      const slip = Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1)));
      if ((slip > 0.35 && c.speed > 30) && rm.simTime - (lastHit.get(c) ?? -99) > 3 && rm.simTime - (cool.get(c) ?? -99) > 10) {
        cool.set(c, rm.simTime); total++;
        const h = hist.get(c) || []; const last = h[h.length - 1] || {};
        const kind = last.mk ? 'driver mistake' : (last.sR > last.sF ? 'rear stepped out' : 'front pushed (understeer)') + (last.th > 0.7 ? ' on throttle' : last.br > 0.3 ? ' under braking' : ' coasting');
        kinds[kind] = (kinds[kind] || 0) + 1;
        if (shown < maxShow) { shown++; console.log(`\n--- ${t}#${seed} ${c.d.short} t=${rm.simTime.toFixed(1)} lap ${c.d.lapsCompleted + 1} ${kind}`); for (const r of h.slice(-6)) console.log(' ', JSON.stringify(r)); }
      }
    }
  }
}
console.log('\nspin onsets (no contact in prior 3 s):', total, kinds);
