// Persistent settings (localStorage with graceful fallback). Everything user-tunable lives here.
const KEY = 'apexgp.settings.v1';

export const DEFAULT_KEYS = {
  throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  shiftUp: ['KeyE', 'ShiftLeft'], shiftDown: ['KeyQ', 'ControlLeft'], drs: ['Space'], pit: ['KeyB'], camera: ['KeyC'],
  reset: ['KeyR'], pause: ['Escape', 'KeyP'], replay: ['KeyV'], biasUp: ['BracketRight'], biasDown: ['BracketLeft'],
  ers: ['KeyG'], gearMode: ['KeyT'], limiter: ['KeyL'], map: ['KeyM'], lookBack: ['KeyX'], diffUp: ['Period'], diffDown: ['Comma'], fps: ['F3'],
};
export const KEY_LABELS = {
  throttle: 'Throttle', brake: 'Brake', left: 'Steer left', right: 'Steer right', shiftUp: 'Shift up', shiftDown: 'Shift down',
  drs: 'DRS', pit: 'Pit request', camera: 'Change camera', reset: 'Reset car (practice)', pause: 'Pause', replay: 'Instant replay',
  biasUp: 'Brake bias +', biasDown: 'Brake bias -', ers: 'ERS mode', gearMode: 'Auto / manual gearbox', limiter: 'Pit limiter', map: 'Toggle map', lookBack: 'Look back',
  diffUp: 'Diff lock +', diffDown: 'Diff lock -', fps: 'Show FPS',
};

export const DEFAULTS = {
  graphics: 'auto',            // auto | low | medium | high
  fps: 'auto',                 // auto | 30 | 60 | 90 | 120
  resolution: 1,               // manual render scale cap (0.5 .. 1)
  dynamicResolution: true,
  thermalGuard: true,
  audio: { master: 0.8, engine: 0.9, effects: 0.8, engineSound: 'auto' },
  controls: {
    steerSensitivity: 1, steerLinearity: 1.25, throttleLinearity: 1, brakeLinearity: 1.1, deadzone: 0.08,
    keyboardSteerRate: 2.6, steerAssistKeyboard: true, touchMode: 'buttons', tilt: false, haptics: true,
  },
  keys: DEFAULT_KEYS,
  assists: { abs: 0, tc: 1, steer: 1, autoGear: true, pitLimiter: true, racingLine: false },
  game: {
    mode: 'race', trackId: 'monza', team: 0, laps: 3, aiCount: 15, difficulty: 'pro', weather: 'dry', compound: 'medium',
    wear: 2, formationLap: false, safetyCar: 'auto', qualiMinutes: 6, practiceMinutes: 10, camera: 'chase', damage: true, penalties: true,
  },
  setup: { frontWing: 5, rearWing: 5, brakeBias: 0.575, diffPreload: 120, diffPower: 0.35, engineBraking: 0.7 },
  touch: { opacity: 0.6, scale: 1, layout: null, layoutV: 0 },
  ui: { fps: false, hudScale: 1, minimap: true, timing: true, units: 'kmh' },
  records: {},
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function merge(base, extra) {
  if (extra == null || typeof extra !== 'object' || Array.isArray(extra)) return base;
  for (const k of Object.keys(base)) {
    if (!(k in extra)) continue;
    const b = base[k], e = extra[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) merge(b, e);
    else if (typeof e === typeof b || b === null || e === null) base[k] = e;
  }
  return base;
}

export class Settings {
  constructor() {
    this.data = clone(DEFAULTS);
    this.listeners = new Set();
    this.load();
  }
  load() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      if (raw) merge(this.data, JSON.parse(raw));
    } catch (e) { /* storage unavailable: defaults */ }
    return this;
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    for (const f of this.listeners) f(this.data);
  }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  reset() { this.data = clone(DEFAULTS); this.save(); }
  recordLap(trackId, t) {
    const r = this.data.records;
    if (!r[trackId] || t < r[trackId]) { r[trackId] = t; this.save(); return true; }
    return false;
  }
}
