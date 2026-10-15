import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const [t = 'monza', seed = '1', laps = '3', ai = '15'] = process.argv.slice(2);
const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps: +laps, aiCount: +ai, difficulty: 'pro', autopilotPlayer: true, seed: +seed, wearMult: 3, errors: process.env.NOERR ? false : undefined });
rm.begin();
while (rm.phase !== 'finished' && rm.simTime < +laps * 150 + 150) rm.step(PHYS_DT);
for (const d of rm.drivers) if (d.status === 'dnf') console.log(d.short.padEnd(4), 'retired t=' + d.retiredAt.toFixed(0).padStart(4), 'lap', d.lapsCompleted + 1, d.car.retireReason, 'dmg chassis', d.car.damage.chassis.toFixed(2), 'sus', d.car.damage.sus.map((x) => x.toFixed(1)).join(','), 's=' + (d.car.loc.s | 0), 'n=' + d.car.loc.n.toFixed(0));
console.log('finished', rm.drivers.filter((d) => d.status === 'finished').length, 'dnf', rm.drivers.filter((d) => d.status === 'dnf').length);
