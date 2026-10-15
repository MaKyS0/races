import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t = 'monaco', seed = '1', ai = '9', until = '300'] = process.argv.slice(2);
const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: 3, aiCount: +ai, difficulty: 'pro', autopilotPlayer: true, seed: +seed, wearMult: 3 });
rm.begin(); while (rm.simTime < +until && rm.phase !== 'finished') rm.step(PHYS_DT);
console.log('t', rm.simTime.toFixed(0), 'phase', rm.phase, 'sc', !!rm.sc, 'flag', rm.flag);
for (const d of rm.drivers) { const c = d.car, a = d.ai; console.log(d.short.padEnd(4), d.status.padEnd(8), 'lap', d.lapsCompleted + 1, 's', c.loc.s | 0, 'n', c.loc.n.toFixed(1), 'v', c.speed.toFixed(1), 'retired', c.retired, c.retireReason, 'removed', !!c.removed, 'inPit', c.inPit, 'vt', a ? a.targetSpeed.toFixed(0) : '-', 'stuckT', a ? a.stuckT.toFixed(0) : '-', 'rec', d.recoveries || 0, 'sq', a?.squeeze, 'ps', a?.passSide, 'dm', (c.damage.fwL + c.damage.fwR + c.damage.rw).toFixed(1)); }
