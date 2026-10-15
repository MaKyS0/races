// Headless full-race smoke test: 20 AI cars (player on autopilot), prints summary + performance numbers.
import { RaceManager, MODE, PHYS_DT } from '../src/race/RaceManager.js';
const track = process.argv[2] || 'monza';
const laps = +(process.argv[3] || 3);
const weather = process.argv[4] || 'dry';
const t0 = performance.now();
const rm = new RaceManager({ trackId: track, mode: MODE.RACE, laps, aiCount: 19, difficulty: process.env.DIFF || 'pro', weather, autopilotPlayer: true, seed: +(process.env.SEED || 7), wearMult: 3 });
console.log('setup ms', (performance.now() - t0).toFixed(0), 'cars', rm.cars.length, 'track', rm.track.length.toFixed(0));
rm.begin();
let steps = 0, maxStepMs = 0, sum = 0;
const evs = { impact: 0, pit: 0, sc: 0, penalty: 0, retire: 0 };
const maxT = laps * 130 + 120;
while (rm.phase !== 'finished' && rm.simTime < maxT) {
  const a = performance.now();
  rm.step(PHYS_DT);
  const dt = performance.now() - a; sum += dt; maxStepMs = Math.max(maxStepMs, dt); steps++;
  for (const e of rm.events) { if (e.type === 'impact') evs.impact++; if (e.type === 'pitService') evs.pit++; if (e.type === 'sc') evs.sc++; if (e.type === 'penalty') evs.penalty++; if (e.type === 'retire') evs.retire++; if (e.type === 'message' && process.env.V) console.log(rm.simTime.toFixed(1), e.text); }
  rm.events.length = 0;
  if (steps % (120 * 30) === 0) console.log(`t=${rm.simTime.toFixed(0)} phase=${rm.phase} flag=${rm.flag} lead laps=${rm.order[0].lapsCompleted} cars running=${rm.drivers.filter((d) => d.status === 'running').length}`);
}
console.log(`finished phase=${rm.phase} simTime=${rm.simTime.toFixed(1)} wall=${((performance.now() - t0) / 1000).toFixed(1)}s avgStep=${(sum / steps).toFixed(3)}ms maxStep=${maxStepMs.toFixed(2)}ms realtimeFactor=${(rm.simTime / (sum / 1000)).toFixed(1)}x`);
console.log('events', JSON.stringify(evs));
const cl = rm.classification || rm.buildClassification();
for (const r of cl.slice(0, 22)) console.log(String(r.pos).padStart(2), r.short.padEnd(4), r.team.name.padEnd(20), 'laps', r.laps, 'time', r.time ? r.time.toFixed(1) : '-', 'pen', r.penalty, 'best', isFinite(r.best) ? r.best.toFixed(2) : '-', 'pits', r.pits, r.status, 'grid', r.grid);
