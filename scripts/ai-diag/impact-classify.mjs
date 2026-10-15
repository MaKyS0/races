// Classify the root cause of each first contact between two cars over several races.
import { RaceManager, MODE, PHYS_DT } from '../../src/race/RaceManager.js';
const tracks = (process.argv[2] || 'monza,silverstone').split(','), seeds = (process.argv[3] || '1,2,3').split(',').map(Number), laps = +(process.argv[4] || 3), ai = +(process.argv[5] || 15);
const tally = {}; const samples = {}; let recent = [];
const cls = (e, rm) => {
  const A = e.a, B = e.b, dA = A.d, dB = B.d;
  const spun = (c) => { const p = c._p || c; return Math.abs(p.r) > 0.9 || (p.speed < 12 && !c.inPit); };
  const off = (c) => { const edge = c.loc.n >= 0 ? rm.track.wl[c.loc.i] : rm.track.wr[c.loc.i]; return Math.abs(c.loc.n) - edge > 0.5; };
  const pit = (c) => c.inPit || (c.d.ai && c.d.ai.merge);
  if (rm.simTime < 25) return 'start/lap1-first-turns';
  if (pit(A) || pit(B)) return 'pit lane/exit';
  if (spun(A) || spun(B)) return (spun(A) && spun(B)) ? 'both slow/spun (pileup)' : 'hit a slow/spun car';
  if (off(A) || off(B)) return 'off-track car rejoining';
  const mk = (d) => d.ai && d.ai.mistake.t > 0;
  if (mk(dA) || mk(dB)) return 'driver mistake';
  const sA = rm.track.delta(A.loc.s, B.loc.s); const dn = Math.abs(A.loc.n - B.loc.n);
  if (dn < 1.8) return 'rear-end (same lane)';
  return 'side contact (lateral ' + (dA.ai?.passSide || dB.ai?.passSide ? 'during pass)' : 'no pass)');
};
for (const t of tracks) for (const seed of seeds) {
  const rm = new RaceManager({ trackId: t, mode: MODE.RACE, laps, aiCount: ai, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
  rm.begin(); const seen = new Set(); recent = []; const past = new Map(); let k = 0;
  while (rm.phase !== 'finished' && rm.simTime < laps * 150 + 150) {
    rm.step(PHYS_DT); k++;
    if (k % 120 === 0) for (const c of rm.cars) past.set(c, { speed: c.speed, r: c.r, n: c.loc.n, s: c.loc.s });
    for (const e of rm.events) if (e.type === 'impact' && !e.wall && e.b && e.energy > 40000) {
      const key = Math.min(e.a.id, e.b.id) + '-' + Math.max(e.a.id, e.b.id) + '-' + Math.floor(rm.simTime / 6); if (seen.has(key)) continue; seen.add(key);
      recent = recent.filter((r) => rm.simTime - r.t < 14); const near = recent.some((r) => Math.abs(rm.track.delta(r.s, e.a.loc.s)) < 200);
      recent.push({ t: rm.simTime, s: e.a.loc.s }); if (near) { tally['(secondary: within 14 s / 200 m of an earlier contact)'] = (tally['(secondary: within 14 s / 200 m of an earlier contact)'] || 0) + 1; continue; }
      const pa = past.get(e.a) || e.a, pb = past.get(e.b) || e.b; e.a._p = pa; e.b._p = pb;
      const c = cls(e, rm); tally[c] = (tally[c] || 0) + 1; (samples[c] ||= []).push(`${t}#${seed}@${rm.simTime.toFixed(0)}s s=${e.a.loc.s | 0}`);
    }
    rm.events.length = 0;
  }
}
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k, '  e.g.', (samples[k] || []).slice(0, 3).join(' | '));
