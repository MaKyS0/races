// Perf: frame pacing (30/60/90/120 target), dynamic resolution, thermal/sustained-load governor, memory + frame stats.
// It never tries to defeat OS thermal management: it only reduces its own load when the platform or the numbers say so.
import { clamp } from './math.js';

export const QUALITY = {
  low:    { name: 'Low',    shadows: 0, shadowSize: 0,    pixelRatio: 1.0, particles: 0.35, drawDistance: 650,  decor: 0.25, carLod: 0, env: false, antialias: false, reflections: 0, trees: 0.3, stands: 0.5, anisotropy: 1, texScale: 0.5, skid: 120 },
  medium: { name: 'Medium', shadows: 1, shadowSize: 1024, pixelRatio: 1.5, particles: 0.7,  drawDistance: 1100, decor: 0.6,  carLod: 1, env: true,  antialias: true,  reflections: 1, trees: 0.7, stands: 0.8, anisotropy: 4, texScale: 0.75, skid: 300 },
  high:   { name: 'High',   shadows: 2, shadowSize: 2048, pixelRatio: 2.0, particles: 1.0,  drawDistance: 1700, decor: 1.0,  carLod: 2, env: true,  antialias: true,  reflections: 2, trees: 1.0, stands: 1.0, anisotropy: 8, texScale: 1.0, skid: 600 },
};

export function detectDevice() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /Mac/.test(ua));
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || (mobile ? 3 : 8);
  return { mobile, cores, mem };
}
export function autoQuality(dev) {
  if (dev.mobile) return dev.mem >= 6 && dev.cores >= 8 ? 'medium' : 'low';
  return dev.cores >= 8 ? 'high' : 'medium';
}

export class Perf {
  constructor(settings) {
    this.settings = settings;
    this.dev = detectDevice();
    this.frameMs = 16.7; this.cpuMs = 0; this.physMs = 0; this.renderMs = 0; this.fps = 60;
    this.refreshHz = 60; this.refreshSamples = [];
    this.scale = 1;                 // dynamic resolution multiplier (0.5..1)
    this.level = 0;                 // governor level 0..3 (0 = full quality)
    this.thermal = 'nominal';       // nominal | fair | serious | critical
    this.slowT = 0; this.fastT = 0; this.coolT = 0;
    this.lastRender = 0;
    this.heapMB = 0; this.heapDrops = 0; this._lastHeap = 0;
    this.history = new Float32Array(120); this.hIdx = 0;
    this.longFrames = 0; this.frames = 0;
    this.sessionT = 0;
    this.nativeThermal = null;
    this.initThermal();
    this.listeners = new Set();
  }
  get targetFps() {
    const f = this.settings.data.fps;
    let t;
    if (f === 'auto') t = this.dev.mobile ? 60 : Math.min(this.refreshHz > 100 ? 120 : 60, 120);
    else t = +f;
    // do not promise more than the display can show
    if (this.refreshHz > 0 && t > this.refreshHz * 1.08) t = this.refreshHz > 100 ? 120 : this.refreshHz > 75 ? 90 : 60;
    if (this.level >= 3) t = Math.min(t, 30);
    else if (this.level >= 2 && t > 60) t = 60;
    if (this.thermal === 'critical') t = Math.min(t, 30);
    return t;
  }
  qualityName() {
    const g = this.settings.data.graphics;
    let q = g === 'auto' ? autoQuality(this.dev) : g;
    if (this.level >= 2 && q === 'high') q = 'medium';
    if (this.level >= 3 && q !== 'low') q = 'low';
    return q;
  }
  initThermal() {
    // Capacitor plugin (Android PowerManager thermal status / iOS ProcessInfo.thermalState) when present
    try {
      const cap = typeof window !== 'undefined' && window.Capacitor;
      if (cap && cap.Plugins && cap.Plugins.Thermal) {
        this.nativeThermal = cap.Plugins.Thermal;
        const poll = async () => { try { const r = await this.nativeThermal.getState(); this.setThermal(r.state); } catch (e) { /* plugin missing */ } };
        poll(); this._thermalTimer = setInterval(poll, 5000);
      }
    } catch (e) { /* ignore */ }
    // Battery API is not a temperature source but a low battery on mobile is a reason to be frugal
    try { if (typeof navigator !== 'undefined' && navigator.getBattery) navigator.getBattery().then((b) => { this.battery = b; }); } catch (e) { /* ignore */ }
  }
  setThermal(s) { if (s !== this.thermal) { this.thermal = s; this.coolT = 0; } }
  stop() { if (this._thermalTimer) clearInterval(this._thermalTimer); }

  /** decide whether to render this animation frame (frame limiter). now in ms (rAF timestamp). */
  shouldRender(now) {
    // refresh-rate estimation from rAF cadence
    if (this.lastRaf) {
      const d = now - this.lastRaf;
      if (d > 3 && d < 60) {
        this.refreshSamples.push(d);
        if (this.refreshSamples.length >= 40) {
          const s = this.refreshSamples.slice().sort((a, b) => a - b);
          const med = s[s.length >> 1];
          const hz = 1000 / med;
          this.refreshHz = hz > 105 ? 120 : hz > 80 ? 90 : hz > 50 ? 60 : hz > 25 ? 30 : this.refreshHz;
          this.refreshSamples.length = 0;
        }
      }
    }
    this.lastRaf = now;
    const interval = 1000 / this.targetFps;
    if (now - this.lastRender < interval - 2.0) return false;
    this.lastRender = Math.max(now - 1, this.lastRender + interval > now ? this.lastRender + interval : now);
    return true;
  }

  /** feed one frame's timing (ms of real elapsed frame, cpu busy time) */
  endFrame(elapsedMs, cpuMs, physMs, renderMs) {
    this.frames++;
    this.frameMs += (elapsedMs - this.frameMs) * 0.08;
    this.cpuMs += (cpuMs - this.cpuMs) * 0.08;
    this.physMs += (physMs - this.physMs) * 0.1;
    this.renderMs += (renderMs - this.renderMs) * 0.1;
    this.fps = 1000 / Math.max(1, this.frameMs);
    this.history[this.hIdx++ % this.history.length] = elapsedMs;
    const budget = 1000 / this.targetFps;
    if (elapsedMs > budget * 1.5) this.longFrames++;
    this.sessionT += elapsedMs / 1000;
    // heap (Chrome only): count GC-like drops
    if (this.frames % 30 === 0 && typeof performance !== 'undefined' && performance.memory) {
      const h = performance.memory.usedJSHeapSize / 1048576;
      if (h < this.heapMB - 2) this.heapDrops++;
      this.heapMB = h;
    }
    this.govern(elapsedMs, budget);
  }

  govern(ms, budget) {
    const st = this.settings.data;
    const dt = ms / 1000;
    // ---- dynamic resolution
    if (st.dynamicResolution) {
      if (this.frameMs > budget * 1.12) { this.slowT += dt; this.fastT = 0; }
      else if (this.frameMs < budget * 0.72) { this.fastT += dt; this.slowT = Math.max(0, this.slowT - dt); }
      else { this.slowT = Math.max(0, this.slowT - dt * 0.5); this.fastT = Math.max(0, this.fastT - dt * 0.5); }
      if (this.slowT > 1.0) { this.slowT = 0; this.setScale(this.scale - 0.1); }
      if (this.fastT > 4.0) { this.fastT = 0; this.setScale(this.scale + 0.05); }
    }
    // ---- governor: sustained trouble at minimum resolution, or the platform reporting heat
    if (st.thermalGuard) {
      let want = 0;
      if (this.thermal === 'fair') want = 1; else if (this.thermal === 'serious') want = 2; else if (this.thermal === 'critical') want = 3;
      if (this.scale <= 0.62 && this.frameMs > budget * 1.2) this.coolT = Math.min(this.coolT, 0), this.escT = (this.escT || 0) + dt; else this.escT = Math.max(0, (this.escT || 0) - dt);
      if (this.escT > 6) { want = Math.max(want, Math.min(3, this.level + 1)); this.escT = 0; }
      if (this.battery && !this.battery.charging && this.battery.level < 0.15) want = Math.max(want, 2);
      if (want > this.level) { this.level = want; this.coolT = 0; this.emit(); }
      else if (want < this.level) { this.coolT += dt; if (this.coolT > 90) { this.level--; this.coolT = 0; this.emit(); } }
    } else if (this.level) { this.level = 0; this.emit(); }
  }
  setScale(s) {
    const cap = this.settings.data.resolution;
    const ns = clamp(s, 0.5, cap);
    if (Math.abs(ns - this.scale) > 1e-3) { this.scale = ns; this.emit(); }
  }
  emit() { for (const f of this.listeners) f(this); }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  p95() {
    const a = Array.from(this.history).filter((x) => x > 0).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length * 0.95)] : 0;
  }
}
