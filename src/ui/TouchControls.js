// TouchControls: on-screen steering (wheel or buttons), analog pedals, paddles, DRS/pit/camera buttons.
// Fully re-positionable and resizable (layout stored in settings), landscape-first, multi-touch via pointer events.
import { clamp } from '../core/math.js';

const DEFAULT_LAYOUT = {
  steer: { x: 4, y: 6, s: 1 }, brake: { x: 66, y: 4, s: 1 }, throttle: { x: 80, y: 4, s: 1 },
  up: { x: 52, y: 38, s: 1 }, down: { x: 52, y: 22, s: 1 }, drs: { x: 90, y: 62, s: 1 }, pit: { x: 4, y: 62, s: 1 }, cam: { x: 90, y: 78, s: 1 }, ers: { x: 14, y: 62, s: 1 }, pause: { x: 94, y: 90, s: 0.8 },
};
const LABELS = { up: '▲', down: '▼', drs: 'DRS', pit: 'PIT', cam: '🎥', ers: 'ERS', pause: 'II' };

export class TouchControls {
  constructor(root, input, settings) {
    this.input = input; this.settings = settings;
    this.el = document.createElement('div'); this.el.className = 'touch hidden'; root.appendChild(this.el);
    this.items = {}; this.pointers = new Map(); this.editing = false; this.drag = null;
    this.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    const saved = settings.data.touch.layout;
    if (saved) for (const k of Object.keys(saved)) if (this.layout[k]) Object.assign(this.layout[k], saved[k]);
    this.steerAngle = 0;
    this.build();
    this.apply();
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
  }
  build() {
    const mk = (id, cls, html = '') => { const d = document.createElement('div'); d.className = 'tctl ' + cls; d.dataset.id = id; d.innerHTML = html; this.el.appendChild(d); this.items[id] = d; return d; };
    const w = mk('steer', 'tc-steer', '<div class="wheel"><i></i><b></b></div><div class="arrows"><span data-d="-1">◀</span><span data-d="1">▶</span></div>');
    this.wheelEl = w.querySelector('.wheel'); this.arrowsEl = w.querySelector('.arrows');
    mk('brake', 'tc-pedal brake', '<span>BRAKE</span><div class="fill"></div>');
    mk('throttle', 'tc-pedal thr', '<span>GAS</span><div class="fill"></div>');
    for (const id of ['up', 'down', 'drs', 'pit', 'cam', 'ers', 'pause']) mk(id, 'tc-btn', LABELS[id]);
  }
  apply() {
    const op = this.settings.data.touch.opacity, sc = this.settings.data.touch.scale;
    this.el.style.setProperty('--tco', op); this.el.style.setProperty('--tcs', sc);
    const mode = this.settings.data.controls.touchMode;
    this.wheelEl.style.display = mode === 'wheel' ? '' : 'none';
    this.arrowsEl.style.display = mode === 'buttons' ? '' : 'none';
    this.items.steer.style.display = this.settings.data.controls.tilt ? 'none' : '';
    for (const id of Object.keys(this.items)) {
      const L = this.layout[id], e = this.items[id];
      e.style.left = L.x + '%'; e.style.bottom = L.y + '%'; e.style.setProperty('--s', L.s);
    }
  }
  show(on) { this.el.classList.toggle('hidden', !on); }
  saveLayout() { this.settings.data.touch.layout = JSON.parse(JSON.stringify(this.layout)); this.settings.save(); }
  resetLayout() { this.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); this.settings.data.touch.layout = null; this.settings.save(); this.apply(); }
  setEditing(on) { this.editing = on; this.el.classList.toggle('editing', on); if (!on) this.saveLayout(); }

  down(e) {
    const tgt = e.target.closest('.tctl'); if (!tgt) return;
    this.input.touch.active = true;
    e.preventDefault();
    const id = tgt.dataset.id;
    if (this.editing) { this.drag = { id, px: e.clientX, py: e.clientY, L: { ...this.layout[id] }, pid: e.pointerId, mode: e.shiftKey || e.altKey ? 'scale' : 'move' }; return; }
    this.pointers.set(e.pointerId, { id, el: tgt, sx: e.clientX, sy: e.clientY });
    tgt.classList.add('down');
    this.handle(e, true);
  }
  move(e) {
    if (this.drag && e.pointerId === this.drag.pid) {
      const d = this.drag, W = window.innerWidth, H = window.innerHeight;
      if (d.mode === 'scale') this.layout[d.id].s = clamp(d.L.s + (e.clientX - d.px) / 200, 0.5, 2);
      else { this.layout[d.id].x = clamp(d.L.x + ((e.clientX - d.px) / W) * 100, 0, 96); this.layout[d.id].y = clamp(d.L.y - ((e.clientY - d.py) / H) * 100, 0, 92); }
      this.apply(); return;
    }
    if (!this.pointers.has(e.pointerId)) return;
    this.handle(e, false);
  }
  up(e) {
    if (this.drag && e.pointerId === this.drag.pid) { this.drag = null; return; }
    const p = this.pointers.get(e.pointerId); if (!p) return;
    p.el.classList.remove('down');
    this.pointers.delete(e.pointerId);
    this.recompute();
  }
  handle(e, first) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    const r = p.el.getBoundingClientRect();
    const t = this.input.touch;
    if (p.id === 'steer') {
      const mode = this.settings.data.controls.touchMode;
      if (mode === 'buttons') { const d = e.target.closest('[data-d]'); p.dir = d ? +d.dataset.d : p.dir || 0; }
      else { const cx = r.left + r.width / 2; p.val = clamp(-(e.clientX - cx) / (r.width * 0.42), -1, 1); }
      p.v = mode === 'buttons' ? -(p.dir || 0) : p.val;
    } else if (p.id === 'throttle' || p.id === 'brake') {
      const f = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      p.v = 0.35 + 0.65 * f;
      p.el.querySelector('.fill').style.height = (p.v * 100) + '%';
    } else if (first) {
      const map = { up: 'shiftUp', down: 'shiftDown', cam: 'camera', pit: 'pit', ers: 'ers', pause: 'pause' };
      if (map[p.id]) this.input.pressed.add(map[p.id]);
      if (p.id === 'drs') p.v = 1;
    }
    this.recompute();
  }
  recompute() {
    const t = this.input.touch;
    let steer = 0, thr = 0, brk = 0, drs = false;
    for (const p of this.pointers.values()) {
      if (p.id === 'steer') steer = p.v || 0;
      else if (p.id === 'throttle') thr = Math.max(thr, p.v || 0);
      else if (p.id === 'brake') brk = Math.max(brk, p.v || 0);
      else if (p.id === 'drs') drs = true;
    }
    t.steer = steer; t.throttle = thr; t.brake = brk; t.drs = drs;
    if (!this.pointers.size) { this.items.throttle.querySelector('.fill').style.height = '0'; this.items.brake.querySelector('.fill').style.height = '0'; }
    // steering wheel graphic
    this.steerAngle += ((-steer * 110) - this.steerAngle) * 0.5;
    this.wheelEl.style.transform = `rotate(${this.steerAngle}deg)`;
  }
}
