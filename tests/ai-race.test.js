import { describe, it, expect } from 'vitest';
import { CIRCUITS, getTrack } from '../src/track/circuits/index.js';
import { Vehicle } from '../src/physics/VehiclePhysics.js';
import { buildSpeedProfile } from '../src/ai/SpeedProfile.js';
import { DriverAI } from '../src/ai/OpponentAI.js';
import { RaceManager, MODE, PHYS_DT } from '../src/race/RaceManager.js';

const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 1 };

describe('AI driver (same physics as the player)', () => {
  for (const def of CIRCUITS) {
    it(`completes clean, plausible laps at ${def.name}`, () => {
      const track = getTrack(def.id), prof = buildSpeedProfile(track);
      const car = new Vehicle(1); car.assists.tc = 2; car.assists.steer = 0; car.setFuel(40); car.fitTyres('soft', 95);
      const slot = track.gridSlot(0); car.place(track, slot.s, slot.n, 0);
      const ai = new DriverAI(car, track, prof, { skill: 0.96 });
      const ctx = { race: false, ahead: null, aheadGap: 999, behind: null, behindGap: 999, neighbors: [], nNeighbors: 0, grip: 1, paceLoss: () => 1, sc: false, vsc: false, errors: false, wetness: 0, yellowNear: null, noPass: true };
      let t = 0, last = car.loc.s, start = 0, laps = [], off = 0;
      while (laps.length < 2 && t < prof.lapTime * 4) {
        ai.update(PHYS_DT, ctx); car.step(PHYS_DT, track, ENV); t += PHYS_DT;
        const s = car.loc.s; if (last > track.length * 0.9 && s < track.length * 0.1) { laps.push(t - start); start = t; } last = s;
        const edge = car.loc.n >= 0 ? track.wl[car.loc.i] : track.wr[car.loc.i]; if (Math.abs(car.loc.n) - edge > 1.2) off += PHYS_DT;
      }
      expect(laps.length).toBe(2);
      expect(off).toBeLessThan(3);
      const lap = laps[1];
      expect(lap).toBeGreaterThan(prof.lapTime * 0.97); expect(lap).toBeLessThan(prof.lapTime * 1.4);
      expect(lap).toBeGreaterThan(50); expect(lap).toBeLessThan(130);
    });
  }
});

function runRace(cfg, maxSeconds) {
  const rm = new RaceManager({ difficulty: 'pro', weather: 'dry', autopilotPlayer: true, seed: 11, wearMult: 3, ...cfg });
  rm.begin(); const ev = [];
  while (rm.phase !== 'finished' && rm.simTime < maxSeconds) { rm.step(PHYS_DT); for (const e of rm.events) ev.push(e); rm.events.length = 0; }
  return { rm, ev };
}

describe('RaceManager', () => {
  it('runs a full grand prix: start lights, laps, classification, points', () => {
    const { rm, ev } = runRace({ trackId: 'monza', mode: MODE.RACE, laps: 2, aiCount: 7, safetyCar: 'off' }, 700);
    expect(rm.phase).toBe('finished');
    expect(ev.filter((e) => e.type === 'light').length).toBe(5);
    expect(ev.some((e) => e.type === 'lightsOut')).toBe(true);
    const cl = rm.classification;
    expect(cl.length).toBe(8);
    expect(new Set(cl.map((r) => r.pos)).size).toBe(8);
    expect(cl[0].points).toBe(25);
    const winner = cl[0]; expect(winner.laps).toBe(2); expect(winner.time).toBeGreaterThan(100); expect(winner.time).toBeLessThan(300);
    for (let i = 1; i < cl.length; i++) if (cl[i].status === 'finished' && cl[i - 1].status === 'finished') expect(cl[i].time).toBeGreaterThanOrEqual(cl[i - 1].time - 1e-6);
  });
  it('is deterministic for the same seed', () => {
    const a = runRace({ trackId: 'silverstone', mode: MODE.RACE, laps: 1, aiCount: 5, seed: 5 }, 400).rm;
    const b = runRace({ trackId: 'silverstone', mode: MODE.RACE, laps: 1, aiCount: 5, seed: 5 }, 400).rm;
    expect(a.classification.map((r) => r.short).join()).toBe(b.classification.map((r) => r.short).join());
    expect(a.simTime).toBeCloseTo(b.simTime, 5);
  });
  it('performs pit stops: stops in the box, changes tyres, repairs, then rejoins', () => {
    const rm = new RaceManager({ trackId: 'monza', mode: MODE.RACE, laps: 3, aiCount: 0, autopilotPlayer: true, seed: 3, wearMult: 1, safetyCar: 'off' });
    rm.begin(); const d = rm.player; let forced = false, serviced = false;
    while (rm.time < 200 && rm.phase !== 'finished') {
      rm.step(PHYS_DT);
      if (rm.time > 20 && !forced) { forced = true; d.forcePit = true; d.nextCompound = 'hard'; d.car.damage.fwL = 0.7; }
      for (const e of rm.events) if (e.type === 'pitDone') serviced = true; rm.events.length = 0;
      if (serviced && !d.car.inPit && d.pitState === 'none') break;
    }
    expect(serviced).toBe(true);
    expect(d.car.compound.id).toBe('hard'); expect(d.car.damage.fwL).toBe(0); expect(d.pitStops).toBe(1);
    expect(d.car.retired).toBe(false);
    expect(d.penaltySec).toBe(0);
  });
  it('deploys the safety car after a retirement and restarts the race', () => {
    const rm = new RaceManager({ trackId: 'monza', mode: MODE.RACE, laps: 6, aiCount: 5, autopilotPlayer: true, seed: 8, safetyCar: 'auto' });
    rm.begin(); let sc = false, back = false;
    while (rm.time < 500 && rm.phase !== 'finished') {
      rm.step(PHYS_DT);
      if (rm.time > 25 && !sc && !rm.sc && !rm.vsc && rm.flag === 'green') { const v = rm.cars[3]; v.retired = true; v.retireReason = 'Test'; v.vx = 0; v.vz = 0; sc = true; }
      if (rm.flag === 'sc' || rm.flag === 'vsc') back = back || false;
      for (const e of rm.events) if (e.type === 'sc' && e.on === false) back = true; rm.events.length = 0;
      if (back) break;
    }
    expect(sc).toBe(true); expect(back).toBe(true); expect(rm.flag).toBe('green');
  });
  it('time trial and practice only contain what they should; qualifying produces a timed order', () => {
    const tt = runRace({ trackId: 'bahrain', mode: MODE.TIME_TRIAL, aiCount: 19 }, 2);
    expect(tt.rm.drivers.filter((d) => !d.car.removed).length).toBe(1);
    const q = runRace({ trackId: 'monza', mode: MODE.QUALI, aiCount: 5, qualiMinutes: 4 }, 600);
    expect(q.rm.phase).toBe('finished');
    const cl = q.rm.classification; const timed = cl.filter((r) => isFinite(r.best));
    expect(timed.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < timed.length; i++) expect(timed[i].best).toBeGreaterThanOrEqual(timed[i - 1].best);
    expect(timed[0].best).toBeGreaterThan(60); expect(timed[0].best).toBeLessThan(120);
  });
  it('rain slows the field (wet tyres, aquaplaning risk) and triggers tyre changes', () => {
    const dry = runRace({ trackId: 'silverstone', mode: MODE.RACE, laps: 2, aiCount: 3, seed: 2, safetyCar: 'off' }, 500).rm;
    const wet = runRace({ trackId: 'silverstone', mode: MODE.RACE, laps: 2, aiCount: 3, seed: 2, weather: 'heavy', safetyCar: 'off', playerCompound: 'wet' }, 700).rm;
    const best = (rm) => Math.min(...rm.drivers.map((d) => d.best));
    expect(best(wet)).toBeGreaterThan(best(dry) * 1.08);
    expect(wet.drivers.every((d) => d.car.compound.id === 'wet' || d.car.compound.id === 'inter')).toBe(true);
  });
  it('penalises track limits and collisions in a race', () => {
    const rm = new RaceManager({ trackId: 'monza', mode: MODE.RACE, laps: 3, aiCount: 1, seed: 4 });
    rm.begin(); for (let i = 0; i < 120 * 12; i++) rm.step(PHYS_DT);
    const d = rm.drivers[1]; const s0 = d.penaltySec;
    rm.addPenalty(d, 5, 'Test'); expect(d.penaltySec).toBe(s0 + 5);
    d.car.surf.fill(3); d.offLine = false; d.car.inPit = false; for (let k = 0; k < 3; k++) { d.offLine = false; rm.stepTrackLimits(0.01); d.car.surf.fill(0); rm.stepTrackLimits(0.01); d.car.surf.fill(3); }
    expect(d.warnings).toBeGreaterThanOrEqual(3); expect(d.penaltySec).toBeGreaterThanOrEqual(s0 + 10);
  });
  it('keeps the fixed physics step cheap enough for mobile (20 cars)', () => {
    const rm = new RaceManager({ trackId: 'spa', mode: MODE.RACE, laps: 2, aiCount: 19, seed: 6, autopilotPlayer: true });
    rm.begin(); for (let i = 0; i < 120 * 5; i++) rm.step(PHYS_DT);
    const t0 = performance.now(); const N = 120 * 10; for (let i = 0; i < N; i++) rm.step(PHYS_DT);
    const perStep = (performance.now() - t0) / N;
    expect(perStep).toBeLessThan(1.2);   // ms per 1/120 s step for 20 cars on a dev box; mobile budget is 8.3 ms
  });
});

describe('traffic behaviour (regression for multi-car robustness)', () => {
  for (const [track, seeds] of [['silverstone', [2, 3, 4]], ['monza', [1, 3, 5]]]) {
    it(`a 12-car field races ${track} (3 seeds) with few retirements and few serious contacts`, () => {
      let dnf = 0, serious = 0, finished = 0;
      for (const seed of seeds) {
        const rm = new RaceManager({ trackId: track, mode: MODE.RACE, laps: 2, aiCount: 11, difficulty: 'pro', autopilotPlayer: true, seed, wearMult: 3 });
        rm.begin();
        while (rm.phase !== 'finished' && rm.simTime < 420) {
          rm.step(PHYS_DT);
          for (const e of rm.events) if (e.type === 'impact' && e.energy > 25000) serious++;
          rm.events.length = 0;
        }
        expect(rm.phase).toBe('finished');
        dnf += rm.drivers.filter((d) => d.status === 'dnf').length; finished += rm.drivers.filter((d) => d.status === 'finished').length;
      }
      expect(dnf).toBeLessThanOrEqual(7);          // of 36 starters (was ~15+ before the traffic work)
      expect(finished).toBeGreaterThanOrEqual(28);
      expect(serious).toBeLessThan(45);
    }, 60000);
  }
  it('wing damage slows an AI car (pace follows the remaining downforce)', () => {
    const rm = new RaceManager({ trackId: 'monza', mode: MODE.RACE, laps: 2, aiCount: 1, seed: 1, autopilotPlayer: true });
    const car = rm.cars[1]; const clean = rm.paceLoss(car);
    car.damage.fwL = 1; car.damage.fwR = 1; const nose = rm.paceLoss(car);
    car.damage.rw = 1; const both = rm.paceLoss(car);
    expect(nose).toBeLessThan(clean * 0.95); expect(both).toBeLessThanOrEqual(nose);
    car.damage.fwL = 0; car.damage.fwR = 0; const tail = rm.paceLoss(car);   // rear wing alone also costs pace
    expect(tail).toBeLessThan(clean * 0.97);
  });
  it('pit lane entry is open on narrow circuits (Monaco AI can reach its box and be serviced)', () => {
    const rm = new RaceManager({ trackId: 'monaco', mode: MODE.RACE, laps: 4, aiCount: 2, seed: 3, autopilotPlayer: true, safetyCar: 'off', wearMult: 3 });
    rm.begin(); const d = rm.drivers[1]; let hit = false;
    while (rm.simTime < 200 && d.pitStops === 0) { rm.step(PHYS_DT); if (!hit && rm.simTime > 20) { d.car.damage.fwL = 1; d.car.damage.fwR = 1; hit = true; } }
    expect(d.pitStops).toBeGreaterThanOrEqual(1);
  });
});
