// AudioEngine: engines are REAL F1 recordings (EngineBank: rpm-pitched, cross-faded loop layers, see public/audio/CREDITS.txt);
// tyre / brake / wind / rain / impact / UI sounds are synthesised (Web Audio). If the recordings cannot be loaded, the
// original additive synth is used for engines (player: 4 oscillators; nearby AI cars: 2-oscillator voices with Doppler + pan).
import { clamp } from '../core/math.js';
import { loadEngineBank, EngineVoice } from './EngineBank.js';

// which recording each (fictional) team's car uses when 'Engine sound' = automatic; ids from public/audio/manifest.json
const TEAM_ENGINES = ['v8a', 'v10a', 'v8c', 'v10b', 'v8b', 'v8d', 'v10a', 'v8a', 'v8c', 'v10b'];

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null; this.ready = false; this.paused = false;
    this.nearVoices = [];
    this.lastThr = 0; this.lastGear = 1; this.t = 0;
    this.bank = null; this.bankState = 'idle';   // idle | loading | ready | failed
    this.pVoice = null; this.pEngId = null; this.aiVoices = new Map();
  }
  /** loads the recordings once (asynchronously; procedural engines play until they are decoded) */
  loadBank() {
    if (this.bankState !== 'idle' || !this.ctx) return;
    this.bankState = 'loading';
    const base = (typeof document !== 'undefined' && document.baseURI ? new URL('audio/', document.baseURI).href : 'audio/');
    loadEngineBank(this.ctx, base).then((b) => { this.bank = b; this.bankState = b ? 'ready' : 'failed'; }).catch(() => { this.bankState = 'failed'; });
  }
  /** engine ids that are available (for the settings menu) */
  engineChoices() { return this.bank ? [...this.bank.engines.values()].map((e) => [e.id, e.label]) : []; }
  engineFor(car) {
    if (!this.bank) return null;
    const pick = this.settings.data.audio.engineSound;
    const want = car.d && car.d.isPlayer && pick && pick !== 'auto' ? pick : TEAM_ENGINES[(car.d && car.d.def ? car.d.def.team : car.idx || 0) % TEAM_ENGINES.length];
    return this.bank.engines.get(want) || this.bank.engines.values().next().value;
  }
  /** must be called from a user gesture on mobile/iOS */
  unlock() {
    if (this.ready) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS 16.4+: play even with the silent switch on */ }
    try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { return; }
    this.build();
    this.applyVolumes();
    this.ready = true;
    this.loadBank();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  setPaused(p) { this.paused = p; if (!this.ready) return; if (p) this.ctx.suspend(); else this.ctx.resume(); }

  noiseBuffer(sec = 2) {
    const ctx = this.ctx, n = ctx.sampleRate * sec, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.6 + last * 6; }
    return b;
  }
  loopNoise(type, freq, q = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); src.start();
    return { src, f, g };
  }
  build() {
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.settings.data.audio.master;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.engineBus = ctx.createGain(); this.engineBus.connect(this.master);
    this.fxBus = ctx.createGain(); this.fxBus.connect(this.master);
    this.noiseBuf = this.noiseBuffer(3);
    // ---- player engine (synthesised fallback): two cylinder banks (PeriodicWave pulse trains, slightly detuned -> beating),
    // a rev-frequency sub-harmonic, fixed exhaust resonances (the 'scream'), combustion noise, MGU-K whine, turbo whistle
    const mk = (type, gain) => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = gain; o.connect(g); return { o, g }; };
    const H = 48, re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    for (let h = 1; h <= H; h++) { const duty = 0.16; im[h] = Math.sin(Math.PI * h * duty) / h * (1 + 0.5 * Math.cos(h * 0.9)); }   // narrow pulse -> rich, slightly uneven harmonics
    const wave = ctx.createPeriodicWave(re, im);
    const mkw = (gain) => { const o = ctx.createOscillator(); o.setPeriodicWave(wave); const g = ctx.createGain(); g.gain.value = gain; o.connect(g); return { o, g }; };
    this.eo = [mkw(0.55), mkw(0.45), mk('sine', 0.35), mk('triangle', 0.18)];   // bankA, bankB (detuned), rev-order sub, half-order rumble
    this.eFilter = ctx.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.Q.value = 1.4;
    this.eShaper = ctx.createWaveShaper();
    const curve = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 1.8); } this.eShaper.curve = curve;
    this.eGain = ctx.createGain(); this.eGain.gain.value = 0;
    this.eAM = ctx.createGain(); this.eAM.gain.value = 1;
    for (const e of this.eo) { e.g.connect(this.eShaper); e.o.start(); }
    this.eShaper.connect(this.eFilter);
    // parallel exhaust resonances (fixed formants) added on top of the low-passed core
    this.eRes = [[620, 3, 0.5], [1450, 4, 0.55], [3100, 5, 0.4]].map(([fr, q, gn]) => { const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = fr; f.Q.value = q; const g = ctx.createGain(); g.gain.value = gn; this.eShaper.connect(f); f.connect(g); g.connect(this.eAM); return { f, g }; });
    this.eFilter.connect(this.eAM); this.eAM.connect(this.eGain); this.eGain.connect(this.engineBus);
    this.lfo = ctx.createOscillator(); this.lfo.type = 'square'; this.lfo.frequency.value = 24; this.lfoG = ctx.createGain(); this.lfoG.gain.value = 0; this.lfo.connect(this.lfoG); this.lfoG.connect(this.eAM.gain); this.lfo.start();
    // combustion / intake roar: noise band-passed around 2x firing frequency
    this.eNoise = this.loopNoise('bandpass', 1500, 1.2); this.eNoise.g.connect(this.engineBus);
    // MGU-K / gearbox whine and turbo whistle
    this.whine = mk('sine', 0.0); this.whine.o.start(); this.whine.g.connect(this.engineBus);
    this.turbo = mk('sine', 0.0); this.turbo.o.start(); this.turbo.g.connect(this.engineBus);
    // ---- continuous layers
    this.wind = this.loopNoise('lowpass', 400); this.wind.g.connect(this.fxBus);
    this.squeal = this.loopNoise('bandpass', 1700, 6); this.squeal.g.connect(this.fxBus);
    this.gravel = this.loopNoise('lowpass', 900, 0.7); this.gravel.g.connect(this.fxBus);
    this.brakeHiss = this.loopNoise('highpass', 3500); this.brakeHiss.g.connect(this.fxBus);
    this.rainN = this.loopNoise('bandpass', 4200, 0.5); this.rainN.g.connect(this.fxBus);
    this.kerb = mk('sawtooth', 0); this.kerbF = ctx.createBiquadFilter(); this.kerbF.type = 'lowpass'; this.kerbF.frequency.value = 160; this.kerb.g.connect(this.kerbF); this.kerbF.connect(this.fxBus); this.kerb.o.frequency.value = 30; this.kerb.o.start();
    // ---- opponent voices
    for (let i = 0; i < 4; i++) {
      const a = ctx.createOscillator(); a.type = 'sawtooth'; const b = ctx.createOscillator(); b.type = 'square';
      const ga = ctx.createGain(), gb = ctx.createGain(); ga.gain.value = 0.6; gb.gain.value = 0.25;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2000;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const g = ctx.createGain(); g.gain.value = 0;
      a.connect(ga); b.connect(gb); ga.connect(f); gb.connect(f); f.connect(g); if (pan) { g.connect(pan); pan.connect(this.engineBus); } else g.connect(this.engineBus);
      a.start(); b.start();
      this.nearVoices.push({ a, b, f, g, pan, car: null });
    }
  }
  applyVolumes() {
    if (!this.ready) return;
    const a = this.settings.data.audio;
    this.master.gain.value = a.master; this.engineBus.gain.value = a.engine; this.fxBus.gain.value = a.effects;
  }

  /** one-shot helpers */
  tone(freq, dur, type = 'sine', gain = 0.2, glide = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t); if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.fxBus); o.start(t); o.stop(t + dur + 0.02);
  }
  burst(dur, freq, gain, type = 'lowpass') {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.15), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.fxBus); s.start(t, Math.random() * 1.5, dur + 0.05);
  }
  event(e, dist = 0) {
    if (!this.ready) return;
    const near = 1 / (1 + dist / 40);
    switch (e.type) {
      case 'impact': {
        const v = clamp(e.speed / 22, 0.05, 1) * near;
        this.burst(0.35, 2200, 0.5 * v); this.tone(70, 0.25, 'sine', 0.6 * v, 0.4);
        if (e.energy > 15000) this.tone(1400 + Math.random() * 500, 0.35, 'triangle', 0.12 * v, 0.7);
        break; }
      case 'partLost': this.tone(900, 0.5, 'triangle', 0.18 * near, 0.5); this.burst(0.2, 4000, 0.3 * near, 'highpass'); break;
      case 'light': this.tone(660, 0.18, 'sine', 0.22); break;
      case 'lightsOut': this.tone(990, 0.35, 'sine', 0.3); break;
      case 'lap': if (e.driver && e.driver.isPlayer) this.tone(880, 0.12, 'sine', 0.12); break;
      case 'bestLap': if (e.driver && e.driver.isPlayer) { this.tone(1046, 0.12, 'sine', 0.2); setTimeout(() => this.tone(1318, 0.2, 'sine', 0.2), 120); } break;
      case 'penalty': if (e.driver && e.driver.isPlayer) { this.tone(180, 0.35, 'sawtooth', 0.18); } break;
      case 'message': this.tone(1800, 0.05, 'square', 0.04); break;
      case 'sc': this.tone(520, 0.4, 'triangle', 0.15); break;
      case 'pitService': if (e.driver && e.driver.isPlayer) { for (let i = 0; i < 4; i++) setTimeout(() => this.burst(0.08, 5000, 0.35, 'highpass'), i * 180); } break;
      case 'chequered': this.tone(1200, 0.5, 'sine', 0.2); break;
      default: break;
    }
  }
  gearClick() { this.burst(0.05, 1800, 0.25, 'bandpass'); }

  /** per frame. cam = THREE.Camera (for pan/doppler) */
  update(dt, rm, cam, focusCar) {
    if (!this.ready || this.paused || !focusCar) return;
    this.t += dt;
    if (this.ctx.state !== 'running' && (this.resumeT = (this.resumeT || 0) - dt) <= 0) { this.resumeT = 1; try { this.ctx.resume(); } catch (e) { /* needs a user gesture; the next one retries */ } }   // 'suspended' / iOS 'interrupted' after a call or app switch
    const ctx = this.ctx, now = ctx.currentTime, car = focusCar;
    const S = (p, v, tc = 0.03) => p.setTargetAtTime(v, now, tc);
    const rpm = car.pt.rpm, thr = car.pt.throttleApplied, sp = car.speed;
    const running = rm.phase !== 'init' && !car.retired && car.pt.fuel > 0;
    if (this.bank) {
      // ---- recorded engine (player). 0.12 loop rms * 1.7 ~ comfortably under the master limiter
      const eng = this.engineFor(car);
      if (!this.pVoice || this.pEngId !== eng.id) {
        if (this.pVoice) this.pVoice.dispose();
        this.pVoice = new EngineVoice(ctx, this.engineBus, eng, { limiterLfo: true }); this.pEngId = eng.id;
      }
      this.pVoice.set(rpm, running ? thr : 0, running ? 1.7 : 0, now, { limiter: !!car.pt.limiter, shifting: car.pt.shiftTimer > 0 });
      S(this.eGain.gain, 0, 0.03); S(this.turbo.g.gain, 0, 0.1); S(this.whine.g.gain, 0, 0.1); S(this.eNoise.g.gain, 0, 0.05);
    } else {
      const f = Math.max(30, rpm / 60 * 3);                         // V6 firing frequency
      S(this.eo[0].o.frequency, f, 0.02); S(this.eo[1].o.frequency, f * 1.006, 0.02);   // two banks, 0.6 % apart -> slow beating
      S(this.eo[2].o.frequency, f / 3, 0.02); S(this.eo[3].o.frequency, f / 6, 0.02);
      const load = 0.25 + 0.75 * thr, rr = clamp(rpm / 15000, 0, 1.05);
      S(this.eFilter.frequency, 450 + load * 3200 + rr * 3800, 0.04);
      for (const r of this.eRes) S(r.g.gain, running ? (0.12 + 0.5 * load) * (0.35 + 0.65 * rr) : 0, 0.05);
      let g = running ? (0.10 + 0.30 * load) * (0.45 + 0.55 * Math.min(1.2, rpm / 9000)) : 0;
      if (car.pt.shiftTimer > 0) g *= 0.5;
      S(this.eGain.gain, g, 0.03);
      S(this.eNoise.f.frequency, Math.max(300, f * 2), 0.05); S(this.eNoise.g.gain, running ? (0.015 + 0.075 * load * load) * (0.3 + 0.7 * rr) : 0, 0.05);
      // rev limiter chop
      S(this.lfoG.gain, car.pt.limiter ? 0.5 : 0, 0.01);
      S(this.eAM.gain, car.pt.limiter ? 0.5 : 1, 0.01);
      // MGU-K whine rises with speed, turbo whistle with throttle
      S(this.whine.o.frequency, 1400 + rpm * 0.22, 0.05); S(this.whine.g.gain, running ? 0.004 + 0.012 * thr * rr : 0, 0.1);
      S(this.turbo.o.frequency, 2600 + thr * 5500 * clamp(rpm / 13000, 0, 1), 0.08); S(this.turbo.g.gain, running ? 0.006 + 0.016 * thr : 0, 0.1);
    }
    // lift-off crackle + shifts
    if (this.lastThr > 0.8 && thr < 0.15 && rpm > 9000 && !this.bank) { for (let i = 0; i < 3; i++) setTimeout(() => this.burst(0.05 + Math.random() * 0.05, 2400, 0.22), i * 60 + Math.random() * 40); }
    if (car.pt.gear !== this.lastGear) { this.gearClick(); this.lastGear = car.pt.gear; }
    this.lastThr = thr;
    // wind, tyres, brakes, kerb, rain
    S(this.wind.g.gain, clamp(sp / 95, 0, 1) ** 2 * 0.5, 0.1); S(this.wind.f.frequency, 250 + sp * 9, 0.1);
    let skid = 0, gravelAmt = 0;
    for (let i = 0; i < 4; i++) { skid = Math.max(skid, car.skid[i] * (car.surf[i] <= 2 ? 1 : 0)); if (car.surf[i] === 3 || car.surf[i] === 4 || car.surf[i] === 6) gravelAmt = Math.max(gravelAmt, 1); }
    S(this.squeal.g.gain, clamp(skid, 0, 1.2) * 0.35 * (sp > 3 ? 1 : 0), 0.04); S(this.squeal.f.frequency, 1300 + sp * 8 + skid * 500, 0.05);
    S(this.gravel.g.gain, gravelAmt * clamp(sp / 40, 0, 1) * 0.5, 0.08);
    S(this.brakeHiss.g.gain, clamp(car.brakes.pedal, 0, 1) * clamp(sp / 80, 0, 1) * 0.12, 0.05);
    S(this.kerb.g.gain, clamp(car.kerbShake * 60, 0, 1) * clamp(sp / 50, 0, 1) * 0.4, 0.03); S(this.kerb.o.frequency, 18 + sp * 0.35, 0.05);
    S(this.rainN.g.gain, rm.weather.rain * 0.16, 0.3);
    // ---- opponent voices: nearest cars to the camera
    this.updateVoices(rm, cam, car, now);
  }
  updateVoices(rm, cam, focus, now) {
    if (this.bank) return this.updateBankVoices(rm, cam, focus, now);
    const cp = cam.position;
    // right vector of the camera in the xz plane
    const e = cam.matrixWorld.elements; // column 0 = right, column 2 = back
    const rx = e[0], rz = e[2];
    const cand = [];
    for (const c of rm.cars) {
      if (c === focus || c.removed || c.retired) continue;
      const dx = c.x - cp.x, dz = c.z - cp.z; const d2 = dx * dx + dz * dz;
      if (d2 < 260 * 260) cand.push([d2, c]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < this.nearVoices.length; i++) {
      const v = this.nearVoices[i], it = cand[i];
      if (!it) { v.g.gain.setTargetAtTime(0, now, 0.05); continue; }
      const c = it[1], d = Math.sqrt(it[0]);
      const dx = c.x - cp.x, dz = c.z - cp.z;
      // radial velocity relative to the focus car -> doppler
      const rvx = c.vx - focus.vx, rvz = c.vz - focus.vz;
      const rad = (rvx * dx + rvz * dz) / Math.max(1, d);
      const f = Math.max(40, c.pt.rpm / 60 * 3) * (1 - clamp(rad, -90, 90) / 340);
      v.a.frequency.setTargetAtTime(f, now, 0.04); v.b.frequency.setTargetAtTime(f * 2.01, now, 0.04);
      const vol = (0.05 + 0.1 * c.pt.throttleApplied) * (1 / (1 + d / 28));
      v.g.gain.setTargetAtTime(vol, now, 0.06);
      v.f.frequency.setTargetAtTime(800 + 4000 / (1 + d / 25), now, 0.06);
      if (v.pan) v.pan.pan.setTargetAtTime(clamp((dx * rx + dz * rz) / Math.max(8, d), -1, 1), now, 0.05);
    }
  }
  /** opponents with recordings: the 4 nearest cars to the camera each get a voice with their team's engine (pan + doppler + distance) */
  updateBankVoices(rm, cam, focus, now) {
    const cp = cam.position, e = cam.matrixWorld.elements, rx = e[0], rz = e[2];
    for (const v of this.nearVoices) v.g.gain.setTargetAtTime(0, now, 0.05);   // the procedural voices stay silent
    const cand = [];
    for (const c of rm.cars) {
      if (c === focus || c.removed || c.retired) continue;
      const dx = c.x - cp.x, dz = c.z - cp.z, d2 = dx * dx + dz * dz;
      if (d2 < 260 * 260) cand.push([d2, c]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const want = new Set(cand.slice(0, 4).map((x) => x[1]));
    for (const [car, v] of this.aiVoices) if (!want.has(car)) { v.silence(now); if (!v.dying) v.dying = now + 0.6; else if (now > v.dying) { v.dispose(); this.aiVoices.delete(car); } }
    for (const [d2, c] of cand.slice(0, 4)) {
      let v = this.aiVoices.get(c);
      if (!v) { const eng = this.engineFor(c); if (!eng) continue; v = new EngineVoice(this.ctx, this.engineBus, eng, { pan: true }); this.aiVoices.set(c, v); }
      v.dying = 0;
      const d = Math.sqrt(d2), dx = c.x - cp.x, dz = c.z - cp.z;
      const rad = ((c.vx - focus.vx) * dx + (c.vz - focus.vz) * dz) / Math.max(1, d);
      const doppler = 1 - clamp(rad, -90, 90) / 340;
      v.set(c.pt.rpm * doppler, c.pt.throttleApplied, 1.5 / (1 + d / 24), now, { limiter: false, bright: 1 / (1 + d / 160) });
      if (v.pan) v.pan.pan.setTargetAtTime(clamp((dx * rx + dz * rz) / Math.max(8, d), -1, 1), now, 0.05);
    }
  }
  dispose() {
    if (this.pVoice) this.pVoice.dispose();
    for (const v of this.aiVoices.values()) v.dispose();
    this.aiVoices.clear();
    if (this.ctx) this.ctx.close();
    this.ready = false;
  }
}
