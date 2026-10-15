import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t = 'monaco', seed = '1', ai = '0', secs = '200', minE = '2000'] = process.argv.slice(2);
const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: 3, aiCount: +ai, difficulty: 'pro', autopilotPlayer: true, seed: +seed, wearMult: 3 });
rm.begin(); let k = 0;
while (rm.simTime < +secs && rm.phase !== 'finished') { rm.step(PHYS_DT); for (const e of rm.events) if (e.type === 'impact' && e.energy > +minE) { const c = e.a; console.log(`t=${rm.simTime.toFixed(1)} ${e.wall ? 'WALL' : 'CAR '} ${c.d.short} s=${c.loc.s | 0} n=${c.loc.n.toFixed(1)} wl=${rm.track.wl[c.loc.i].toFixed(1)} wr=${rm.track.wr[c.loc.i].toFixed(1)} wallL=${rm.track.wallL[c.loc.i].toFixed(1)} wallR=${rm.track.wallR[c.loc.i].toFixed(1)} v=${c.speed.toFixed(0)} vn=${e.speed.toFixed(1)} E=${e.energy | 0} lx=${e.lx?.toFixed(1)} ly=${e.ly?.toFixed(1)} part=${e.partLost}`); } rm.events.length = 0; }
