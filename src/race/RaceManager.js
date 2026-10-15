// RaceManager: sessions (time trial / practice / qualifying / race), start procedure, timing & scoring, pit stops,
// penalties, flags, Safety Car / VSC, DRS eligibility, classification. Pure simulation (no DOM / no three.js).
import { clamp, makeRng, lerp, table } from '../core/math.js';
import { getTrack } from '../track/circuits/index.js';
import { Vehicle, DEFAULT_SETUP, CAR } from '../physics/VehiclePhysics.js';
import { CollisionSystem } from '../physics/CollisionAndDamage.js';
import { computeWake } from '../physics/Aerodynamics.js';
import { buildSpeedProfile } from '../ai/SpeedProfile.js';
import { DriverAI, PIT } from '../ai/OpponentAI.js';
import { WeatherSystem } from '../weather/WeatherSystem.js';
import { TEAMS, DRIVERS, DIFFICULTY, POINTS } from './Roster.js';
import { SURF } from '../track/TrackSystem.js';
import { COMPOUNDS } from '../physics/TireModel.js';

export const MODE = { TIME_TRIAL: 'timetrial', PRACTICE: 'practice', QUALI: 'quali', RACE: 'race' };
export const PHYS_HZ = 120;
export const PHYS_DT = 1 / PHYS_HZ;

const profileCache = new Map();
function profileFor(track) {
  if (!profileCache.has(track.id)) profileCache.set(track.id, buildSpeedProfile(track));
  return profileCache.get(track.id);
}

class DriverInfo {
  constructor(idx, car, def, isPlayer) {
    this.idx = idx; this.car = car; this.def = def; this.isPlayer = isPlayer;
    this.name = def.name; this.short = def.short; this.number = def.number;
    this.team = TEAMS[def.team]; this.ai = null;
    this.reset();
  }
  reset() {
    this.lapsCompleted = 0; this.lapStart = 0; this.lapTimes = []; this.best = Infinity; this.last = Infinity;
    this.bestSectors = [Infinity, Infinity, Infinity]; this.curSectors = [0, 0, 0]; this.sectorStart = 0; this.sector = 0;
    this.lastSectors = [0, 0, 0]; this.liveLapStart = 0;
    this.progress = 0; this.prevS = 0; this.pos = 0; this.gridPos = 0;
    this.penaltySec = 0; this.warnings = 0; this.offLine = false; this.lapInvalid = false; this.timing = false;
    this.status = 'running'; this.finished = false; this.finishTime = 0; this.retiredAt = 0;
    this.pitStops = 0; this.pitState = 'none'; this.box = 0; this.service = null; this.nextCompound = 'medium'; this.wantPit = false;
    this.compoundsUsed = new Set(); this.pitSpeeding = false; this.pitInTime = 0; this.lastStop = 0;
    this.gapLeader = 0; this.interval = 0; this.cooldown = 0; this.lastPenaltyT = -99; this.lapStartPit = false;
    this.qualiState = 'garage'; this.qualiRelease = 0; this.qualiRuns = 0; this.points = 0; this.removed = false; this.stationaryT = 0;
    this.drsEligible = new Uint8Array(4); this.inDrsZone = -1; this.bestLapTime = Infinity; this.leaderLapsDown = 0;
    this.goDelay = 0; this.startSlot = 0; this.lapHistoryPit = false; this.started = false; this.retiredAnnounced = false; this.hazardAdded = false;
  }
}

export class RaceManager {
  constructor(cfg) {
    this.cfg = Object.assign({
      trackId: 'monza', mode: MODE.RACE, laps: 3, aiCount: 19, difficulty: 'pro', weather: 'dry', seed: 42,
      playerTeam: 0, playerCompound: 'medium', wearMult: 2, assists: { abs: 0, tc: 1, steer: 1, autoGear: true, pitLimiter: true },
      setup: { ...DEFAULT_SETUP }, formationLap: false, safetyCar: 'auto', qualiMinutes: 6, practiceMinutes: 10,
      startGrid: null, player: true, penalties: true, flagsOn: true, weatherSpeed: 3, autopilotPlayer: false, damage: true,
    }, cfg);
    const c = this.cfg;
    this.rng = makeRng(c.seed);
    this.track = getTrack(c.trackId);
    this.profile = profileFor(this.track);
    this.weather = new WeatherSystem(c.weather, c.seed, this.track.def.weatherBias ?? 0.3, c.weatherSpeed);
    this.env = { water: 0, tAir: 25, tTrack: 35, wearMult: c.wearMult, forceSurface: undefined };
    this.weather.env(this.env);
    this.collision = new CollisionSystem();
    this.collision.rng = this.rng;
    this.physLod = false;
    this.cars = []; this.drivers = []; this.byS = []; this.order = [];
    this.messages = []; this.events = [];
    this.time = 0; this.simTime = 0; this.tick = 0; this.phase = 'init';
    this.flag = 'green'; this.sc = null; this.vsc = false; this.yellows = []; this.hazards = [];
    this.lights = 0; this.lightsTimer = 0; this.lightsHold = 0; this.raceStarted = false;
    this.sessionTime = 0; this.sessionLength = 0; this.chequered = false;
    this.bestLapOverall = Infinity; this.bestLapDriver = null; this.bestSectorsOverall = [Infinity, Infinity, Infinity];
    this.totalLaps = c.mode === MODE.RACE ? c.laps : 0;
    this.classification = null; this.finishedCount = 0;
    this.ctx = { race: true, ahead: null, aheadGap: 999, behind: null, behindGap: 999, neighbors: [], nNeighbors: 0, near: [], nNear: 0, grip: 1, paceLoss: null, sc: false, vsc: false, errors: true, pitExitBusy: false, wetness: 0, yellowNear: null, noPass: false, scSpeed: null };
    this.ctx.paceLoss = (car) => this.paceLoss(car);
    this.ctx.scSpeed = (car) => this.scSpeedFor(car);
    this.ctx.yellowNear = (s) => this.inYellow(s);
    this.replay = null;
    this.ghost = { rec: [], best: null, bestTime: Infinity };
    this.setupField();
  }

  // ---------------------------------------------------------------- field creation
  setupField() {
    const c = this.cfg, tr = this.track;
    const diff = DIFFICULTY[c.difficulty] || DIFFICULTY.pro;
    this.diff = diff;
    const withPlayer = c.player;
    const n = (withPlayer ? 1 : 0) + c.aiCount;
    // player gets driver slot 0 (index) but keeps a roster identity from the chosen team
    const roster = [];
    if (withPlayer) roster.push({ name: 'You', short: 'YOU', number: 1, team: c.playerTeam, talent: 0, isPlayer: true });
    let ai = 0;
    for (let i = 0; i < 20 && roster.length < n; i++) {
      const dd = DRIVERS[i];
      if (withPlayer && dd.team === c.playerTeam && ai === 0 && false) continue;
      roster.push({ ...dd, isPlayer: false });
    }
    roster.forEach((def, idx) => {
      const car = new Vehicle(idx);
      const d = new DriverInfo(idx, car, def, !!def.isPlayer);
      car.d = d; car.name = d.name;
      this.cars.push(car); this.drivers.push(d);
      const assists = def.isPlayer ? c.assists : { abs: 0, tc: 1, steer: 0, autoGear: true };
      Object.assign(car.assists, assists);
      car.setup = { ...DEFAULT_SETUP, ...(def.isPlayer ? c.setup : this.aiSetup(idx)) };
      car.wallE = tr.wallRestitution; car.wallMu = tr.wallFriction;
      car.applySetup();
      if (!def.isPlayer || c.autopilotPlayer) {
        const skill = lerp(diff.skill[1], diff.skill[0], clamp(def.talent, 0, 1)) + (this.rng() - 0.5) * 0.012;
        d.ai = new DriverAI(car, tr, this.profile, {
          seed: c.seed * 101 + idx, skill: clamp(skill, 0.7, 1.0), aggression: clamp(diff.aggr + (this.rng() - 0.5) * 0.3, 0.1, 1),
          consistency: clamp(0.88 + (def.talent < 0.5 ? 0.06 : 0) + (this.rng() - 0.5) * 0.08, 0.7, 0.99), errorScale: diff.errors,
        });
        d.ai.drsWanted = true;
        car.assists.steer = 0;
      }
    });
    this.player = this.drivers.find((d) => d.isPlayer) || null;
    this.startSession();
  }
  aiSetup(idx) {
    const r = this.rng;
    return { frontWing: 4 + Math.floor(r() * 3), rearWing: 4 + Math.floor(r() * 3), brakeBias: 0.57 };
  }

  fuelFor(laps, extra = 2.5) {
    const km = this.track.length / 1000;
    return clamp(laps * km * 0.36 + extra, 8, 105);
  }

  startSession() {
    const c = this.cfg, tr = this.track;
    const mode = c.mode;
    const startComp = (d) => {
      if (d.isPlayer) return c.playerCompound;
      const w = this.weather.water;
      if (w > 0.45) return 'wet';
      if (w > 0.12) return 'inter';
      return ['soft', 'medium', 'medium', 'hard', 'soft'][Math.floor(this.rng() * 5)];
    };
    this.drivers.forEach((d, i) => {
      const car = d.car;
      d.reset();
      d.box = i % this.track.pitBoxes.length;   // every car has its own box (reset() leaves it 0 -> in a race all cars queued for box 0)
      const comp = mode === MODE.RACE || mode === MODE.TIME_TRIAL || true ? startComp(d) : 'medium';
      car.fitTyres(comp, mode === MODE.RACE ? 80 : 70);
      car.wearMult = c.wearMult;
      d.compoundsUsed.add(comp); d.nextCompound = comp;
      let fuel;
      if (mode === MODE.RACE) fuel = this.fuelFor(c.laps, 3);
      else if (mode === MODE.QUALI) fuel = 12;
      else if (mode === MODE.TIME_TRIAL) fuel = 20;
      else fuel = 35;
      car.setFuel(fuel); car.pt.ers = 0.7 * 4e6;
      car.retired = false; car.removed = false; car.noCollide = false;
    });
    const L = tr.length;
    if (mode === MODE.RACE) {
      // grid order: given, else seeded by talent (+ randomness)
      let order = c.startGrid ? c.startGrid.slice() : this.drivers.map((d) => d.idx).sort((a, b) => {
        const ka = a === (this.player && this.player.idx) ? 0.5 : this.drivers[a].def.talent + (this.rng() - 0.5) * 0.25;
        const kb = b === (this.player && this.player.idx) ? 0.5 : this.drivers[b].def.talent + (this.rng() - 0.5) * 0.25;
        return ka - kb;
      });
      this.gridOrder = order;
      order.forEach((idx, k) => {
        const d = this.drivers[idx];
        const slot = tr.gridSlot(k);
        d.car.place(tr, slot.s, slot.n, 0);
        d.gridPos = k + 1; d.pos = k + 1; d.startSlot = k;
        d.progress = slot.s - L; d.prevS = slot.s; d.lapStart = 0; d.pitState = 'none';
        d.car.holdBrake = 0.7;
        if (d.ai) { d.ai.holdPit = true; d.ai.pace = 1; d.ai.startLane = { n: slot.n, s0: slot.s }; }
      });
      this.phase = 'grid';
      this.sessionLength = 0;
    } else if (mode === MODE.TIME_TRIAL) {
      this.drivers.forEach((d) => { if (!d.isPlayer && d.ai) { d.car.noCollide = true; d.car.removed = true; d.car.x = 1e5; } });
      const slot = tr.gridSlot(0);
      this.player.car.place(tr, slot.s, slot.n * 0.0, 0);
      this.player.progress = slot.s - L; this.player.prevS = slot.s;
      this.phase = 'session';
      this.sessionLength = 0;
      this.player.car.holdBrake = 0.0;
    } else {
      // practice / qualifying: everyone starts in the pit lane
      this.drivers.forEach((d, i) => {
        const box = tr.pitBoxes[i % tr.pitBoxes.length];
        d.box = i % tr.pitBoxes.length;
        const idx = Math.round(box.s / tr.ds) % tr.N;
        const n = tr.pitLaneN(idx, 'box');
        d.car.place(tr, box.s, n, 0);
        d.car.inPit = true; d.progress = 0; d.prevS = box.s; d.pitState = 'box';
        d.car.holdBrake = 0.8;
        if (d.ai) {
          d.ai.holdPit = true; d.ai.pit.box = d.box; d.ai.pace = 1;
          d.qualiState = 'garage';
          d.qualiRelease = 4 + this.rng() * (mode === MODE.QUALI ? this.cfg.qualiMinutes * 60 * 0.45 : 120);
        }
      });
      this.phase = 'session';
      this.sessionLength = (mode === MODE.QUALI ? c.qualiMinutes : c.practiceMinutes) * 60;
      if (this.player) this.player.car.holdBrake = 0.0;
    }
    // places can be restored after configuration: everyone begins stationary
    this.lightsText = '';
    if (mode !== MODE.RACE) this.raceStarted = true;
    this.order = this.drivers.slice();
    this.byS = this.cars.slice();
    this.pushMessage(mode === MODE.RACE ? 'Race: ' + c.laps + ' laps' : mode === MODE.QUALI ? 'Qualifying' : mode === MODE.PRACTICE ? 'Free practice' : 'Time trial', 'info', 4);
    this.initReplay();
  }

  /** Called by the UI when the player presses "start" on the grid. */
  begin() {
    if (this.phase === 'grid') {
      if (this.cfg.formationLap) this.startFormation();
      else this.startLights();
    }
  }
  startLights() {
    this.phase = 'lights'; this.lights = 0; this.lightsTimer = 0; this.lightsHold = 0.6 + this.rng() * 2.2; this.lightsStage = 'count';
    this.drivers.forEach((d) => { d.car.holdBrake = 0.7; });
  }
  startFormation() {
    this.phase = 'formation'; this.formationStart = this.time;
    this.drivers.forEach((d) => { d.car.holdBrake = 0; if (d.ai) { d.ai.holdPit = false; d.ai.pace = 0.5; } });
    this.formationProgress0 = this.drivers.map((d) => d.progress);
    this.pushMessage('Formation lap', 'info', 4);
  }

  // ---------------------------------------------------------------- helpers
  pushMessage(text, level = 'info', ttl = 5, driver = null) {
    this.messages.push({ text, level, ttl, t: this.simTime, driver });
    if (this.messages.length > 8) this.messages.shift();
    this.events.push({ type: 'message', text, level });
  }
  addPenalty(d, sec, reason) {
    if (!this.cfg.penalties) return;
    if (this.simTime - d.lastPenaltyT < 2.0 && reason === d.lastPenaltyReason) return;
    d.lastPenaltyT = this.simTime; d.lastPenaltyReason = reason;
    d.penaltySec += sec;
    if (d.isPlayer) this.pushMessage(`+${sec}s penalty: ${reason}`, 'penalty', 6);
    this.events.push({ type: 'penalty', driver: d, sec, reason });
  }
  inYellow(s) {
    for (let i = 0; i < this.yellows.length; i++) {
      const y = this.yellows[i];
      const dlt = this.track.delta(y.s0, s);
      if (dlt >= 0 && dlt <= y.len) return true;
    }
    return false;
  }
  /** speed factor from the axle that lost the most vertical load at a reference speed (damaged wings / floor); 1 when intact */
  aeroGripFactor(car) {
    const dm = car.damage, a = car.aero, st = a.setup;
    const fwd = dm.fwL + dm.fwR;
    if (fwd + dm.rw + dm.floor < 0.02) return 1;
    const fw0 = 0.35 + 0.075 * st.frontWing, rw0 = 0.45 + 0.085 * st.rearWing;
    const fm = (1 - 0.8 * dm.floor) * (1 - 0.12 * fwd);
    const claF0 = fw0 + 0.88, claR0 = rw0 + 1.6;
    const claF = fw0 * Math.max(0, 1 - 0.5 * fwd) + 0.88 * fm, claR = rw0 * (1 - dm.rw) + 1.6 * fm;
    const q = 1815, W = car.mass * 9.81, Wf = W * CAR.b / (CAR.a + CAR.b), Wr = W - Wf;
    const rF = (Wf + q * claF) / (Wf + q * claF0), rR = (Wr + q * claR) / (Wr + q * claR0);
    return Math.sqrt(clamp(Math.min(rF, rR), 0.3, 1));
  }
  paceLoss(car) {
    // grip of the current tyres relative to fresh warm tyres (+ damage); pace scales with sqrt(grip)
    let g = 0;
    const w = this.env.water;
    for (let i = 0; i < 4; i++) {
      const t = car.tires[i];
      g += t.tempGrip() * t.wearGrip() * table(t.compound.wet, w) * (1 - 0.5 * t.puncture);
    }
    g *= 0.25;
    const dm = car.damage;
    let pl = Math.sqrt(clamp(g / 0.985, 0.35, 1));
    pl *= this.aeroGripFactor(car) * (1 - 0.55 * Math.max(dm.sus[0], dm.sus[1], dm.sus[2], dm.sus[3]));   // a broken wishbone / pushrod: crawl to the pits (it was -10 %, i.e. flat out with a wheel hanging off)
    if (car.tires.some((t) => t.puncture > 0.4)) pl *= 0.6;
    // aquaplaning risk: slow down in standing water at high speed
    if (w > 0.3) pl *= 1 - 0.12 * (w - 0.3);
    return pl;
  }
  scSpeedFor(car) {
    const sc = this.sc;
    if (!sc) return 90;
    const d = car.d;
    const gap = this.track.delta(car.loc.s, sc.s);
    const first = d.pos === 1 || d === this.scLeader;
    if (first) {
      if (gap < 0) return sc.speed * 0.55;
      return sc.speed * (1 + clamp((gap - 24) / 70, 0, 0.55));
    }
    return sc.speed * 1.25;
  }

  // ---------------------------------------------------------------- main fixed step
  step(dt = PHYS_DT) {
    this.tick++;
    this.simTime += dt;
    this.weather.update(dt);
    this.weather.env(this.env);
    this.ctx.wetness = this.weather.water;
    const phase = this.phase;
    if (phase === 'grid') { if ((this.tick & 31) === 0) this.updateOrder(); this.stepWorld(dt); return; }
    if (phase === 'lights') { this.stepLights(dt); if ((this.tick & 31) === 0) this.updateOrder(); this.stepWorld(dt); return; }
    if (phase === 'formation') { this.stepFormation(dt); }
    if (phase === 'finished') { this.stepWorld(dt); return; }
    if (phase === 'racing' || phase === 'session' || phase === 'formation' || phase === 'finishing') {
      this.time += dt;
      if (this.sessionLength > 0 && !this.chequered) {
        this.sessionTime = this.time;
        if (this.time >= this.sessionLength) this.sessionExpired();
      }
    }
    this.stepWorld(dt);
    this.stepRules(dt);
  }

  stepLights(dt) {
    this.lightsTimer += dt;
    if (this.lightsStage === 'count') {
      const n = Math.min(5, Math.floor(this.lightsTimer / 0.9) + 1);
      if (n !== this.lights) { this.lights = n; this.events.push({ type: 'light', n }); }
      if (this.lightsTimer >= 5 * 0.9 + 0.2) { this.lightsStage = 'hold'; this.lightsTimer = 0; }
    } else if (this.lightsStage === 'hold') {
      if (this.lightsTimer >= this.lightsHold) this.lightsOut();
    }
  }
  lightsOut() {
    this.lights = 0; this.lightsStage = 'go'; this.phase = 'racing'; this.raceStarted = true; this.time = 0;
    this.events.push({ type: 'lightsOut' });
    this.pushMessage('GO!', 'info', 2);
    this.drivers.forEach((d) => {
      d.car.holdBrake = 0; d.lapStart = 0;
      if (d.ai) { d.goDelay = 0.15 + (d.startSlot >> 1) * 0.13 + this.rng() * 0.2; d.ai.pace = 1; }
    });
  }
  stepFormation(dt) {
    // pace-limited formation lap: AI follows in grid order; ends when the leader crosses the line again
    const first = this.drivers.slice().sort((a, b) => b.progress - a.progress)[0];
    this.drivers.forEach((d) => { if (d.ai) { d.ai.pace = 0.5; d.ai.noPassForm = true; } });
    if (first.progress - this.formationProgress0[first.idx] > this.track.length - 5 && !this.formEnding) {
      this.formEnding = true;
      this.returnToGrid();
    }
  }
  returnToGrid() {
    // stylised: after the formation lap the field is re-formed on the grid with warm tyres
    const tr = this.track, L = tr.length;
    this.gridOrder.forEach((idx, k) => {
      const d = this.drivers[idx];
      const slot = tr.gridSlot(k);
      const tires = d.car.tires.map((t) => [t.tSurf, t.tCore]);
      d.car.place(tr, slot.s, slot.n, 0);
      d.car.tires.forEach((t, i) => { t.tSurf = tires[i][0]; t.tCore = tires[i][1]; });
      d.progress = slot.s - L; d.prevS = slot.s; d.lapStart = 0;
      d.car.holdBrake = 0.7;
      if (d.ai) { d.ai.holdPit = true; d.ai.pace = 1; d.ai.off = 0; }
    });
    this.formEnding = false;
    this.pushMessage('Formation lap complete', 'info', 3);
    this.startLights();
  }

  // physics for all cars (AI decisions, LOD stepping, collisions)
  stepWorld(dt) {
    const tr = this.track, cars = this.cars, n = cars.length, ctx = this.ctx;
    // ---- spatial order along the lap (insertion sort of near-sorted data)
    const by = this.byS;
    for (let i = 1; i < n; i++) {
      const c = by[i]; const key = c.loc.s; let j = i - 1;
      while (j >= 0 && by[j].loc.s > key) { by[j + 1] = by[j]; j--; }
      by[j + 1] = c;
    }
    // ---- AI control (decision rate 60 Hz)
    const doAI = (this.tick & 1) === 0;
    const racing = this.phase === 'racing' || this.phase === 'formation' || this.phase === 'session';
    ctx.sc = !!this.sc; ctx.vsc = this.vsc; ctx.errors = this.cfg.mode === MODE.RACE;
    // pit exit light: red while a fast car is within ~3 s of the end of the pit lane
    ctx.pitExitBusy = false;
    for (let q = 0; q < n && !ctx.pitExitBusy; q++) {
      const o = cars[q]; if (o.inPit || o.retired || o.removed || o.speed < 30) continue;
      const g = tr.delta(o.loc.s, tr.pitOutS); if (g > 0 && g < 60 + o.speed * 3) ctx.pitExitBusy = true;
    }
    for (let k = 0; k < n; k++) {
      const car = by[k], d = car.d;
      if (!d.ai || car.removed) continue;
      if (this.phase === 'grid' || this.phase === 'lights') { d.ai.holdPit = true; if (!d.ai.enabled) continue; }
      if (this.phase === 'racing' && d.ai.holdPit && d.goDelay >= 0 && d.pitState === 'none' && this.cfg.mode === MODE.RACE && this.lightsStage === 'go') {
        d.goDelay -= dt; if (d.goDelay <= 0) { d.ai.holdPit = false; d.goDelay = -1; }
      }
      if (!doAI) continue;
      this.buildCtx(k, car, d);
      d.ai.update(dt * 2, ctx);
      // DRS usage
      car.drsAllowed = this.drsAllowedFor(d);
    }
    // player assists / DRS
    if (this.player && !this.player.ai) this.stepPlayerAssists(dt);
    // ---- wake + physics with LOD
    const focus = this.focusCar || (this.player && this.player.car) || cars[0];
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (car.removed) continue;
      computeWake(car, cars, n);
      // LOD: near the focus or in contact range -> every tick; far -> coarser steps
      const dx = car.x - focus.x, dz = car.z - focus.z;
      const dist2 = dx * dx + dz * dz;
      let lod = dist2 < 250 * 250 ? 0 : dist2 < 700 * 700 ? 1 : 2;
      if (car === focus) lod = 0;
      if (lod > 0) {
        // never coarsen a car that is close to another car (collision accuracy)
        for (let q = 0; q < n; q++) {
          const o = cars[q]; if (o === car || o.removed) continue;
          const ox = o.x - car.x, oz = o.z - car.z;
          if (ox * ox + oz * oz < 400) { lod = 0; break; }
        }
      }
      if (this.phase === 'racing' && this.cfg.mode === MODE.RACE && false) lod = 0;
      car.lod = lod;
      // Full-rate physics for everybody (coarser 2x steps visibly change handling: more spins). Coarsening is only an emergency
      // measure for the thermal / frame-time governor (physLod) and is limited to cars that are far from the camera.
      const step = this.physLod && lod > 0 ? 2 : 1;
      if (step === 1 || ((this.tick + i) % step) === 0) car.step(dt * step, tr, this.env);
      car.pt.auto = car.assists.autoGear;
    }
    // ---- collisions
    this.collision.clearEvents();
    this.collision.update(cars, n, tr, dt);
    const ev = this.collision.events;
    for (let i = 0; i < ev.length; i++) this.handleImpact(ev[i]);
    // ---- progress / lap detection
    this.stepTiming(dt);
    this.recordReplay();
  }

  buildCtx(k, car, d) {
    const by = this.byS, n = by.length, ctx = this.ctx, tr = this.track;
    ctx.ahead = null; ctx.aheadGap = 999; ctx.behind = null; ctx.behindGap = 999; ctx.nNeighbors = 0;
    let fb = null, fbG = 0;
    for (let o = 1; o <= 5; o++) {
      const c2 = by[(k + o) % n];
      if (c2 === car || c2.removed) continue;
      const g = tr.delta(car.loc.s, c2.loc.s);
      if (g < 0 || g > 230) break;
      if (c2.inPit !== car.inPit) continue;
      if (Math.abs(c2.loc.n - car.loc.n) < 2.6) { ctx.ahead = c2; ctx.aheadGap = Math.max(0, g - 5); fb = null; break; }
      if (!fb) { fb = c2; fbG = Math.max(0, g - 5); }
    }
    if (!ctx.ahead && fb) { ctx.ahead = fb; ctx.aheadGap = fbG; }
    for (let o = 1; o <= 4; o++) {
      const c2 = by[(k - o + n * 4) % n];
      if (c2 === car || c2.removed) continue;
      const g = tr.delta(c2.loc.s, car.loc.s);
      if (g < 0 || g > 100) break;
      if (c2.inPit !== car.inPit) continue;
      ctx.behind = c2; ctx.behindGap = Math.max(0, g - 5); break;
    }
    for (let o = -3; o <= 3; o++) {
      if (o === 0) continue;
      const c2 = by[(k + o + n * 4) % n];
      if (c2 === car || c2.removed) continue;
      if (Math.abs(tr.delta(car.loc.s, c2.loc.s)) < 9) ctx.neighbors[ctx.nNeighbors++] = c2;
    }
    // everything within ~75 m along the lap (stopped wrecks included) for the AI's time-to-collision layer
    ctx.nNear = 0;
    for (let o = -6; o <= 6; o++) {
      if (o === 0) continue;
      const c2 = by[(k + o + n * 4) % n];
      if (c2 === car || c2.removed || c2.inPit !== car.inPit) continue;
      const g2 = tr.delta(car.loc.s, c2.loc.s);
      if (g2 > -12 && g2 < 75 && ctx.nNear < 10) ctx.near[ctx.nNear++] = c2;
    }
    // blue flags (race) and slow laps (practice / qualifying): move off the line for a clearly faster car approaching from behind
    {
      const ai = d.ai; ai.yieldFlag = false;
      const bh = ctx.behind;
      if (bh && bh.d && ctx.behindGap < 110) {
        const bd = bh.d;
        if (this.cfg.mode === MODE.RACE) ai.yieldFlag = this.phase === 'racing' && !this.sc && bd.progress - d.progress > tr.length * 0.7 && !bd.finished;
        else ai.yieldFlag = (d.qualiState === 'out' || d.qualiState === 'in') && bd.qualiState === 'push';
      }
    }
    ctx.noPass = !!this.sc || (this.cfg.mode === MODE.RACE && this.raceStarted && this.time < 35) || d.ai.noPassForm || this.flag === 'yellowfull' || (this.cfg.mode !== MODE.RACE && false);
    // lapped cars let faster cars through (blue flag): stay off the racing line
    ctx.race = this.cfg.mode === MODE.RACE || true;
    // practice/quali: out/in laps and traffic management handled via pace in qualiProgram
    ctx.grip = 1;
    // lap-1 caution: the opening seconds are taken a little below the limit (cold tyres, full grid)
    if (this.cfg.mode === MODE.RACE && this.phase === 'racing' && d.pitState === 'none' && !this.sc) {
      const f = this.time < 40 ? 0.93 + 0.07 * clamp(this.time / 40, 0, 1) : 1;
      d.ai.pace = f * (d.paceTrim || 1);
    }
  }

  stepPlayerAssists(dt) {
    const d = this.player, car = d.car;
    const tr = this.track;
    // pit limiter
    car.limiterSpeed = tr.pitSpeedLimit;
    const inLane = car.inPit && tr.pitZone[car.loc.i] > 0;
    if (this.cfg.assists.pitLimiter !== false) car.ctrl.limiter = inLane || car.ctrl.limiterToggle;
    else car.ctrl.limiter = !!car.ctrl.limiterToggle;
    car.drsAllowed = this.drsAllowedFor(d);
    // hold brake on the grid
    if (this.phase === 'grid' || this.phase === 'lights') car.holdBrake = 0.7;
  }

  // ---------------------------------------------------------------- impacts, flags, hazards
  handleImpact(e) {
    const a = e.a, b = e.b;
    this.events.push({ type: 'impact', a, b, x: e.x, z: e.z, speed: e.speed, energy: e.energy, wall: e.wall, partLost: e.partLost });
    if (e.partLost) {
      const d = a.d;
      if (d.isPlayer) this.pushMessage(`Damage: ${e.partLost} lost`, 'damage', 5);
      this.events.push({ type: 'partLost', car: a, part: e.partLost, x: e.x, z: e.z });
      this.addHazard(a, 'debris');
    }
    if (e.speed > 6 && a.d.isPlayer && !this.cfg.damage) { /* damage disabled handled in physics */ }
    if (!e.wall && e.striker && e.speed > 3.5 && this.cfg.mode === MODE.RACE && this.raceStarted) {
      const st = e.striker.d;
      // first-lap, first-corner contact is racing (reduced sanction)
      const sec = e.speed > 9 ? 10 : 5;
      if (st.lapsCompleted > 0 || this.time > 12) this.addPenalty(st, sec, 'Causing a collision');
    }
    for (const c of [a, b]) {
      if (!c) continue;
      if (c.retired && !c.d.retiredAnnounced) {
        c.d.retiredAnnounced = true;
        c.d.status = 'dnf'; c.d.retiredAt = this.time;
        this.pushMessage(`${c.d.isPlayer ? 'YOU' : c.d.short} retired: ${c.retireReason}`, 'flag', 6);
        this.events.push({ type: 'retire', car: c });
        this.addHazard(c, 'stopped');
      }
    }
  }
  addHazard(car, kind) {
    const tr = this.track;
    if (car.inPit) return;
    const s = car.loc.s;
    const h = { car, kind, s, since: this.simTime };
    this.hazards.push(h);
    this.updateYellows();
  }
  updateYellows() {
    this.yellows.length = 0;
    for (const h of this.hazards) {
      this.yellows.push({ s0: (h.s - 260 + this.track.length) % this.track.length, len: 300, hazard: h });
    }
  }

  // ---------------------------------------------------------------- timing / lap detection
  stepTiming(dt) {
    const tr = this.track, L = tr.length;
    const t = this.time;
    for (let i = 0; i < this.drivers.length; i++) {
      const d = this.drivers[i], car = d.car;
      if (car.removed) continue;
      const s = car.loc.s;
      const dl = tr.delta(d.prevS, s);
      d.progress += dl;
      // line crossing
      if (d.prevS > L * 0.75 && s < L * 0.25 && dl > 0) this.lineCrossed(d, t);
      else {
        const s1 = tr.sectors[0], s2 = tr.sectors[1];
        if (d.prevS < s1 && s >= s1 && dl > 0) this.sectorCrossed(d, 0, t);
        else if (d.prevS < s2 && s >= s2 && dl > 0) this.sectorCrossed(d, 1, t);
      }
      d.prevS = s;
      if (d.isPlayer) this.recordPlayerTrace(d, s, t);
    }
  }
  /** delta-to-best trace (every 20 m) and the time-trial ghost (30 Hz) */
  recordPlayerTrace(d, s, t) {
    const B = Math.floor(s / 20);
    if (!d.trace) { d.trace = new Float32Array(Math.ceil(this.track.length / 20) + 2); d.bestTrace = null; d.lastBucket = -1; d.delta = 0; }
    if (B !== d.lastBucket) {
      d.lastBucket = B;
      if (this.cfg.mode === MODE.RACE || d.timing) {
        const lt = t - d.lapStart;
        d.trace[B] = lt;
        if (d.bestTrace && d.bestTrace[B] > 0) d.delta = lt - d.bestTrace[B];
      }
    }
    if (this.cfg.mode === MODE.TIME_TRIAL && d.timing && (this.tick & 3) === 0) this.ghost.rec.push(d.car.x, d.car.z, d.car.psi);
  }
  sectorCrossed(d, idx, t) {
    if (!d.timing && this.cfg.mode !== MODE.RACE) return;
    const st = t - d.sectorStart;
    d.curSectors[idx] = st; d.sectorStart = t; d.sector = idx + 1;
    if (this.cfg.mode === MODE.RACE || d.timing) {
      if (!d.lapInvalid && st < d.bestSectors[idx]) d.bestSectors[idx] = st;
      if (!d.lapInvalid && st < this.bestSectorsOverall[idx]) this.bestSectorsOverall[idx] = st;
    }
    if (d.isPlayer) this.events.push({ type: 'sector', idx, time: st, best: st <= d.bestSectors[idx] + 1e-6 });
  }
  lineCrossed(d, t) {
    const mode = this.cfg.mode;
    const car = d.car;
    if (this.phase === 'grid' || this.phase === 'lights' || this.phase === 'formation') return;
    // last sector
    d.curSectors[2] = t - d.sectorStart;
    if (mode === MODE.RACE) {
      if (d.finished) return;
      if (!d.started) { d.started = true; d.lapStart = t; d.sectorStart = t; d.sector = 0; return; } // crossing the line from the grid starts lap 1
      d.lapsCompleted++;
      const lt = t - d.lapStart;
      this.recordLap(d, lt, true);
      d.lapStart = t; d.sectorStart = t; d.sector = 0; d.lapInvalid = false;
      d.warnings = Math.max(0, d.warnings);
      if (this.chequered || d.lapsCompleted >= this.totalLaps) this.driverFinished(d, t);
      this.events.push({ type: 'lap', driver: d, lapTime: lt });
    } else {
      if (!d.timing) {
        d.timing = true; d.lapStart = t; d.sectorStart = t; d.sector = 0; d.lapInvalid = false; d.lapHadPit = false;
        if (d.isPlayer) this.pushMessage('Timing started', 'info', 2);
        return;
      }
      d.lapsCompleted++;
      const valid = !d.lapInvalid && !d.lapHadPit && !car.inPit;
      const lt = t - d.lapStart;
      this.recordLap(d, lt, valid);
      d.lapStart = t; d.sectorStart = t; d.sector = 0; d.lapInvalid = false; d.lapHadPit = car.inPit;
      this.events.push({ type: 'lap', driver: d, lapTime: lt, valid });
      if (this.chequered) this.driverFinished(d, t);
    }
  }
  recordLap(d, lt, valid) {
    d.last = lt; d.lastValid = valid;
    d.lapTimes.push({ t: lt, valid, compound: d.car.compound.id });
    d.lastSectors = d.curSectors.slice();
    if (valid && lt < d.best) {
      d.best = lt;
      if (d.isPlayer && d.trace) { d.bestTrace = d.trace.slice(); }
      if (lt < this.bestLapOverall) {
        this.bestLapOverall = lt; this.bestLapDriver = d;
        this.events.push({ type: 'bestLap', driver: d, time: lt });
        if (d.isPlayer) this.pushMessage('Fastest lap!', 'good', 4);
      }
      if (d.isPlayer && this.cfg.mode === MODE.TIME_TRIAL && lt < this.ghost.bestTime) { this.ghost.bestTime = lt; this.ghost.best = this.ghost.rec.slice(); }
    }
    if (d.isPlayer && this.cfg.mode === MODE.TIME_TRIAL) this.ghost.rec = [];
  }
  driverFinished(d, t) {
    if (d.finished) return;
    d.finished = true; d.finishTime = t;
    d.status = d.status === 'dnf' ? 'dnf' : 'finished';
    this.finishedCount++;
    if (d.ai) { d.ai.pace = 0.55; d.ai.errorScale = 0; d.cooldown = 1; }
    this.events.push({ type: 'finished', driver: d });
    if (d.isPlayer) this.pushMessage('Chequered flag', 'flag', 5);
  }

  // ---------------------------------------------------------------- rules, penalties, pit stops, SC
  stepRules(dt) {
    const mode = this.cfg.mode;
    const t = this.time;
    this.updateOrder();
    this.stepPit(dt);
    this.stepTrackLimits(dt);
    if (this.cfg.flagsOn) this.stepFlags(dt);
    this.stepSC(dt);
    this.stepAIPrograms(dt);
    this.stepRecovery(dt);
    this.stepDRS();
    // retire stationary wrecks / cars stuck
    for (const d of this.drivers) {
      const car = d.car;
      if (car.retired && d.status === 'running') { d.status = 'dnf'; d.retiredAt = t; this.addHazard(car, 'stopped'); }
      if (car.retired && !d.retiredAnnounced) { d.retiredAnnounced = true; this.pushMessage(`${d.isPlayer ? 'YOU' : d.short} retired: ${car.retireReason}`, 'flag', 6); this.events.push({ type: 'retire', car }); }
    }
    // messages age
    for (let i = this.messages.length - 1; i >= 0; i--) { this.messages[i].ttl -= dt; if (this.messages[i].ttl <= 0) this.messages.splice(i, 1); }
    // race end
    if (mode === MODE.RACE && this.phase === 'racing') {
      const leader = this.order[0];
      if (leader && leader.lapsCompleted >= this.totalLaps && !this.chequered) { this.chequered = true; this.flag = 'finish'; this.finishStart = this.simTime; this.phase = 'finishing'; this.events.push({ type: 'chequered' }); }
    }
    if (this.phase === 'finishing') {
      const running = this.drivers.filter((d) => d.status === 'running' && !d.finished && !d.car.removed);
      if (running.length === 0 || this.simTime - this.finishStart > 90) this.finishSession();
    }
    if (this.chequered && mode !== MODE.RACE && this.phase !== 'finished') {
      const waiting = this.drivers.filter((d) => d.timing && !d.finished && !d.car.retired && !d.car.inPit && (d.isPlayer || d.qualiState === 'push' || d.qualiState === 'out'));
      if (waiting.length === 0 || this.simTime - this.finishStart > 150) this.finishSession();
    }
  }
  sessionExpired() {
    this.chequered = true; this.flag = 'finish'; this.finishStart = this.simTime;
    this.events.push({ type: 'chequered' });
    this.pushMessage('Session time over: finish your lap', 'flag', 6);
    if (this.cfg.mode === MODE.PRACTICE) this.finishSession();
  }
  finishSession() {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.updateOrder(true);
    this.classification = this.buildClassification();
    this.events.push({ type: 'sessionEnd', classification: this.classification });
  }

  updateOrder(final = false) {
    const mode = this.cfg.mode;
    const ds = this.drivers;
    if (mode === MODE.RACE) {
      // finished cars keep their finishing order: lap count then finish time, then progress
      const key = (d) => {
        if (d.status === 'dnf') return -1e9 + d.lapsCompleted * 1000 + d.retiredAt * -0.001;
        if (d.finished) return 1e7 - d.finishTime - d.penaltySec;
        return d.progress;
      };
      const arr = ds.slice().sort((a, b) => {
        if (a.finished && b.finished) return (a.finishTime + a.penaltySec) - (b.finishTime + b.penaltySec);
        if (a.finished) return -1; if (b.finished) return 1;
        return key(b) - key(a);
      });
      this.order = arr;
      arr.forEach((d, i) => { d.pos = i + 1; });
      const lead = arr[0];
      for (let i = 0; i < arr.length; i++) {
        const d = arr[i], ahead = arr[i - 1];
        const sp = Math.max(40, d.car.speed);
        d.interval = i === 0 ? 0 : (ahead.progress - d.progress) / sp;
        d.gapLeader = i === 0 ? 0 : (lead.progress - d.progress) / sp;
        d.leaderLapsDown = Math.max(0, Math.floor((lead.progress - d.progress) / this.track.length));
      }
    } else {
      const arr = ds.slice().sort((a, b) => (a.best === b.best ? a.idx - b.idx : a.best - b.best));
      this.order = arr;
      arr.forEach((d, i) => { d.pos = i + 1; });
      const lead = arr[0];
      arr.forEach((d, i) => { d.gapLeader = isFinite(d.best) && isFinite(lead.best) ? d.best - lead.best : 0; d.interval = i === 0 || !isFinite(d.best) ? 0 : d.best - arr[i - 1].best; });
    }
  }

  stepTrackLimits(dt) {
    const mode = this.cfg.mode;
    for (const d of this.drivers) {
      const car = d.car;
      if (car.removed || car.inPit || car.retired) { d.offLine = false; continue; }
      const sf = car.surf;
      const out = sf[0] !== SURF.ASPHALT && sf[1] !== SURF.ASPHALT && sf[2] !== SURF.ASPHALT && sf[3] !== SURF.ASPHALT
        && sf[0] !== SURF.PIT && sf[1] !== SURF.PIT && sf[2] !== SURF.PIT && sf[3] !== SURF.PIT;
      if (out && !d.offLine) {
        d.offLine = true;
        if (mode === MODE.RACE) {
          d.warnings++;
          if (d.isPlayer) this.pushMessage(d.warnings % 3 === 0 ? 'Track limits: 5s penalty' : `Track limits warning ${d.warnings % 3}/3`, 'flag', 4);
          if (d.warnings % 3 === 0) this.addPenalty(d, 5, 'Track limits');
        } else if (d.timing && !d.lapInvalid) {
          d.lapInvalid = true;
          if (d.isPlayer) this.pushMessage('Lap time deleted: track limits', 'penalty', 4);
        }
      } else if (!out && d.offLine) d.offLine = false;
    }
  }

  // pit lane logic: service, speeding, wants
  stepPit(dt) {
    const tr = this.track;
    const mode = this.cfg.mode;
    for (const d of this.drivers) {
      const car = d.car;
      if (car.removed) continue;
      const loc = car.loc;
      const lane = car.inPit && tr.pitZone[loc.i] === 2;
      if (car.inPit && d.pitState === 'none' ) { d.pitState = 'in'; d.pitInTime = this.time; d.pitSpeeding = false; d.lapHadPit = true; if (mode !== MODE.RACE) d.lapInvalid = d.lapInvalid; }
      if (!car.inPit && d.pitState === 'in') { d.pitState = 'none'; this.events.push({ type: 'pitExit', driver: d }); }
      if (!car.inPit && d.pitState === 'box') d.pitState = 'none';
      // speeding
      if (lane && car.speed > tr.pitSpeedLimit + 1.0 && !d.pitSpeeding && mode !== MODE.TIME_TRIAL) {
        d.pitSpeeding = true;
        this.addPenalty(d, mode === MODE.RACE ? 5 : 0.0001, 'Pit lane speeding');
        if (d.isPlayer && mode !== MODE.RACE) this.pushMessage('Pit lane speeding', 'penalty', 4);
      }
      // service at own box
      const box = tr.pitBoxes[d.box];
      if (!car.inPit) d.servedVisit = false;
      if (car.inPit && !d.service && lane && !d.servedVisit) {
        const ds = tr.delta(loc.s, box.s);
        const idx = loc.i;
        const nBox = tr.pitLaneN(idx, 'box');
        if (Math.abs(ds) < 5.5 && Math.abs(loc.n - nBox) < 3.2 && car.speed < 0.7) this.startService(d);
      }
      if (d.service) {
        d.service.t += dt;
        car.holdBrake = 1;
        if (d.service.t >= d.service.dur) this.finishService(d);
      }
    }
  }
  startService(d) {
    const car = d.car;
    const dm = car.damage;
    let dur = 2.2 + this.rng() * 0.9;
    if (dm.fwL + dm.fwR > 0.05) dur += 3.2;
    if (dm.rw > 0.05) dur += 2.0;
    const changeTyres = !!d.nextCompound;
    if (!changeTyres) dur -= 1;
    d.service = { t: 0, dur, compound: d.nextCompound };
    d.pitState = 'service';
    if (d.ai) { d.ai.pit.state = PIT.SERVICE; d.ai.holdPit = true; }
    if (d.isPlayer) this.pushMessage('Pit stop in progress', 'info', dur);
    this.events.push({ type: 'pitService', driver: d, dur });
  }
  finishService(d) {
    const car = d.car, dm = car.damage;
    const comp = d.service.compound || car.compound.id;
    car.fitTyres(comp, 72);
    d.compoundsUsed.add(comp);
    dm.fwL = dm.fwR = 0; if (dm.rw < 0.9) dm.rw = 0; dm.floor *= 0.5;
    dm.tyrePunct.fill(0);
    for (let i = 0; i < 4; i++) if (dm.sus[i] < 0.9) dm.sus[i] = 0;   // the crew replaces bent wishbones / rods (a destroyed corner is a retirement)
    d.service = null; d.pitStops++; d.pitState = 'in'; d.lastStop = this.time; d.servedVisit = true; d.forcePit = false;
    car.holdBrake = 0;
    d.wantPit = false;
    if (d.ai) { d.ai.pit.state = PIT.EXIT; d.ai.holdPit = false; d.ai.pit.want = false; }
    if (d.isPlayer) this.pushMessage('Pit stop complete', 'good', 3);
    this.events.push({ type: 'pitDone', driver: d });
  }

  /** player requests the crew (UI "box this lap") */
  requestPit(d, compound) {
    d.wantPit = true;
    if (compound) d.nextCompound = compound;
    if (d.isPlayer) this.pushMessage('BOX, BOX this lap', 'info', 3);
  }

  // AI strategy + per-mode scripts (quali, practice)
  stepAIPrograms(dt) {
    const mode = this.cfg.mode;
    const tr = this.track;
    for (const d of this.drivers) {
      const ai = d.ai, car = d.car;
      if (!ai || car.removed) continue;
      if (mode === MODE.RACE) { this.raceStrategy(d, dt); continue; }
      if (mode === MODE.TIME_TRIAL) continue;
      this.qualiProgram(d, dt);
    }
  }
  /** marshals/recovery: put a stranded car back on the racing surface (AI automatically; player via key) */
  recoverCar(d, penalty = false) {
    const car = d.car, tr = this.track;
    if (car.retired || car.removed) return false;
    const s = car.loc.s;
    // keep the damage and tyre states, reset the motion
    const tires = car.tires.map((t) => [t.tSurf, t.tCore]);
    const ahead = tr.delta(s, s) + 6;
    const n = tr.line[Math.round(((s + ahead) % tr.length) / tr.ds) % tr.N] * 0.5;
    car.place(tr, (s + ahead) % tr.length, n, 0);
    car.tires.forEach((t, i) => { t.tSurf = tires[i][0]; t.tCore = tires[i][1]; });
    car.inPit = false;
    d.recoveries = (d.recoveries || 0) + 1;
    d.offStillT = 0;
    if (d.ai) { d.ai.stuckT = 0; d.ai.off = 0; d.ai.passSide = 0; d.ai.mistake.t = 0; d.ai.startLane = null; }
    if (penalty && this.cfg.mode === MODE.RACE) { d.penaltySec += 0; }
    this.events.push({ type: 'recovered', driver: d });
    if (d.isPlayer) this.pushMessage('Car recovered to the track', 'info', 3);
    return true;
  }
  stepRecovery(dt) {
    for (const d of this.drivers) {
      const car = d.car;
      if (!d.ai || car.retired || car.removed || car.inPit || d.finished) continue;
      const tr = this.track, loc = car.loc;
      const edge = loc.n >= 0 ? tr.wl[loc.i] : tr.wr[loc.i];
      const offRoad = Math.abs(loc.n) > edge + 1.0 && car.surf[0] !== 0 && car.surf[3] !== 0;
      const slow = car.speed < 4;
      if (offRoad && slow) {
        d.offStillT = (d.offStillT || 0) + dt;
        if (d.offStillT > 5 && !d.ai.holdPit) {
          if ((d.recoveries || 0) >= 4) { car.retired = true; car.retireReason = 'Stuck'; } else this.recoverCar(d);
        }
      } else d.offStillT = Math.max(0, (d.offStillT || 0) - dt);
      // gridlock breaker: wants to go (target speed) but has hardly advanced for 20 s -> marshals clear wrecks ahead, then the car is
      // lifted a little further up the road onto free tarmac
      if (this.phase === 'racing' && this.time > 15 && !d.ai.holdPit && d.pitState === 'none') {
        d.gridT = (d.gridT || 0) + dt;
        if (d.gridT > 20) {
          const moved = tr.delta(d.gridS ?? loc.s, loc.s);
          d.gridT = 0; d.gridS = loc.s;
          if (moved < 18 && d.ai.targetSpeed > 12) {
            for (const o of this.cars) {
              if (o === car || o.removed || !o.retired) continue;
              const g = tr.delta(loc.s, o.loc.s);
              if (g > -8 && g < 40) { o.removed = true; o.noCollide = true; o.x = 1e5; o.z = 1e5; this.events.push({ type: 'carRemoved', car: o }); }
            }
            if ((d.recoveries || 0) >= 6) { car.retired = true; car.retireReason = 'Stuck'; } else this.recoverClear(d);
          }
        }
      } else { d.gridT = 0; d.gridS = loc.s; }
    }
  }
  /** like recoverCar, but looks for a gap in the traffic (no car within 9 m) on the road ahead */
  recoverClear(d) {
    const car = d.car, tr = this.track, s0 = car.loc.s;
    let best = 8;
    for (let k = 0; k < 14; k++) {
      const s = s0 + 8 + k * 7;
      let free = true;
      for (const o of this.cars) { if (o === car || o.removed) continue; if (Math.abs(tr.delta(s, o.loc.s)) < 9) { free = false; break; } }
      if (free) { best = 8 + k * 7; break; }
    }
    const tires = car.tires.map((t) => [t.tSurf, t.tCore]);
    const sNew = (s0 + best) % tr.length;
    car.place(tr, sNew, tr.line[Math.round(sNew / tr.ds) % tr.N] * 0.5, 4);
    car.tires.forEach((t, i) => { t.tSurf = tires[i][0]; t.tCore = tires[i][1]; });
    car.inPit = false; d.recoveries = (d.recoveries || 0) + 1; d.offStillT = 0;
    if (d.ai) { d.ai.stuckT = 0; d.ai.off = 0; d.ai.offCmd = 0; d.ai.passSide = 0; d.ai.mistake.t = 0; d.ai.startLane = null; d.ai.merge = null; }
    this.events.push({ type: 'recovered', driver: d });
  }

  raceStrategy(d, dt) {
    const ai = d.ai, car = d.car;
    if (d.finished) { ai.pit.want = false; return; }
    if (this.phase !== 'racing') return;
    if (!car.retired && Math.max(car.damage.sus[0], car.damage.sus[1], car.damage.sus[2], car.damage.sus[3]) >= 0.9) { car.retired = true; car.retireReason = 'Suspension damage'; ai.enabled = false; return; }
    if ((this.tick & 31) !== 0) return;
    const w = this.env.water;
    let avgWear = 0; for (const t of car.tires) avgWear += t.wear; avgWear /= 4;
    const comp = car.compound.id;
    let want = false, next = d.nextCompound;
    const remaining = this.totalLaps - d.lapsCompleted;
    const dm = car.damage;
    const wearLimit = 0.58 + (d.idx % 5) * 0.06;
    const slick = comp === 'soft' || comp === 'medium' || comp === 'hard';
    if (slick && w > 0.16) { want = true; next = w > 0.5 ? 'wet' : 'inter'; }
    else if (comp === 'inter' && (w > 0.55 || w < 0.05)) { want = true; next = w > 0.55 ? 'wet' : 'medium'; }
    else if (comp === 'wet' && w < 0.3) { want = true; next = w < 0.1 ? 'medium' : 'inter'; }
    else if (avgWear > wearLimit && remaining > 1) { want = true; next = w > 0.12 ? 'inter' : (comp === 'soft' ? 'hard' : 'medium'); }
    else if ((dm.fwL + dm.fwR > 0.8 || dm.rw > 0.5 || dm.floor > 0.5) && remaining > 1) { want = true; next = d.nextCompound; }
    else if (car.tires.some((t) => t.puncture > 0.4) && remaining > 1) { want = true; }
    if (d.forcePit) { want = true; next = d.nextCompound; }
    if (want && d.pitStops < 4 && !d.service && this.simTime - d.lastStop > 25 && !this.sc) { ai.pit.want = true; ai.pit.box = d.box; d.wantPit = true; d.nextCompound = next; }
    else if (want && this.sc) { ai.pit.want = true; ai.pit.box = d.box; d.wantPit = true; d.nextCompound = next; }
    else if (!want && !d.service && ai.pit.state === PIT.NONE) { ai.pit.want = false; d.wantPit = false; }
    // fuel-aware pacing / retired cars
    if (car.retired) ai.enabled = false;
  }
  /** push-lap pace multiplier: slightly above race pace (low fuel, fresh softs), scaled by the difficulty tier */
  pushPace(quali) { const p = 1 + 0.2 * (this.diff.quali - 0.9); return quali ? p : 0.97 * p; }
  qualiProgram(d, dt) {
    const ai = d.ai, car = d.car, tr = this.track;
    const diff = this.diff;
    const quali = this.cfg.mode === MODE.QUALI;
    if (car.retired) { ai.enabled = false; return; }
    const t = this.time;
    const finishing = this.chequered;
    switch (d.qualiState) {
      case 'garage':
        ai.holdPit = true; car.holdBrake = 0.8;
        if (t >= d.qualiRelease && !finishing && (!quali || t < this.sessionLength - 80)) {
          d.qualiState = 'out'; ai.holdPit = false; car.holdBrake = 0; ai.pace = quali ? 0.8 : 0.85;
          // new set of tyres for the run
          const comp = this.weather.recommendedCompound('soft');
          if (car.compound.id !== comp) { car.fitTyres(comp, 70); d.compoundsUsed.add(comp); }
          ai.pit.state = PIT.EXIT; ai.pit.want = false;
          d.timing = false; d.lapInvalid = false; d.outStartLaps = d.lapsCompleted;
        }
        break;
      case 'out':
        // out lap: low pace until the car has crossed the line (timing armed) then push
        if (d.timing && !car.inPit && d.lapsCompleted > (d.outStartLaps ?? -1)) { d.qualiState = 'push'; ai.pace = this.pushPace(quali); }   // the lap that starts in the pit lane is the out lap
        else ai.pace = quali ? 0.82 : 0.85;
        break;
      case 'push':
        if (d.lapsCompleted > (d.runStartLaps ?? -1) && d.lapStartedPush) { /* handled below */ }
        if (d.pushLapsDone === undefined) d.pushLapsDone = 0;
        if (d.lastLapCount === undefined) d.lastLapCount = d.lapsCompleted;
        if (d.lapsCompleted > d.lastLapCount) { // finished a timed lap
          d.lastLapCount = d.lapsCompleted;
          d.qualiState = 'in'; ai.pace = 0.8; ai.pit.want = true; ai.pit.box = d.box; d.runs = (d.runs || 0) + 1;
        }
        break;
      case 'in':
        ai.pace = 0.8;
        if (car.inPit && d.pitState !== 'none' && ai.pit.state === PIT.SERVICE) { d.qualiState = 'wait'; d.qualiRelease = t + 20 + this.rng() * 50; }
        break;
      case 'wait':
        ai.pit.want = false;
        if (!d.service && ai.pit.state !== PIT.SERVICE) { d.qualiState = 'garage'; d.lastLapCount = undefined; if ((d.runs || 0) >= (quali ? 2 : 4) || finishing) { d.qualiState = 'done'; } }
        break;
      default: break;
    }
    // service in practice/quali swaps tyres: tag next compound
    if (d.qualiState === 'in') d.nextCompound = this.weather.recommendedCompound('soft');
    if (!d.finished && finishing && (d.qualiState === 'push' || d.qualiState === 'out') ) { /* complete current lap, then pit */ }
  }

  // ---------------------------------------------------------------- flags & safety car
  stepFlags(dt) {
    if (this.cfg.mode !== MODE.RACE || this.phase !== 'racing') { this.stepHazards(dt); return; }
    this.stepHazards(dt);
    const sc = this.cfg.safetyCar;
    if (sc === 'off' || this.chequered) return;
    if (this.flag === 'green' && this.hazards.length > 0 && this.totalLaps - this.order[0].lapsCompleted > 1) {
      const h = this.hazards.find((x) => this.simTime - x.since > 4 && x.kind === 'stopped' && x.car.retired);
      if (h) {
        const tr = this.track, loc = h.car.loc;
        const edge = loc.n >= 0 ? tr.wl[loc.i] : tr.wr[loc.i];
        const far = Math.abs(loc.n) > edge + (loc.n >= 0 ? tr.kerbL[loc.i] : tr.kerbR[loc.i]) + 5;
        if (far && this.rng() < 0.6) this.deployVSC(); else this.deploySC();
      }
    }
  }
  stepHazards(dt) {
    // clear hazards: cars that move again, are removed by marshals
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i], c = h.car;
      let clear = false;
      if (h.kind === 'debris') clear = this.simTime - h.since > 12;
      else if (c.removed) clear = true;
      else if (c.retired && this.simTime - h.since > (this.sc ? 28 : 22)) {
        // marshals remove the car
        c.removed = true; c.noCollide = true; c.x = 1e5; c.z = 1e5; clear = true;
        this.events.push({ type: 'carRemoved', car: c });
      } else if (!c.retired && c.speed > 8 && this.simTime - h.since > 3) clear = true;
      if (clear) this.hazards.splice(i, 1);
    }
    // stationary non-retired cars (spun) create local yellows
    for (const d of this.drivers) {
      const car = d.car;
      if (car.removed || car.retired || car.inPit || d.finished) { d.stationaryT = 0; continue; }
      if (car.speed < 3 && this.phase === 'racing' && !d.ai?.holdPit && this.time > 8) {
        d.stationaryT += dt;
        if (d.stationaryT > 4 && !d.hazardAdded) { d.hazardAdded = true; this.hazards.push({ car, kind: 'spun', s: car.loc.s, since: this.simTime }); }
      } else { d.stationaryT = 0; if (d.hazardAdded && car.speed > 8) { d.hazardAdded = false; const k = this.hazards.findIndex((h) => h.car === car && h.kind === 'spun'); if (k >= 0) this.hazards.splice(k, 1); } }
    }
    this.updateYellows();
  }
  deploySC() {
    if (this.sc) return;
    const leader = this.order[0];
    const tr = this.track;
    const speed = clamp(this.profile.v[(leader.car.loc.i + 200) % tr.N] * 0.52, 36, 56);
    this.sc = { s: (leader.car.loc.s + 160) % tr.length, speed: speed * 0.9, laps: 0, ending: false, since: this.simTime, startLap: leader.lapsCompleted, n: 0 };
    this.scLeader = leader;
    this.flag = 'sc';
    this.drivers.forEach((d) => { if (d.ai) d.ai.noPass = true; });
    this.pushMessage('SAFETY CAR deployed', 'flag', 6);
    this.events.push({ type: 'sc', on: true });
  }
  deployVSC() {
    if (this.vsc || this.sc) return;
    this.vsc = true; this.flag = 'vsc'; this.vscSince = this.simTime;
    this.pushMessage('VIRTUAL SAFETY CAR', 'flag', 6);
    this.events.push({ type: 'vsc', on: true });
  }
  stepSC(dt) {
    const tr = this.track;
    if (this.vsc) {
      const noHazard = this.hazards.every((h) => h.kind === 'debris') ;
      if (noHazard && this.simTime - this.vscSince > 18) { this.vsc = false; this.flag = 'green'; this.pushMessage('VSC ending - GREEN', 'good', 4); this.events.push({ type: 'vsc', on: false }); }
    }
    const sc = this.sc;
    if (!sc) return;
    // move the SC along the racing line at its own speed
    sc.s = (sc.s + sc.speed * dt) % tr.length;
    const leader = this.order[0];
    this.scLeader = this.drivers.filter((d) => d.status === 'running' && !d.car.removed).sort((a, b) => b.progress - a.progress)[0] || leader;
    sc.n = tr.line[Math.round(sc.s / tr.ds) % tr.N];
    // end conditions
    const clear = this.hazards.filter((h) => h.kind !== 'debris').length === 0;
    if (!sc.ending && clear && this.simTime - sc.since > 70 && this.scLeader.lapsCompleted > sc.startLap) {
      sc.ending = true;
      this.pushMessage('Safety car in this lap', 'flag', 5);
      this.events.push({ type: 'scEnding' });
    }
    if (sc.ending) {
      // SC leaves at the pit entry; field released when the leader crosses the line
      const dToPit = tr.delta(sc.s, tr.pitInS);
      if (dToPit < 30 && dToPit > -50 || (this.scLeader.prevS < 50 && this.scLeader.progress > 0 && this.scReleaseReady)) { sc.speed = 24; }
      if (!this.scReleaseReady && Math.abs(dToPit) < 30) { this.scReleaseReady = true; }
      if (this.scReleaseReady && this.scLeader.car.loc.s < tr.length * 0.2 && this.scLeader.car.loc.s > 5 && this.scLeader.lapsCompleted > sc.startLap) {
        this.sc = null; this.scReleaseReady = false; this.flag = 'green'; this.scLeader = null;
        this.drivers.forEach((d) => { if (d.ai) d.ai.noPass = false; });
        this.pushMessage('GREEN FLAG - race restart', 'good', 5);
        this.events.push({ type: 'sc', on: false });
      }
    }
    // overtaking under SC: penalise the player (if the car ahead is passed)
    if (this.sc && this.player && this.player.pos > 1 && !this.player.car.inPit) {
      const p = this.player;
      const ahead = this.order[p.pos - 2];
      if (ahead && !ahead.car.inPit && p.progress > ahead.progress + 3 && ahead.status === 'running') { /* only meaningful if order lags; keep silent */ }
    }
  }

  // ---------------------------------------------------------------- DRS
  drsAllowedFor(d) {
    const car = d.car;
    if (this.cfg.mode === MODE.RACE) {
      if (this.phase !== 'racing' || d.lapsCompleted < 2 || this.flag !== 'green' || this.env.water > 0.25 || this.inYellow(car.loc.s)) return false;
    } else if (this.env.water > 0.25) return false;
    const tr = this.track;
    const s = car.loc.s;
    for (let z = 0; z < tr.drsZones.length; z++) {
      const dz = tr.drsZones[z];
      const rel = tr.delta(dz.start, s);
      if (rel >= -2 && rel <= dz.length) {
        if (this.cfg.mode !== MODE.RACE) return true;
        return d.drsEligible[z] === 1;
      }
    }
    return false;
  }
  stepDRS() {
    if (this.cfg.mode !== MODE.RACE) return;
    const tr = this.track;
    for (const d of this.drivers) {
      const car = d.car;
      if (car.removed) continue;
      const s = car.loc.s;
      for (let z = 0; z < tr.drsZones.length; z++) {
        const dz = tr.drsZones[z];
        const rel = tr.delta(dz.detect, s);
        // detection point: within 1 m past the line
        if (rel >= 0 && rel < 4 && car.speed > 20) {
          if (!d.detectDone || d.detectDone[z] !== d.lapsCompleted) {
            d.detectDone = d.detectDone || [];
            d.detectDone[z] = d.lapsCompleted;
            // time gap to the car ahead
            const idx = d.pos - 2;
            const ahead = idx >= 0 ? this.order[idx] : null;
            let eligible = false;
            if (ahead && ahead.status === 'running' && !ahead.car.inPit) {
              const gap = (ahead.progress - d.progress) / Math.max(30, car.speed);
              eligible = gap > 0 && gap < 1.0;
            }
            d.drsEligible[z] = eligible ? 1 : 0;
            if (eligible && d.isPlayer) this.pushMessage('DRS available', 'info', 2);
          }
        }
        // the eligibility ends with the zone
        if (tr.delta(dz.start, s) > dz.length + 20) d.drsEligible[z] = 0;
      }
    }
  }

  // ---------------------------------------------------------------- replay buffer (30 Hz, ~25 s)
  initReplay() {
    const n = this.cars.length;
    this.replay = { n, stride: 14, frames: 30 * 25, data: null, head: 0, count: 0, accum: 0 };
    this.replay.data = new Float32Array(this.replay.frames * n * this.replay.stride + this.replay.frames);
  }
  recordReplay() {
    const r = this.replay;
    if (!r || (this.tick & 3) !== 0) return;
    const n = r.n, S = r.stride;
    const base = r.head * (n * S + 1);
    r.data[base] = this.simTime;
    for (let i = 0; i < n; i++) {
      const c = this.cars[i]; const o = base + 1 + i * S;
      r.data[o] = c.x; r.data[o + 1] = c.y; r.data[o + 2] = c.z; r.data[o + 3] = c.psi; r.data[o + 4] = c.h; r.data[o + 5] = c.th; r.data[o + 6] = c.ph; r.data[o + 7] = c.steer;
      r.data[o + 8] = c.wheelAngle[0]; r.data[o + 9] = c.wheelAngle[1]; r.data[o + 10] = c.wheelAngle[2]; r.data[o + 11] = c.wheelAngle[3];
      r.data[o + 12] = c.removed ? 1 : 0; r.data[o + 13] = c.speed;
    }
    r.head = (r.head + 1) % r.frames; if (r.count < r.frames) r.count++;
  }

  // ---------------------------------------------------------------- results
  buildClassification() {
    const mode = this.cfg.mode;
    const rows = [];
    this.updateOrder(true);
    const lead = this.order[0];
    this.order.forEach((d, i) => {
      const total = d.finished ? d.finishTime + d.penaltySec : null;
      rows.push({
        pos: i + 1, driver: d, name: d.name, short: d.short, team: d.team, number: d.number, laps: d.lapsCompleted,
        time: total, penalty: d.penaltySec, best: d.best, pits: d.pitStops, status: d.status, grid: d.gridPos,
        gap: mode === MODE.RACE ? (d.finished && lead.finished ? (d.finishTime + d.penaltySec) - (lead.finishTime + lead.penaltySec) : null) : d.gapLeader,
        points: mode === MODE.RACE && d.status !== 'dnf' && i < POINTS.length ? POINTS[i] : 0,
      });
    });
    return rows;
  }

  /** hand the player's controls to a driver AI (used by headless tests / autopilot) */
  get leader() { return this.order[0]; }
}
