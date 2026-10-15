// Input: keyboard, gamepad and touch merged into one normalised driver-input state.
// Analog feel: progressive keyboard pedals/steering, per-axis linearity curves, dead zones, haptics.
import { clamp } from './math.js';

const lin = (v, g) => Math.sign(v) * Math.pow(Math.abs(v), g);

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.down = new Set();
    this.pressed = new Set();           // edge-triggered action names, consumed by the game
    this.state = { throttle: 0, brake: 0, steer: 0, drs: false, limiterToggle: false };
    this.kbSteer = 0; this.kbThrottle = 0; this.kbBrake = 0;
    // raw state of the on-screen controls (written by TouchControls): digital buttons + an optional analog virtual wheel
    this.touch = { active: false, left: false, right: false, gas: false, brake: false, drs: false, wheel: false, steer: 0 };
    this.latched = { left: false, right: false, gas: false, brake: false };   // a tap shorter than a frame is still felt for one frame
    this.eff = { left: false, right: false, gas: false, brake: false };
    this.gp = { active: false, steer: 0, thr: 0, brk: 0, drs: false };
    this.tiltSteer = null;
    this.gamepad = null; this.gpWas = {};
    this.keyToAction = new Map();
    this.rebuildKeymap();
    this.listening = null;              // action being rebound
    this.onRebind = null;
    this.enabled = true;
    this._kd = (e) => this.onKey(e, true);
    this._ku = (e) => this.onKey(e, false);
    this._blur = () => { this.releaseAll(); };
    this._vis = () => { if (typeof document !== 'undefined' && document.hidden) this.releaseAll(); };
    this.attached = false;
    this.orient = { gamma: 0, beta: 0, ok: false };
    this._orient = (e) => { this.orient.gamma = e.gamma || 0; this.orient.beta = e.beta || 0; this.orient.ok = true; };
  }
  attach() {
    if (this.attached || typeof window === 'undefined') return;
    window.addEventListener('keydown', this._kd); window.addEventListener('keyup', this._ku); window.addEventListener('blur', this._blur);
    window.addEventListener('pagehide', this._blur); document.addEventListener('visibilitychange', this._vis);
    this.attached = true;
  }
  enableTilt() {
    if (typeof window === 'undefined') return;
    const start = () => window.addEventListener('deviceorientation', this._orient);
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') start(); }).catch(() => {});
      else start();
    } catch (e) { /* unsupported */ }
  }
  rebuildKeymap() {
    this.keyToAction.clear();
    const keys = this.settings.data.keys;
    for (const a of Object.keys(keys)) for (const c of keys[a]) this.keyToAction.set(c, a);
  }
  startRebind(action, cb) { this.listening = action; this.onRebind = cb; }
  onKey(e, isDown) {
    if (this.listening && isDown) {
      e.preventDefault();
      const keys = this.settings.data.keys;
      // one key -> one action
      for (const a of Object.keys(keys)) keys[a] = keys[a].filter((c) => c !== e.code);
      keys[this.listening] = [e.code, ...keys[this.listening].slice(0, 1)];
      const cb = this.onRebind; this.listening = null; this.onRebind = null;
      this.rebuildKeymap(); this.settings.save();
      if (cb) cb();
      return;
    }
    const a = this.keyToAction.get(e.code);
    if (!a || !this.enabled) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    e.preventDefault();
    if (isDown) { if (!this.down.has(a + ':' + e.code)) { this.down.add(a + ':' + e.code); this.pressed.add(a); } }
    else this.down.delete(a + ':' + e.code);
  }
  held(a) { for (const k of this.down) if (k.startsWith(a + ':')) return true; return false; }
  consume(a) { const r = this.pressed.has(a); this.pressed.delete(a); return r; }
  clearEdges() { this.pressed.clear(); }

  /**
   * Once per rendered frame: read the things that are polled (gamepad, tilt) and the discrete touch buttons.
   * The shaping below then runs once per FIXED PHYSICS STEP, so ramps, key repeat and release behave identically at 30, 60 or 120 FPS.
   */
  latch(id) { if (id in this.latched) this.latched[id] = true; }
  sample() {
    const c = this.settings.data.controls;
    const t0 = this.touch, L = this.latched, E = this.eff;
    E.left = t0.left || L.left; E.right = t0.right || L.right; E.gas = t0.gas || L.gas; E.brake = t0.brake || L.brake;
    L.left = L.right = L.gas = L.brake = false;
    const gp = this.pollGamepad();
    const g = this.gp;
    g.active = false; g.steer = 0; g.thr = 0; g.brk = 0; g.drs = false;
    if (gp) {
      const dz = c.deadzone;
      let ax = gp.axes[0] || 0;
      if (Math.abs(ax) < dz) ax = 0; else ax = Math.sign(ax) * (Math.abs(ax) - dz) / (1 - dz);
      const gt = gp.buttons[7] ? gp.buttons[7].value : 0, gb = gp.buttons[6] ? gp.buttons[6].value : 0;
      if (Math.abs(ax) > 0.001 || gt > 0.02 || gb > 0.02) { g.active = true; g.steer = -ax; g.thr = gt; g.brk = gb; }
      g.drs = !!(gp.buttons[2] && gp.buttons[2].pressed);
      this.gpEdges(gp);
    }
    // tilt steering (analog by nature)
    this.tiltSteer = null;
    if (c.tilt && this.orient.ok && !this.touch.wheel) {
      const a = (typeof screen !== 'undefined' && screen.orientation && screen.orientation.angle) || 0;
      const gg = a === 90 ? this.orient.beta : a === 270 || a === -90 ? -this.orient.beta : this.orient.gamma;
      this.tiltSteer = clamp(-gg / 35, -1, 1);
    }
  }

  /** Advance the driver inputs by one physics step (dt = fixed step). Keyboard and the touch buttons are digital; see sample(). */
  update(dt, speed = 0) {
    const c = this.settings.data.controls;
    const s = this.state, t = this.touch, g = this.gp;
    // ---- digital sources: keyboard keys and on-screen buttons share one model (press = target, progressive ramp, quick release)
    const E = this.eff;
    const l = this.held('left') || E.left, r = this.held('right') || E.right;
    const tgt = (r ? -1 : 0) + (l ? 1 : 0);           // + = left
    // faster response at low speed, gentler at high speed (keeps digital steering drivable without replacing physics)
    const speedF = 1 / (1 + (speed / 70) * (speed / 70) * 1.2);
    const rate = (Math.abs(tgt) > 0 && Math.sign(tgt) === Math.sign(this.kbSteer || tgt) ? c.keyboardSteerRate : c.keyboardSteerRate * 2.4) * (0.55 + 0.45 * speedF);
    this.kbSteer += clamp(tgt - this.kbSteer, -rate * dt, rate * dt);
    const tt = this.held('throttle') || E.gas ? 1 : 0, bb = this.held('brake') || E.brake ? 1 : 0;
    this.kbThrottle += clamp(tt - this.kbThrottle, -6 * dt, 3.6 * dt);
    this.kbBrake += clamp(bb - this.kbBrake, -9 * dt, 4.2 * dt);
    let steer = this.kbSteer, thr = this.kbThrottle, brk = this.kbBrake;
    let analog = false;
    // ---- analog sources (gamepad sticks / triggers, optional virtual wheel, tilt) override the digital model while they are in use
    if (g.active) { steer = g.steer; analog = true; thr = Math.max(thr, g.thr); brk = Math.max(brk, g.brk); }
    if (t.wheel) { steer = t.steer; analog = true; }
    else if (this.tiltSteer !== null) { steer = this.tiltSteer; analog = true; }
    // ---- shaping
    steer = clamp(steer * c.steerSensitivity, -1, 1);
    steer = lin(steer, c.steerLinearity);
    s.steer = steer;
    s.throttle = clamp(lin(thr, c.throttleLinearity), 0, 1);
    s.brake = clamp(lin(brk, c.brakeLinearity), 0, 1);
    s.drs = this.held('drs') || t.drs || g.drs;
    s.analog = analog;
    return s;
  }
  /** drop every held input (focus loss, pause, menus): no throttle or brake can stay stuck */
  releaseAll() {
    this.down.clear();
    const t = this.touch; t.left = t.right = t.gas = t.brake = t.drs = false; t.wheel = false; t.steer = 0;
    const L = this.latched, E = this.eff; L.left = L.right = L.gas = L.brake = false; E.left = E.right = E.gas = E.brake = false;
    this.kbThrottle = 0; this.kbBrake = 0; this.kbSteer = 0;
    this.state.throttle = 0; this.state.brake = 0; this.state.steer = 0;
  }
  pollGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    this.gamepad = gp;
    return gp;
  }
  gpEdges(gp) {
    const map = { 5: 'shiftUp', 4: 'shiftDown', 3: 'camera', 9: 'pause', 8: 'reset', 12: 'biasUp', 13: 'biasDown', 14: 'ers', 15: 'pit', 1: 'replay', 0: 'limiter', 10: 'lookBack' };
    for (const b in map) {
      const p = !!(gp.buttons[b] && gp.buttons[b].pressed);
      if (p && !this.gpWas[b]) this.pressed.add(map[b]);
      this.gpWas[b] = p;
    }
  }
  rumble(strong, weak, ms = 80) {
    const gp = this.gamepad;
    if (!this.settings.data.controls.haptics) return;
    try {
      if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak });
      else if (this.touch.active && typeof navigator !== 'undefined' && navigator.vibrate && strong > 0.35) navigator.vibrate(Math.min(60, ms));
    } catch (e) { /* ignore */ }
  }
}
