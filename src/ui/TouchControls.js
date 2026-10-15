// TouchControls: plain digital on-screen buttons (like a mobile racing game). No pedals, sliders or anything that needs a finger to move.
//   GAS (bottom right) - held = throttle, released = throttle off
//   BRAKE (left of GAS) - held = brake, released = brake off
//   steering (left side)  - two hold-buttons  (optional analog virtual wheel / gyro in the settings)
//   shift / DRS / pit / camera / ERS / pause buttons
// Every button is tracked by its own pointer(s), so steering + GAS (or BRAKE) work together with real multi-touch. Everything is
// released on pointer-up / cancel / lost capture, touch-end, window blur, page hide and whenever the controls are hidden.
// Size, opacity and position of each button can be edited (Settings > Touch > Edit layout) and are stored in the settings.
import { clamp } from '../core/math.js';

const LAYOUT_VERSION = 2;
// x / y = left / bottom offset in % of the screen, s = size multiplier, o = opacity multiplier
const DEFAULT_LAYOUT = {
  left: { x: 1.5, y: 4, s: 1, o: 1 }, right: { x: 14.5, y: 4, s: 1, o: 1 }, steer: { x: 2, y: 4, s: 1, o: 1 },
  brake: { x: 70.5, y: 4, s: 1, o: 1 }, gas: { x: 84.5, y: 4, s: 1, o: 1 },
  up: { x: 60, y: 33, s: 1, o: 1 }, down: { x: 53, y: 33, s: 1, o: 1 }, drs: { x: 89.5, y: 33, s: 1, o: 1 }, pit: { x: 82, y: 33, s: 1, o: 1 },
  cam: { x: 67.5, y: 33, s: 1, o: 1 }, ers: { x: 74.5, y: 33, s: 1, o: 1 }, pause: { x: 46, y: 83, s: 0.85, o: 1 },
};
const LABELS = { left: '◀', right: '▶', gas: 'GAS', brake: 'BRAKE', up: '▲', down: '▼', drs: 'DRS', pit: 'PIT', cam: '🎥', ers: 'ERS', pause: 'II' };
const NAMES = { left: 'Steer left', right: 'Steer right', steer: 'Virtual wheel', gas: 'GAS', brake: 'BRAKE', up: 'Shift up', down: 'Shift down', drs: 'DRS', pit: 'Pit', cam: 'Camera', ers: 'ERS', pause: 'Pause' };
const HOLD = new Set(['left', 'right', 'gas', 'brake', 'drs']);     // buttons that act while held
const TAP_ACTION = { up: 'shiftUp', down: 'shiftDown', cam: 'camera', pit: 'pit', ers: 'ers', pause: 'pause' };

export class TouchControls {
  constructor(root, input, settings) {
    this.root = root; this.input = input; this.settings = settings;
    this.el = document.createElement('div'); this.el.className = 'touch hidden'; root.appendChild(this.el);
    this.items = {}; this.pointers = new Map(); this.editing = false; this.drag = null; this.selected = null;
    this.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    const T = settings.data.touch;
    if (T.layout && T.layoutV === LAYOUT_VERSION) for (const k of Object.keys(T.layout)) if (this.layout[k]) Object.assign(this.layout[k], T.layout[k]);
    this.steerAngle = 0;
    this.build();
    this.apply();
    // pointer events on the buttons themselves (capture keeps a finger that slides off the button holding it - nothing needs to move)
    for (const id of Object.keys(this.items)) {
      const e = this.items[id];
      e.addEventListener('pointerdown', (ev) => this.down(ev, id));
      e.addEventListener('pointerup', (ev) => this.up(ev));
      e.addEventListener('pointercancel', (ev) => this.up(ev));
      e.addEventListener('lostpointercapture', (ev) => this.up(ev));
      e.addEventListener('contextmenu', (ev) => ev.preventDefault());
    }
    // safety nets: whatever happens to the page, nothing may stay pressed
    window.addEventListener('pointermove', (ev) => this.move(ev));
    window.addEventListener('pointerup', (ev) => this.up(ev));
    window.addEventListener('pointercancel', (ev) => this.up(ev));
    window.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('pagehide', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    const touchEnd = (ev) => { if (!ev.touches || ev.touches.length === 0) this.releaseAll(); };
    window.addEventListener('touchend', touchEnd, { passive: true });
    window.addEventListener('touchcancel', touchEnd, { passive: true });
    // no pinch / long-press / selection from the control layer (iOS Safari / WKWebView)
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) this.el.addEventListener(t, (ev) => ev.preventDefault());
  }

  build() {
    const mk = (id, cls, html = '') => { const d = document.createElement('div'); d.className = 'tctl ' + cls; d.dataset.id = id; d.innerHTML = html; this.el.appendChild(d); this.items[id] = d; return d; };
    const w = mk('steer', 'tc-wheel', '<div class="wheel"><i></i><b></b></div>');
    this.wheelEl = w.querySelector('.wheel');
    mk('left', 'tc-big tc-steerbtn', '<span>' + LABELS.left + '</span>');
    mk('right', 'tc-big tc-steerbtn', '<span>' + LABELS.right + '</span>');
    mk('brake', 'tc-big tc-brake', '<span>BRAKE</span>');
    mk('gas', 'tc-big tc-gas', '<span>GAS</span>');
    for (const id of ['up', 'down', 'drs', 'pit', 'cam', 'ers', 'pause']) mk(id, 'tc-btn', LABELS[id]);
  }

  apply() {
    const T = this.settings.data.touch;
    this.el.style.setProperty('--tco', T.opacity); this.el.style.setProperty('--tcs', T.scale);
    const C = this.settings.data.controls;
    const wheel = C.touchMode === 'wheel', tilt = !!C.tilt;
    for (const id of Object.keys(this.items)) {
      const L = this.layout[id], e = this.items[id];
      e.style.left = L.x + '%'; e.style.bottom = L.y + '%'; e.style.setProperty('--s', L.s); e.style.setProperty('--o', L.o ?? 1);
      let show = true;
      if (id === 'steer') show = wheel && !tilt;
      else if (id === 'left' || id === 'right') show = !wheel && !tilt;
      e.style.display = show || this.editing ? '' : 'none';
      e.classList.toggle('unused', this.editing && !show);
    }
  }
  show(on) { this.el.classList.toggle('hidden', !on); if (!on) this.releaseAll(); }
  saveLayout() { const T = this.settings.data.touch; T.layout = JSON.parse(JSON.stringify(this.layout)); T.layoutV = LAYOUT_VERSION; this.settings.save(); }
  resetLayout() { this.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); const T = this.settings.data.touch; T.layout = null; T.layoutV = LAYOUT_VERSION; this.settings.save(); this.apply(); this.syncEditor(); }

  // ---------------------------------------------------------------- layout editor (touch friendly: drag to move, sliders for size / opacity)
  openEditor(onDone) {
    this.editing = true; this.el.classList.add('editing'); this.show(true); this.apply();
    const bar = document.createElement('div'); bar.className = 'tc-editor';
    bar.innerHTML = '<b class="tce-name">Tap a button</b>'
      + '<label>Size <input class="tce-size" type="range" min="0.6" max="1.8" step="0.05"></label>'
      + '<label>Opacity <input class="tce-op" type="range" min="0.2" max="1" step="0.05"></label>'
      + '<button class="btn small tce-reset">Reset</button><button class="btn primary small tce-done">Done</button>';
    this.el.appendChild(bar); this.editorEl = bar;
    const size = bar.querySelector('.tce-size'), op = bar.querySelector('.tce-op');
    size.oninput = () => { if (this.selected) { this.layout[this.selected].s = +size.value; this.apply(); } };
    op.oninput = () => { if (this.selected) { this.layout[this.selected].o = +op.value; this.apply(); } };
    bar.querySelector('.tce-reset').onclick = () => this.resetLayout();
    bar.querySelector('.tce-done').onclick = () => { this.closeEditor(); if (onDone) onDone(); };
    for (const t of ['pointerdown', 'pointermove', 'pointerup']) bar.addEventListener(t, (ev) => ev.stopPropagation());
    this.select(this.selected || 'gas');
  }
  closeEditor() {
    this.editing = false; this.el.classList.remove('editing'); this.drag = null; this.saveLayout();
    if (this.editorEl) { this.editorEl.remove(); this.editorEl = null; }
    for (const e of Object.values(this.items)) e.classList.remove('sel');
    this.apply();
  }
  select(id) { this.selected = id; for (const [k, e] of Object.entries(this.items)) e.classList.toggle('sel', k === id); this.syncEditor(); }
  syncEditor() {
    if (!this.editorEl || !this.selected) return;
    const L = this.layout[this.selected];
    this.editorEl.querySelector('.tce-name').textContent = NAMES[this.selected];
    this.editorEl.querySelector('.tce-size').value = L.s; this.editorEl.querySelector('.tce-op').value = L.o ?? 1;
  }

  // ---------------------------------------------------------------- pointer handling
  down(e, id) {
    e.preventDefault();
    const tgt = this.items[id];
    if (this.editing) {
      this.select(id);
      this.drag = { id, px: e.clientX, py: e.clientY, L: { ...this.layout[id] }, pid: e.pointerId };
      try { tgt.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      return;
    }
    this.input.touch.active = true;
    try { tgt.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const ptr = { id, el: tgt }; this.pointers.set(e.pointerId, ptr);
    if (id === 'steer') this.wheelFrom(ptr, e);
    tgt.classList.add('down');
    if (TAP_ACTION[id]) this.input.pressed.add(TAP_ACTION[id]);
    this.input.latch(id);
    if (this.settings.data.controls.haptics && navigator.vibrate && HOLD.has(id)) { try { navigator.vibrate(6); } catch (err) { /* ignore */ } }
    this.recompute();
  }
  move(e) {
    if (this.drag && e.pointerId === this.drag.pid) {
      const d = this.drag, W = window.innerWidth, H = window.innerHeight;
      this.layout[d.id].x = clamp(d.L.x + ((e.clientX - d.px) / W) * 100, 0, 96);
      this.layout[d.id].y = clamp(d.L.y - ((e.clientY - d.py) / H) * 100, 0, 92);
      this.apply(); return;
    }
    const p = this.pointers.get(e.pointerId);
    if (p && p.id === 'steer') { this.wheelFrom(p, e); this.recompute(); }
  }
  up(e) {
    if (this.drag && e.pointerId === this.drag.pid) { this.drag = null; return; }
    const p = this.pointers.get(e.pointerId); if (!p) return;
    this.pointers.delete(e.pointerId);
    // the button stays visually/logically held while ANOTHER finger is still on it
    let still = false; for (const q of this.pointers.values()) if (q.el === p.el) still = true;
    if (!still) p.el.classList.remove('down');
    this.recompute();
  }
  wheelFrom(p, e) {
    const r = p.el.getBoundingClientRect();
    p.val = clamp(-(e.clientX - (r.left + r.width / 2)) / (r.width * 0.42), -1, 1);
  }
  /** release every control right now (focus loss, pause, menu, hidden page) */
  releaseAll() {
    for (const p of this.pointers.values()) p.el.classList.remove('down');
    this.pointers.clear();
    this.recompute();
  }
  recompute() {
    const t = this.input.touch;
    let left = false, right = false, gas = false, brake = false, drs = false, wheel = false, steer = 0;
    for (const p of this.pointers.values()) {
      switch (p.id) {
        case 'left': left = true; break;
        case 'right': right = true; break;
        case 'gas': gas = true; break;
        case 'brake': brake = true; break;
        case 'drs': drs = true; break;
        case 'steer': wheel = true; steer = p.val || 0; break;
        default: break;
      }
    }
    t.left = left; t.right = right; t.gas = gas; t.brake = brake; t.drs = drs; t.wheel = wheel; t.steer = steer;
    if (!this.pointers.size) t.active = false;
    // wheel graphic follows the analog wheel (only visible when the wheel style is selected)
    this.steerAngle += ((-steer * 110) - this.steerAngle) * 0.5;
    this.wheelEl.style.transform = `rotate(${this.steerAngle}deg)`;
  }
}
