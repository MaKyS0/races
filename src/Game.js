// Game: wires simulation, renderer, input, audio, HUD, menus. Fixed-step physics (120 Hz) decoupled from rendering with
// interpolation; frame limiter + dynamic resolution + thermal governor via Perf.
import * as THREE from 'three';
import { Settings } from './core/Settings.js';
import { Input } from './core/Input.js';
import { Perf } from './core/Perf.js';
import { Renderer3D } from './render/Renderer.js';
import { CameraController, CAMERA_MODES } from './render/CameraController.js';
import { RaceManager, PHYS_DT } from './race/RaceManager.js';
import { Championship } from './race/Championship.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';
import { TouchControls } from './ui/TouchControls.js';
import { COMPOUNDS } from './physics/TireModel.js';
import { CarVisual } from './render/CarModel.js';
import { CIRCUITS } from './track/circuits/index.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class Game {
  constructor(root) {
    this.root = root;
    this.settings = new Settings();
    this.perf = new Perf(this.settings);
    this.input = new Input(this.settings);
    this.input.attach();
    this.canvas = document.createElement('canvas'); this.canvas.id = 'gl'; this.canvas.tabIndex = 0; root.appendChild(this.canvas);
    this.renderer = new Renderer3D(this.canvas, this.settings, this.perf);
    this.camCtl = new CameraController(this.renderer.camera);
    this.audio = new AudioEngine(this.settings);
    this.hud = new HUD(root, this.settings); this.hud.setScale(this.settings.data.ui.hudScale); this.hud.show(false);
    this.touch = new TouchControls(root, this.input, this.settings);
    this.championship = new Championship();
    this.menu = new Menu(root, this);
    this.state = 'loading';   // loading | menu | playing | paused | replay | results
    this.rm = null; this.cfg = null; this.inChampionship = false;
    this.acc = 0; this.lastNow = 0; this.hudAcc = 0; this.gridTimer = 0; this.finishTimer = -1;
    this.replay = null; this.editing = false;
    this.isTouchDevice = typeof window !== 'undefined' && (('ontouchstart' in window) || navigator.maxTouchPoints > 0) && this.perf.dev.mobile;
    this.hud.onPitCompound = (c) => { if (this.rm && this.rm.player) this.rm.player.nextCompound = c; };
    window.addEventListener('resize', () => this.renderer.applyScale());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'playing') this.pause(); });
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    this.loop = this.loop.bind(this);
    this.timing = { phys: 0, render: 0, cpu: 0 };
    this.blueFlag = false; this.blueT = 0;
  }

  start() {
    this.state = 'menu';
    this.menu.showMain();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- scenes
  enterMenuScene(team) {
    this.state = 'menu'; this.hud.show(false); this.touch.show(false);
    this.audio.setPaused(false);
    const t = team ?? this.settings.data.game.team;
    if (!this.renderer.showroom) this.renderer.enterShowroom(t); else this.renderer.setShowroomTeam(t);
  }
  previewTeam(i) { this.renderer.setShowroomTeam(i); }

  async startSession(cfg) {
    const done = this.menu.loading('Building circuit & field…');
    await nextFrame(); await nextFrame();
    try {
      this.cfg = JSON.parse(JSON.stringify(cfg));
      this.buildSession(this.cfg);
    } finally { done(); }
  }
  buildSession(cfg) {
    const mode = cfg.mode;
    const assists = { ...cfg.assists };
    if (!(mode === 'practice' || mode === 'timetrial')) assists.abs = 0;   // no ABS in races/qualifying
    const bench = !!cfg.bench;
    const rm = new RaceManager({
      trackId: cfg.trackId, mode, laps: cfg.laps, aiCount: mode === 'timetrial' ? 0 : cfg.aiCount, difficulty: cfg.difficulty,
      weather: cfg.weather, seed: cfg.seed ?? ((Date.now() % 100000) + 1), playerTeam: cfg.team, playerCompound: cfg.compound,
      wearMult: cfg.wear, assists, setup: { ...cfg.setup }, formationLap: !!cfg.formationLap, safetyCar: cfg.safetyCar,
      qualiMinutes: cfg.qualiMinutes, practiceMinutes: cfg.practiceMinutes, startGrid: cfg.startGrid || null, penalties: cfg.penalties !== false,
      damage: cfg.damage !== false, autopilotPlayer: bench, flagsOn: true,
    });
    rm.collision.damageEnabled = cfg.damage !== false;
    this.rm = rm;
    this.renderer.exitShowroom();
    this.renderer.setTrack(rm.track, rm.profile);
    this.renderer.setCars(rm);
    this.hud.buildMap(rm.track); this.hud.show(true);
    this.camCtl = new CameraController(this.renderer.camera);
    this.camCtl.setMode(cfg.camera || 'chase'); this.camCtl.blend = 1;
    this.menu.hide();
    this.touch.show(this.isTouchDevice || this.input.touch.active);
    this.state = 'playing'; this.acc = 0; this.gridTimer = 0; this.finishTimer = -1; this.replay = null;
    this.renderer.focus = rm.player ? rm.player.car : rm.cars[0];
    this.renderer.setWeather(rm.weather, 0);
    this.input.clearEdges();
    if (rm.cfg.mode === 'race') this.hud.showBig('');
    this.lastResultsShown = false;
    if (cfg.camera === 'cockpit' || cfg.camera === 'nose') this.camCtl.initialised = true;
  }
  restart() { if (this.cfg) { this.cfg.startGrid = null; this.startSession(this.cfg); } }
  quit() {
    this.rm = null; this.renderer.clearRace(); this.hud.show(false); this.touch.show(false);
    this.state = 'menu'; this.inChampionship = false; this.menu.draft = null;
    this.menu.showMain();
  }
  startRaceFromQuali(rows) {
    const cfg = { ...this.cfg, mode: 'race', startGrid: rows.map((r) => r.driver.idx) };
    this.startSession(cfg);
  }
  startChampionshipRound() {
    const st = this.championship.state;
    const g = this.settings.data.game;
    this.inChampionship = true;
    this.startSession({ ...g, mode: 'race', trackId: st.calendar[st.round], laps: st.laps, difficulty: st.difficulty, team: st.team, aiCount: st.aiCount, weather: st.weather, assists: this.settings.data.assists, setup: this.settings.data.setup });
  }
  finishChampionshipRound(rows) {
    this.championship.record(rows);
    this.rm = null; this.renderer.clearRace(); this.hud.show(false); this.state = 'menu';
    this.inChampionship = false; this.enterMenuScene(); this.menu.showChampionship();
  }
  pause() { if (this.state !== 'playing') return; this.state = 'paused'; this.audio.setPaused(true); this.menu.showPause(); }
  resume() { if (this.state !== 'paused') return; this.menu.hide(); this.state = 'playing'; this.audio.setPaused(false); this.lastNow = performance.now(); }
  editTouchLayout() {
    this.editing = true; this.touch.show(true); this.touch.setEditing(true);
    const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = 'Done'; b.style.cssText = 'position:absolute;left:50%;top:6%;transform:translateX(-50%);z-index:60;pointer-events:auto';
    b.onclick = () => { b.remove(); this.touch.setEditing(false); this.touch.show(this.state === 'playing'); this.editing = false; this.menu.showSettings('touch'); };
    this.root.appendChild(b);
  }

  // ---------------------------------------------------------------- replay
  startReplay() {
    const rm = this.rm; if (!rm || !rm.replay || rm.replay.count < 20) { this.menu.toast('Not enough replay data yet'); return; }
    const r = rm.replay, n = r.n, S = r.stride, stride = n * S + 1;
    const frames = [];
    for (let k = 0; k < r.count; k++) frames.push(((r.head - r.count + k) % r.frames + r.frames) % r.frames);
    const proxies = rm.cars.map((c) => {
      const p = Object.create(c);
      p.prev = new Float64Array(12); p.wheelAngle = new Float64Array(4); p.skid = new Float32Array(4); p.surf = new Uint8Array(4); p.sparks = 0; p.kerbShake = 0;
      p.x = c.x; p.y = c.y; p.z = c.z; p.psi = c.psi; p.h = 0; p.th = 0; p.ph = 0; p.steer = 0; p.vx = 0; p.vz = 0; p.speed = 0; p.removed = false;
      return p;
    });
    this.replay = { frames, stride, S, n, t: 0, dur: (frames.length - 1) / 30, speed: 1, playing: true, proxies, focus: rm.player ? rm.player.idx : 0, rm: Object.create(rm) };
    this.replay.rm.cars = proxies;
    this.replay.rm.sc = null; this.replay.rm.phase = 'racing';
    this.state = 'replay'; this.menu.hide(); this.hud.show(false); this.touch.show(false);
    this.buildReplayBar();
    this.renderer.focus = proxies[this.replay.focus];
  }
  buildReplayBar() {
    const bar = document.createElement('div'); bar.className = 'replaybar'; this.replayBar = bar;
    const mk = (txt, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = txt; b.onclick = fn; bar.appendChild(b); return b; };
    const play = mk('⏸', () => { this.replay.playing = !this.replay.playing; play.textContent = this.replay.playing ? '⏸' : '▶'; });
    mk('¼×', () => { this.replay.speed = 0.25; }); mk('1×', () => { this.replay.speed = 1; }); mk('2×', () => { this.replay.speed = 2; });
    const sc = document.createElement('input'); sc.type = 'range'; sc.min = 0; sc.max = 1000; sc.value = 0; bar.appendChild(sc); this.replayScrub = sc;
    sc.oninput = () => { this.replay.t = (sc.value / 1000) * this.replay.dur; };
    mk('Car ▶', () => { const R = this.replay; R.focus = (R.focus + 1) % R.n; this.renderer.focus = R.proxies[R.focus]; });
    mk('Cam', () => { this.replay.tv = !this.replay.tv; });
    mk('Exit', () => this.exitReplay());
    this.root.appendChild(bar);
  }
  exitReplay() {
    if (this.replayBar) { this.replayBar.remove(); this.replayBar = null; }
    this.replay = null;
    const rm = this.rm;
    this.renderer.focus = rm.player ? rm.player.car : rm.cars[0];
    if (rm.phase === 'finished' && rm.classification) { this.state = 'results'; this.menu.showResults(rm.classification, rm); }
    else { this.state = 'playing'; this.hud.show(true); this.touch.show(this.isTouchDevice); }
  }
  stepReplay(dt) {
    const R = this.replay, rm = this.rm, d = rm.replay.data;
    if (R.playing) { R.t += dt * R.speed; if (R.t >= R.dur) { R.t = R.dur; R.playing = false; } }
    const fi = Math.min(R.frames.length - 2, Math.floor(R.t * 30)), a = Math.min(1, R.t * 30 - fi);
    const b0 = R.frames[fi] * R.stride, b1 = R.frames[fi + 1] * R.stride;
    const lerp = (x, y) => x + (y - x) * a;
    for (let i = 0; i < R.n; i++) {
      const p = R.proxies[i], o0 = b0 + 1 + i * R.S, o1 = b1 + 1 + i * R.S;
      p.removed = d[o0 + 12] > 0.5;
      p.x = lerp(d[o0], d[o1]); p.y = lerp(d[o0 + 1], d[o1 + 1]); p.z = lerp(d[o0 + 2], d[o1 + 2]);
      let da = d[o1 + 3] - d[o0 + 3]; if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      p.psi = d[o0 + 3] + da * a; p.h = lerp(d[o0 + 4], d[o1 + 4]); p.th = lerp(d[o0 + 5], d[o1 + 5]); p.ph = lerp(d[o0 + 6], d[o1 + 6]); p.steer = lerp(d[o0 + 7], d[o1 + 7]);
      for (let w = 0; w < 4; w++) p.wheelAngle[w] = lerp(d[o0 + 8 + w], d[o1 + 8 + w]);
      p.speed = lerp(d[o0 + 13], d[o1 + 13]); p.vx = Math.sin(p.psi) * p.speed; p.vz = Math.cos(p.psi) * p.speed;
      const pv = p.prev; pv[0] = p.x; pv[1] = p.z; pv[2] = p.y; pv[3] = p.psi; pv[4] = p.h; pv[5] = p.th; pv[6] = p.ph; pv[7] = p.steer; for (let w = 0; w < 4; w++) pv[8 + w] = p.wheelAngle[w];
    }
    if (this.replayScrub) this.replayScrub.value = Math.round((R.t / R.dur) * 1000);
    const focus = R.proxies[R.focus];
    // keep track-relative info for camera/effects
    this.rm.track.locate(focus.loc === Object.getPrototypeOf(focus).loc ? (R.loc = R.loc || new focus.loc.constructor()) : focus.loc, focus.x, focus.z, 40);
    if (R.loc) focus.loc = R.loc;
    return focus;
  }

  /** dev/CI helper: advance the simulation without rendering (used by headless screenshot tests) */
  fastForward(seconds) {
    const rm = this.rm; if (!rm) return;
    if (rm.phase === 'grid') rm.begin();
    const n = Math.round(seconds / PHYS_DT);
    for (let i = 0; i < n; i++) { rm.step(PHYS_DT); if ((i & 255) === 0) rm.events.length = 0; }
    rm.events.length = 0;
  }

  // ---------------------------------------------------------------- main loop
  loop(now) {
    requestAnimationFrame(this.loop);
    if (!this.perf.shouldRender(now)) return;
    const t0 = performance.now();
    let dt = (now - (this.lastNow || now)) / 1000; this.lastNow = now;
    dt = Math.min(Math.max(dt, 0.0005), 0.1);
    try {
      switch (this.state) {
        case 'menu': this.frameMenu(dt); break;
        case 'playing': this.framePlaying(dt, t0); break;
        case 'paused': case 'results': this.frameFrozen(dt); break;
        case 'replay': this.frameReplay(dt); break;
        default: break;
      }
    } catch (e) { console.error(e); this.fatal = e; }
    const cpu = performance.now() - t0;
    this.perf.endFrame(dt * 1000, cpu, this.timing.phys, this.timing.render);
    if (this.rm) this.rm.physLod = this.perf.level >= 3;   // emergency CPU relief only (thermal critical)
  }
  frameMenu(dt) { this.renderer.updateShowroom(dt); const r0 = performance.now(); this.renderer.render(); this.timing.render = performance.now() - r0; this.timing.phys = 0; }
  frameFrozen(dt) {
    const rm = this.rm; if (!rm) { this.frameMenu(dt); return; }
    const p = rm.player; const vis = this.renderer.visuals[p ? p.idx : 0];
    this.renderer.sync(rm, 1, 0.0001, this.camCtl);
    this.camCtl.update(0.0001, this.renderer.focus, vis, rm.track);
    this.renderer.render();
  }
  frameReplay(dt) {
    const R = this.replay; if (!R) return;
    const focus = this.stepReplay(dt);
    const vis = this.renderer.visuals[R.focus];
    this.renderer.setWeather(this.rm.weather, dt);
    this.renderer.sync(R.rm, 1, dt, this.camCtl);
    vis.root.updateMatrixWorld(true);
    this.camCtl.update(dt, focus, vis, this.rm.track, { tv: R.tv !== false });
    const r0 = performance.now(); this.renderer.render(); this.timing.render = performance.now() - r0;
    if (this.input.consume('replay') || this.input.consume('pause')) this.exitReplay();
  }

  applyPlayerInput(dt) {
    const rm = this.rm, p = rm.player; if (!p || p.ai) return;
    const inp = this.input, car = p.car, c = car.ctrl;
    const st = inp.update(dt, car.speed);
    const canDrive = rm.phase !== 'finished';
    c.throttle = canDrive ? st.throttle : 0; c.brake = canDrive ? st.brake : 0.4; c.steer = canDrive ? st.steer : 0; c.drs = st.drs;
    // discrete actions
    if (inp.consume('shiftUp') && !car.assists.autoGear) c.up = true;
    if (inp.consume('shiftDown') && !car.assists.autoGear) c.down = true;
    if (inp.consume('gearMode')) { car.assists.autoGear = !car.assists.autoGear; car.pt.auto = car.assists.autoGear; this.settings.data.assists.autoGear = car.assists.autoGear; this.menu.toast(car.assists.autoGear ? 'Automatic gearbox' : 'Manual gearbox', 1400); }
    if (inp.consume('camera')) { const m = this.camCtl.cycle(); this.settings.data.game.camera = m; this.settings.save(); }
    if (inp.consume('lookBack')) this.camCtl.lookBack = !this.camCtl.lookBack;
    if (inp.consume('pit')) { if (p.wantPit) { p.wantPit = false; this.rm.pushMessage('Pit request cancelled', 'info', 2); } else { const cur = car.compound.id; const w = rm.env.water; const next = w > 0.45 ? 'wet' : w > 0.12 ? 'inter' : cur === 'soft' ? 'medium' : cur === 'medium' ? 'hard' : 'soft'; rm.requestPit(p, next); } }
    if (inp.consume('ers')) { car.pt.ersMode = (car.pt.ersMode + 1) % 3; }
    if (inp.consume('biasUp')) { car.setup.brakeBias = Math.min(0.66, car.setup.brakeBias + 0.005); car.applySetup(); }
    if (inp.consume('biasDown')) { car.setup.brakeBias = Math.max(0.5, car.setup.brakeBias - 0.005); car.applySetup(); }
    if (inp.consume('diffUp')) car.setup.diffPreload = Math.min(400, car.setup.diffPreload + 10);
    if (inp.consume('diffDown')) car.setup.diffPreload = Math.max(0, car.setup.diffPreload - 10);
    if (inp.consume('limiter')) c.limiterToggle = !c.limiterToggle;
    if (inp.consume('map')) { this.settings.data.ui.minimap = !this.settings.data.ui.minimap; this.hud.mapCanvas.style.display = this.settings.data.ui.minimap ? '' : 'none'; }
    if (inp.consume('fps')) { this.settings.data.ui.fps = !this.settings.data.ui.fps; }
    if (inp.consume('replay')) this.startReplay();
    if (inp.consume('reset')) {
      if (rm.cfg.mode === 'race') { if (car.speed < 4 || car.retired === false) { if (rm.recoverCar(p)) rm.addPenalty(p, 5, 'Car reset'); } }
      else rm.recoverCar(p);
    }
    if (inp.consume('pause')) this.pause();
  }

  framePlaying(dt, t0) {
    const rm = this.rm;
    if (this.editing) { this.frameFrozen(dt); return; }
    this.applyPlayerInput(dt);
    // auto-begin the start procedure shortly after loading
    if (rm.phase === 'grid') { this.gridTimer += dt; if (this.gridTimer > 2.5) rm.begin(); }
    // ---- fixed-step physics with a bounded catch-up (never spiral)
    this.acc += dt;
    const ps = performance.now();
    let steps = 0; const maxSteps = this.perf.level >= 2 ? 4 : 6;
    while (this.acc >= PHYS_DT && steps < maxSteps) { rm.step(PHYS_DT); this.acc -= PHYS_DT; steps++; }
    if (steps === maxSteps) this.acc = Math.min(this.acc, PHYS_DT);
    this.timing.phys = performance.now() - ps;
    this.handleEvents(rm, dt);
    const alpha = this.acc / PHYS_DT;
    // ---- visuals
    const player = rm.player, car = this.renderer.focus;
    const vis = this.renderer.visuals[car.id];
    this.renderer.setWeather(rm.weather, dt);
    this.renderer.sync(rm, alpha, dt, this.camCtl);
    vis.root.updateMatrixWorld(true);
    this.camCtl.update(dt, car, vis, rm.track);
    this.renderer.sync && 0;
    const r0 = performance.now();
    this.renderer.render();
    this.timing.render = performance.now() - r0;
    // ---- HUD / audio
    if (player) {
      this.blueT += dt;
      if (this.blueT > 0.4) { this.blueT = 0; this.blueFlag = this.computeBlue(rm, player); }
      this.hud.update(rm, dt, this.input, this.perf, { blueFlag: this.blueFlag, fps: this.settings.data.ui.fps });
    }
    this.audio.update(dt, rm, this.renderer.camera, car);
    // ---- end of session
    if (rm.phase === 'finished' && rm.classification && !this.lastResultsShown) {
      this.finishTimer = this.finishTimer < 0 ? 2.5 : this.finishTimer;
    }
    if (this.finishTimer >= 0) {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0 && !this.lastResultsShown) { this.lastResultsShown = true; this.finishTimer = -1; this.showResults(); }
    }
    // the player finished while others still run: wrap up after a short cool-down
    if (player && player.finished && rm.phase !== 'finished' && !this.finishWatch) this.finishWatch = rm.simTime;
    if (this.finishWatch && rm.simTime - this.finishWatch > 8 && rm.phase !== 'finished') { this.finishWatch = 0; rm.finishSession(); }
  }

  computeBlue(rm, p) {
    if (rm.cfg.mode !== 'race') return false;
    const L = rm.track.length;
    for (const d of rm.drivers) {
      if (d === p || d.status !== 'running') continue;
      if (d.progress > p.progress + L * 0.92) { const g = rm.track.delta(d.car.loc.s, p.car.loc.s); if (g > 0 && g < 160) return true; }
    }
    return false;
  }

  handleEvents(rm, dt) {
    const ev = rm.events; if (!ev.length) return;
    const cam = this.renderer.camera.position;
    const focus = this.renderer.focus;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      switch (e.type) {
        case 'impact': {
          this.renderer.onEvent(e, rm);
          const involvesPlayer = e.a === focus || e.b === focus;
          const dist = Math.hypot(e.x - cam.x, e.z - cam.z);
          this.audio.event(e, dist);
          if (involvesPlayer) { this.camCtl.addShake(Math.min(1, e.speed / 14)); this.input.rumble(Math.min(1, e.speed / 12), 0.6, 160); }
          break; }
        case 'partLost': this.renderer.onEvent(e, rm); this.audio.event(e, Math.hypot(e.x - cam.x, e.z - cam.z)); break;
        case 'bestLap': this.audio.event(e); if (e.driver.isPlayer && rm.cfg.mode !== 'race') { if (this.settings.recordLap(rm.cfg.trackId, e.time)) this.menu.toast('New personal best saved!', 2000); } break;
        case 'sessionEnd': break;
        default: this.audio.event(e); break;
      }
      if (e.type === 'chequered' && rm.cfg.mode === 'practice') this.finishTimer = 1.5;
    }
    ev.length = 0;
    // continuous haptics: kerbs / lock-ups for the player
    const c = focus;
    if (c && this.input.gamepad) {
      const lock = Math.max(-c.kappa[0], -c.kappa[1]);
      if (lock > 0.35 && c.speed > 10) this.input.rumble(0.0, 0.5, 60);
      else if (c.kerbShake > 0.01) this.input.rumble(0.2, 0.3, 50);
    }
  }

  showResults() {
    const rm = this.rm;
    if (!rm.classification) rm.classification = rm.buildClassification();
    this.state = 'results'; this.hud.show(false); this.touch.show(false);
    // best lap persistence for the player
    const p = rm.player; if (p && isFinite(p.best) && rm.cfg.mode === 'race') this.settings.recordLap(rm.cfg.trackId + ':race', p.best);
    this.menu.showResults(rm.classification, rm);
  }
}
