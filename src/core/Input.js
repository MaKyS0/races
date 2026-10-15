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
    this.touch = { active: false, steer: 0, throttle: 0, brake: 0, drs: false };
    this.gamepad = null; this.gpWas = {};
    this.keyToAction = new Map();
    this.rebuildKeymap();
    this.listening = null;              // action being rebound
    this.onRebind = null;
    this.enabled = true;
    this._kd = (e) => this.onKey(e, true);
    this._ku = (e) => this.onKey(e, false);
    this._blur = () => { this.down.clear(); };
    this.attached = false;
    this.orient = { gamma: 0, beta: 0, ok: false };
    this._orient = (e) => { this.orient.gamma = e.gamma || 0; this.orient.beta = e.beta || 0; this.orient.ok = true; };
  }
  attach() {
    if (this.attached || typeof window === 'undefined') return;
    window.addEventListener('keydown', this._kd); window.addEventListener('keyup', this._ku); window.addEventListener('blur', this._blur);
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

  /** call once per rendered frame */
  update(dt, speed = 0) {
    const c = this.settings.data.controls;
    const s = this.state;
    // ---- keyboard
    const l = this.held('left'), r = this.held('right');
    const tgt = (r ? -1 : 0) + (l ? 1 : 0);           // + = left
    // faster response at low speed, gentler at high speed (keeps keyboard drivable without replacing physics)
    const speedF = 1 / (1 + (speed / 70) * (speed / 70) * 1.2);
    const rate = (Math.abs(tgt) > 0 && Math.sign(tgt) === Math.sign(this.kbSteer || tgt) ? c.keyboardSteerRate : c.keyboardSteerRate * 2.4) * (0.55 + 0.45 * speedF);
    this.kbSteer += clamp(tgt - this.kbSteer, -rate * dt, rate * dt);
    const tt = this.held('throttle') ? 1 : 0, bb = this.held('brake') ? 1 : 0;
    this.kbThrottle += clamp(tt - this.kbThrottle, -6 * dt, 3.6 * dt);
    this.kbBrake += clamp(bb - this.kbBrake, -9 * dt, 4.2 * dt);
    let steer = this.kbSteer, thr = this.kbThrottle, brk = this.kbBrake;
    let analog = false;
    // ---- gamepad
    const gp = this.pollGamepad();
    if (gp) {
      const dz = c.deadzone;
      let ax = gp.axes[0] || 0;
      if (Math.abs(ax) < dz) ax = 0; else ax = Math.sign(ax) * (Math.abs(ax) - dz) / (1 - dz);
      const gt = gp.buttons[7] ? gp.buttons[7].value : 0, gb = gp.buttons[6] ? gp.buttons[6].value : 0;
      if (Math.abs(ax) > 0.001 || gt > 0.02 || gb > 0.02) {
        steer = -ax; analog = true;
        thr = Math.max(thr, gt); brk = Math.max(brk, gb);
      }
      this.gpEdges(gp);
    }
    // ---- touch
    const t = this.touch;
    if (t.active) { steer = t.steer; thr = Math.max(thr, t.throttle); brk = Math.max(brk, t.brake); analog = true; }
    // ---- tilt steering
    if (c.tilt && this.orient.ok && !t.active) {
      const a = (typeof screen !== 'undefined' && screen.orientation && screen.orientation.angle) || 0;
      const g = a === 90 ? this.orient.beta : a === 270 || a === -90 ? -this.orient.beta : this.orient.gamma;
      steer = clamp(-g / 35, -1, 1); analog = true;
    }
    // ---- shaping
    steer = clamp(steer * c.steerSensitivity, -1, 1);
    steer = lin(steer, c.steerLinearity);
    s.steer = steer;
    s.throttle = clamp(lin(thr, c.throttleLinearity), 0, 1);
    s.brake = clamp(lin(brk, c.brakeLinearity), 0, 1);
    s.drs = this.held('drs') || (t.active && t.drs) || (gp && gp.buttons[2] && gp.buttons[2].pressed);
    s.analog = analog;
    return s;
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
