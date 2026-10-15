// Allocation check: heap growth over a long 20-car race simulation (physics + AI + rules, no rendering).
// node --expose-gc scripts/gc-check.mjs [simSeconds]
import { RaceManager, MODE, PHYS_DT } from '../src/race/RaceManager.js';
const secs = +(process.argv[2] || 120);
const rm = new RaceManager({ trackId: 'spa', mode: MODE.RACE, laps: 50, aiCount: 19, seed: 5, autopilotPlayer: true, safetyCar: 'off' });
rm.begin();
for (let i = 0; i < 120 * 20; i++) rm.step(PHYS_DT);   // warm-up
global.gc(); const h0 = process.memoryUsage().heapUsed; let peak = h0, gcs = 0;
const t0 = performance.now(); const N = 120 * secs; let worst = 0;
for (let i = 0; i < N; i++) {
  const a = performance.now(); rm.step(PHYS_DT); const d = performance.now() - a; if (d > worst) worst = d;
  if ((i & 1023) === 0) { const h = process.memoryUsage().heapUsed; if (h < peak - 2e6) gcs++; peak = Math.max(peak, h); }
}
const ms = performance.now() - t0; global.gc(); const h1 = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ simSeconds: secs, wallMs: Math.round(ms), perStepMs: +(ms / N).toFixed(3), worstStepMs: +worst.toFixed(2), retainedGrowthMB: +((h1 - h0) / 1e6).toFixed(2), peakAboveStartMB: +((peak - h0) / 1e6).toFixed(1), minorGCsSeen: gcs, cars: rm.drivers.length }));
