// Menu: all non-HUD screens (main, session setup, championship, settings/controls, pause, results). Pure DOM, data driven.
import { TEAMS, DIFFICULTY, DRIVERS } from '../race/Roster.js';
import { CIRCUITS, getTrack } from '../track/circuits/index.js';
import { COMPOUNDS } from '../physics/TireModel.js';
import { KEY_LABELS, DEFAULT_KEYS } from '../core/Settings.js';
import { fmtTime } from '../core/math.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
/** the player's team colour is the only brand hue: it is set once here and read by CSS (var(--team)) */
export const setTeamColour = (teamIdx) => { const t = TEAMS[teamIdx % TEAMS.length]; if (t && typeof document !== 'undefined') document.documentElement.style.setProperty('--team', hex(t.color)); };
// brand mark: the racing line through a corner, the apex dot in the team colour
const MARK = '<svg viewBox="0 0 90 64" aria-hidden="true"><path class="rk" d="M4 64 L4 26 Q4 4 26 4 L90 4 M26 64 L26 34 Q26 26 34 26 L90 26"/><path class="rl" d="M8 64 C8 44 13 31 27.5 27.5 C44 23.5 64 12 88 7"/><circle class="ap" cx="27.5" cy="27.5" r="4.4"/></svg>';
/** pit board (the identity's signature): slotted chalk plates on a black board */
export function pitBoard(head, num, slots) {
  return `<div class="pitboard"><div class="pb-head"><span>${head}</span><i>${num}</i></div>${slots.map(([k, v, of]) => `<div class="slot"><span class="k">${k}</span><span class="big">${v}</span>${of ? `<span class="small">${of}</span>` : ''}</div>`).join('')}</div>`;
}
const BLURB = {
  monza: 'Temple of speed. Very long straights, minimal wings and violent braking into the chicanes.',
  monaco: 'Narrow street circuit. Walls everywhere, slow corners, no room for mistakes. Qualifying is everything.',
  spa: 'Huge 3D elevation, the Kemmel straight, a quick Pouhon sweep and a hairpin first corner. Weather loves to change.',
  silverstone: 'Fast flowing sequences, high-speed Maggotts-Becketts-Chapel and a long Hangar straight.',
  suzuka: 'Technical rhythm: S-curves, Degner, the hairpin, Spoon and 130R. Rewards precision.',
  bahrain: 'Desert stop-and-go layout. Big braking zones, three DRS straights, tyre wear matters.',
};

export class Menu {
  constructor(root, game) {
    this.game = game; this.settings = game.settings;
    this.root = el('div', 'menu-root'); root.appendChild(this.root);
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.screen = null; this.stack = [];
    this.trackInfoCache = {};
    this.draft = null; this.tab = 'session';
    setTeamColour(this.settings.data.game.team || 0);
  }
  clear() { if (this.screen) { this.screen.remove(); this.screen = null; } document.body.classList.remove('menu-open'); }
  show(cls = '') { this.clear(); const s = el('div', 'screen ' + cls); this.root.appendChild(s); this.screen = s; document.body.classList.add('menu-open'); return s; }
  hide() { this.clear(); this.stack.length = 0; }
  toast(text, ms = 2600) { const t = el('div', 'toast', text); this.root.appendChild(t); setTimeout(() => t.remove(), ms); }
  btn(text, fn, cls = '') { const b = el('button', 'btn ' + cls, text); b.onclick = () => { this.game.audio.unlock(); fn(); }; return b; }
  loading(text = 'Loading…') { const l = el('div', 'loading', `<div class="loadlights" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div>${text}</div>`); l.style.pointerEvents = 'auto'; this.root.appendChild(l); return () => l.remove(); }

  // ---------------------------------------------------------------- field helpers
  slider(label, min, max, step, get, set, fmt = (v) => v) {
    const f = el('div', 'field'); const l = el('label', null, label);
    const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = get();
    const v = el('div', 'val', fmt(get()));
    r.oninput = () => { set(+r.value); v.textContent = fmt(+r.value); };
    r.onchange = () => this.settings.save();
    f.append(l, r, v); return f;
  }
  select(label, options, get, set) {
    const f = el('div', 'field'); const l = el('label', null, label); const s = el('select');
    options.forEach(([val, txt]) => { const o = el('option', null, txt); o.value = val; s.appendChild(o); });
    s.value = String(get()); s.onchange = () => { set(isNaN(+s.value) || s.value === '' ? s.value : +s.value); this.settings.save(); };
    f.append(l, s, el('div', 'val')); return f;
  }
  toggle(label, get, set) {
    const f = el('div', 'field'); const l = el('label', null, label); const b = el('button', 'switch' + (get() ? ' on' : ''));
    b.onclick = () => { const nv = !get(); set(nv); b.classList.toggle('on', nv); this.settings.save(); };
    f.append(l, el('div'), b); return f;
  }

  // ---------------------------------------------------------------- MAIN
  showMain() {
    this.game.enterMenuScene();
    setTeamColour(this.settings.data.game.team || 0);
    const s = this.show('main');
    const brand = el('div', 'brand', `<span class="word">Apex GP</span>${MARK}`);
    s.append(brand, el('div', 'sub', 'Single-seater racing with real tyre, brake and weather physics on six circuits.'));
    const m = el('div', 'menu');
    const champ = this.game.championship;
    const minor = el('div', 'minor');
    minor.append(
      this.btn('Garage', () => { this.tab = 'car'; this.showSetup(); }, 'small'),
      this.btn('Controls', () => this.showSettings('controls'), 'small'),
      this.btn('Settings', () => this.showSettings('graphics'), 'small'),
      this.btn('How to drive', () => this.showHelp(), 'small'),
    );
    m.append(
      this.btn('Quick race', () => this.game.startSession({ ...this.settings.data.game, assists: this.settings.data.assists, setup: this.settings.data.setup }), 'primary'),
      this.btn('Session setup', () => this.showSetup()),
      this.btn(champ.active ? `Championship, round ${champ.round + 1} of ${champ.calendar.length}` : 'Championship', () => this.showChampionship()),
      el('div', 'group-gap'), minor,
    );
    s.appendChild(m);
    const n = Object.keys(this.settings.data.records).length;
    const f = el('div', 'footer'); f.appendChild(el('div', 'sub', n ? `Personal bests saved on this device for ${n} ${n === 1 ? 'circuit' : 'circuits'}.` : 'Personal bests are saved on this device.'));
    s.appendChild(f);
    const first = m.querySelector('.btn'); if (first && !('ontouchstart' in window)) first.focus({ preventScroll: true });
  }

  showHelp() {
    const s = this.show('solid');
    s.append(el('div', 'title', 'How to drive'));
    const p = el('div', 'panel');
    p.innerHTML = `<p><b>Braking is a skill.</b> Pressure builds with your input; heavy braking transfers weight to the front axle. Full pedal at low speed locks the wheels (no ABS in races) – brake hard early, release as you slow down and keep the pedal in proportion to available grip (downforce gives more grip at high speed).</p>
    <p><b>Tyres:</b> grip depends on temperature, wear and the surface. Overheated or worn tyres slide. Wet weather needs Intermediate/Wet tyres – slicks aquaplane.</p>
    <p><b>Keyboard:</b> W/S throttle and brake, A/D steer, E/Q shift, Space DRS, B pit request, C camera, V replay, R reset, [ ] brake bias, G ERS mode, Esc pause.<br><b>Gamepad:</b> RT/LT pedals, left stick steers, RB/LB shift, X DRS, Y camera. <b>Touch:</b> GAS and BRAKE buttons on the right, steering on the left (the layout is editable in Settings, Touch).</p>
    <p>Assists (ABS in practice/time-trial, traction control, steering help) make the car easier but never replace the physics – you can still lock up, spin or crash.</p>`;
    s.append(p, el('div', 'footer')); s.lastChild.append(this.btn('Back', () => this.showMain(), 'small'));
  }

  // ---------------------------------------------------------------- SESSION SETUP
  draftCfg() { if (!this.draft) this.draft = JSON.parse(JSON.stringify(this.settings.data.game)); return this.draft; }
  showSetup() {
    const g = this.draftCfg();
    this.game.enterMenuScene(g.team);
    const s = this.show();
    s.append(el('div', 'title', 'Session setup'));
    const tabs = el('div', 'tabs');
    for (const [id, name] of [['session', 'Mode & track'], ['car', 'Team & car'], ['rules', 'Race rules'], ['assists', 'Driver aids']]) {
      const t = el('button', 'tab' + (this.tab === id ? ' on' : ''), name); t.onclick = () => { this.tab = id; this.showSetup(); }; tabs.appendChild(t);
    }
    s.appendChild(tabs);
    const body = el('div', 'panel'); s.appendChild(body);
    if (this.tab === 'session') this.tabSession(body, g);
    else if (this.tab === 'car') this.tabCar(body, g);
    else if (this.tab === 'rules') this.tabRules(body, g);
    else this.tabAssists(body);
    const f = el('div', 'footer');
    const lbl = { race: 'Start race', quali: 'Start qualifying', practice: 'Start practice', timetrial: 'Start time trial' }[g.mode] || 'Start';
    f.append(this.btn(lbl, () => this.go(), 'primary small'), this.btn('Back', () => { this.draft = null; this.showMain(); }, 'small ghost'));
    s.appendChild(f);
  }
  go() {
    const g = this.draftCfg();
    Object.assign(this.settings.data.game, g); this.settings.save();
    this.game.startSession({ ...g, assists: this.settings.data.assists, setup: this.settings.data.setup });
  }
  tabSession(body, g) {
    const modes = [['race', 'Grand Prix'], ['quali', 'Qualifying'], ['practice', 'Practice'], ['timetrial', 'Time Trial']];
    const row = el('div', 'row');
    for (const [id, name] of modes) { const b = el('button', 'btn small' + (g.mode === id ? ' sel' : ''), name); b.onclick = () => { g.mode = id; this.showSetup(); }; row.appendChild(b); }
    body.append(row, el('div', 'modehint', { race: 'Full race with start procedure, pit stops, flags, safety car and penalties.', quali: 'Timed qualifying against the field. Your result sets the grid for the next race.', practice: 'Free practice with opponents, assists allowed (ABS), unlimited tyre changes.', timetrial: 'Just you and your best-lap ghost.' }[g.mode]));
    const cards = el('div', 'cards');
    for (const c of CIRCUITS) {
      const card = el('div', 'card' + (g.trackId === c.id ? ' sel' : ''));
      card.tabIndex = 0; card.setAttribute('role', 'radio'); card.setAttribute('aria-checked', String(g.trackId === c.id));
      card.innerHTML = `<h3>${c.name}</h3><svg data-t="${c.id}" viewBox="0 0 200 120"></svg><p class="meta" data-m="${c.id}"></p><p>${BLURB[c.id] || ''}</p>`;
      card.onclick = () => { g.trackId = c.id; cards.querySelectorAll('.card').forEach((x) => { x.classList.remove('sel'); x.setAttribute('aria-checked', 'false'); }); card.classList.add('sel'); card.setAttribute('aria-checked', 'true'); };
      card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.onclick(); } };
      cards.appendChild(card);
    }
    body.appendChild(cards);
    this.fillTrackCards(cards);
  }
  fillTrackCards(cards) {
    const ids = CIRCUITS.map((c) => c.id);
    const next = () => {
      const id = ids.shift(); if (!id || !cards.isConnected) return;
      const info = this.trackInfo(id);
      const svg = cards.querySelector(`svg[data-t="${id}"]`);
      if (svg) svg.innerHTML = `<path d="${info.path}" fill="none" stroke-width="3.2" stroke-linejoin="round"/><circle cx="${info.start[0]}" cy="${info.start[1]}" r="4.2"/>`;
      const m = cards.querySelector(`[data-m="${id}"]`);
      if (m) m.textContent = `${(info.length / 1000).toFixed(2)} km, ${info.corners} corners, ${info.drs} DRS ${info.drs === 1 ? 'zone' : 'zones'}, ${info.maxElev.toFixed(0)} m climb`;
      setTimeout(next, 16);
    };
    setTimeout(next, 30);
  }
  trackInfo(id) {
    if (this.trackInfoCache[id]) return this.trackInfoCache[id];
    const t = getTrack(id), b = t.bounds;
    const sc = Math.min(176 / (b.maxX - b.minX), 96 / (b.maxZ - b.minZ));
    const ox = 12 + (176 - (b.maxX - b.minX) * sc) / 2, oz = 12 + (96 - (b.maxZ - b.minZ) * sc) / 2;
    const X = (x) => (ox + (x - b.minX) * sc).toFixed(1), Y = (z) => (108 - oz - (z - b.minZ) * sc).toFixed(1);
    let d = '';
    for (let i = 0; i < t.N; i += 6) d += (i ? 'L' : 'M') + X(t.x[i]) + ' ' + Y(t.z[i]);
    const info = { path: d + 'Z', start: [X(t.x[0]), Y(t.z[0])], length: t.length, corners: t.cornerList.length, drs: t.drsZones.length, maxElev: Math.max(...t.y) - Math.min(...t.y) };
    this.trackInfoCache[id] = info; return info;
  }
  tabCar(body, g) {
    const teams = el('div', 'teams');
    TEAMS.forEach((t, i) => {
      const d = el('div', 'team' + (g.team === i ? ' sel' : ''), `<i style="--a:${hex(t.color)};--b:${hex(t.accent)}"></i>${t.name}`);
      d.tabIndex = 0; d.setAttribute('role', 'radio'); d.setAttribute('aria-checked', String(g.team === i));
      d.onclick = () => { g.team = i; this.game.previewTeam(i); setTeamColour(i); teams.querySelectorAll('.team').forEach((x, k) => { x.classList.toggle('sel', k === i); x.setAttribute('aria-checked', String(k === i)); }); };
      d.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.onclick(); } };
      teams.appendChild(d);
    });
    body.append(el('div', 'groupl', 'Livery. Every team drives the same car; only the paint differs.'), teams, el('div', 'groupl', 'Car setup'));
    const S = this.settings.data.setup;
    body.append(
      this.slider('Front wing', 0, 10, 1, () => S.frontWing, (v) => { S.frontWing = v; }, (v) => v),
      this.slider('Rear wing', 0, 10, 1, () => S.rearWing, (v) => { S.rearWing = v; }, (v) => v),
      this.slider('Brake bias (front %)', 50, 66, 0.5, () => S.brakeBias * 100, (v) => { S.brakeBias = v / 100; }, (v) => v.toFixed(1)),
      this.slider('Differential preload (Nm)', 0, 400, 10, () => S.diffPreload, (v) => { S.diffPreload = v; }, (v) => v),
      this.slider('Differential on-throttle lock', 0, 1, 0.05, () => S.diffPower, (v) => { S.diffPower = v; }, (v) => Math.round(v * 100) + '%'),
      this.slider('Engine braking map', 0, 1, 0.05, () => S.engineBraking, (v) => { S.engineBraking = v; }, (v) => Math.round(v * 100) + '%'),
    );
    body.append(el('div', 'sub', 'More wing gives more grip in corners and stability under braking, but a lower top speed. Moving the brake bias rearward stops harder but makes the rear unstable.'));
  }
  tabRules(body, g) {
    const track = CIRCUITS.find((c) => c.id === g.trackId) || CIRCUITS[0];
    body.append(
      this.select('Start tyres', Object.keys(COMPOUNDS).map((k) => [k, COMPOUNDS[k].name]), () => g.compound, (v) => { g.compound = v; }),
      this.slider('Race laps', 1, 30, 1, () => g.laps, (v) => { g.laps = v; }, (v) => v),
      this.slider('Opponents', 0, 19, 1, () => g.aiCount, (v) => { g.aiCount = v; }, (v) => v),
      this.select('AI difficulty', Object.keys(DIFFICULTY).map((k) => [k, DIFFICULTY[k].name]), () => g.difficulty, (v) => { g.difficulty = v; }),
      this.select('Weather', [['dry', 'Dry'], ['light', 'Light rain'], ['heavy', 'Heavy rain'], ['dynamic', 'Dynamic']], () => g.weather, (v) => { g.weather = v; }),
      this.select('Tyre wear', [[0, 'Off'], [1, 'Realistic'], [2, 'Fast (x2)'], [4, 'Extreme (x4)']], () => g.wear, (v) => { g.wear = +v; }),
      this.toggle('Formation lap', () => g.formationLap, (v) => { g.formationLap = v; }),
      this.select('Safety car', [['auto', 'Automatic'], ['off', 'Off']], () => g.safetyCar, (v) => { g.safetyCar = v; }),
      this.toggle('Car damage', () => g.damage, (v) => { g.damage = v; }),
      this.toggle('Penalties & track limits', () => g.penalties, (v) => { g.penalties = v; }),
      this.slider('Qualifying length (min)', 2, 18, 1, () => g.qualiMinutes, (v) => { g.qualiMinutes = v; }, (v) => v),
      this.slider('Practice length (min)', 3, 60, 1, () => g.practiceMinutes, (v) => { g.practiceMinutes = v; }, (v) => v),
      this.select('Default camera', [['chase', 'Chase'], ['cockpit', 'Cockpit'], ['tcam', 'T-cam'], ['top', 'Top'], ['nose', 'Nose']], () => g.camera, (v) => { g.camera = v; }),
    );
    body.append(el('div', 'sub', `${track.name}: one lap is about ${(track.lengthM / 1000).toFixed(2)} km. A full Grand Prix distance would be ${Math.round(305000 / track.lengthM)} laps.`));
  }
  tabAssists(body) {
    const A = this.settings.data.assists;
    body.append(
      this.select('ABS (practice / time-trial only)', [[0, 'Off'], [1, 'Light'], [2, 'Strong']], () => A.abs, (v) => { A.abs = +v; }),
      this.select('Traction control', [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High']], () => A.tc, (v) => { A.tc = +v; }),
      this.select('Steering help', [[0, 'Off (raw)'], [1, 'Speed-sensitive + stability'], [2, 'Strong']], () => A.steer, (v) => { A.steer = +v; }),
      this.toggle('Automatic gearbox', () => A.autoGear, (v) => { A.autoGear = v; }),
      this.toggle('Automatic pit limiter', () => A.pitLimiter, (v) => { A.pitLimiter = v; }),
      this.select('Optimal line', [['full', 'Full line (blue go, yellow lift, red brake)'], ['braking', 'Braking zones only'], ['off', 'Off']], () => A.drivingLine ?? (A.racingLine ? 'full' : 'off'), (v) => { A.drivingLine = v; }),
    );
    body.append(el('div', 'sub', 'Aids reduce workload but never remove the physics: you can still lock a wheel, spin, aquaplane or crash.'));
  }

  // ---------------------------------------------------------------- CHAMPIONSHIP
  showChampionship() {
    const ch = this.game.championship;
    const s = this.show('solid'); s.append(el('div', 'title', 'Championship'));
    if (!ch.state || ch.state.finished) {
      if (ch.state && ch.state.finished) { const p = el('div', 'panel'); const d = ch.driverStandings(); p.innerHTML = `<h3>Season complete. Champion: ${d[0] ? d[0].name : '-'}</h3>`; s.append(p, this.standingsPanel(ch)); }
      const p = el('div', 'panel'); p.append(el('div', 'sub', 'Six circuits, points for the top 10 (25-18-15-12-10-8-6-4-2-1). Standings are saved on this device.'));
      const cfg = { laps: this.settings.data.game.laps, difficulty: this.settings.data.game.difficulty, team: this.settings.data.game.team, aiCount: this.settings.data.game.aiCount, weather: 'dynamic' };
      p.append(
        this.slider('Laps per race', 1, 20, 1, () => cfg.laps, (v) => { cfg.laps = v; }, (v) => v),
        this.select('Difficulty', Object.keys(DIFFICULTY).map((k) => [k, DIFFICULTY[k].name]), () => cfg.difficulty, (v) => { cfg.difficulty = v; }),
        this.select('Weather', [['dry', 'Dry'], ['dynamic', 'Dynamic']], () => cfg.weather, (v) => { cfg.weather = v; }),
        this.select('Team', TEAMS.map((t, i) => [i, t.name]), () => cfg.team, (v) => { cfg.team = +v; }),
        this.slider('Opponents', 5, 19, 1, () => cfg.aiCount, (v) => { cfg.aiCount = v; }, (v) => v),
      );
      s.append(p);
      const f = el('div', 'footer'); f.append(this.btn('Start new season', () => { ch.start(cfg); this.showChampionship(); }, 'primary small'), this.btn('Back', () => this.showMain(), 'small ghost')); s.append(f);
      return;
    }
    const st = ch.state;
    const cal = el('div', 'panel'); cal.innerHTML = '<h3>Calendar</h3>' + st.calendar.map((id, i) => { const c = CIRCUITS.find((x) => x.id === id); return `<div class="row"><b>${i + 1}.</b> ${c ? c.name : id} <span class="sub" style="margin:0">${i < st.round ? 'done' : i === st.round ? 'next' : ''}</span></div>`; }).join('');
    s.append(cal, this.standingsPanel(ch));
    const f = el('div', 'footer');
    f.append(this.btn(`Start round ${st.round + 1}: ${(CIRCUITS.find((c) => c.id === ch.currentTrack) || {}).name}`, () => this.game.startChampionshipRound(), 'primary small'), this.btn('Back', () => this.showMain(), 'small'), this.btn('Abandon season', () => { ch.abandon(); this.showChampionship(); }, 'small ghost'));
    s.append(f);
  }
  standingsPanel(ch) {
    const p = el('div', 'panel');
    const ds = ch.driverStandings().slice(0, 12), ts = ch.teamStandings();
    p.innerHTML = `<h3>Drivers</h3><table class="table"><tr><th>#</th><th>Driver</th><th>Pts</th><th>Wins</th><th>Podiums</th></tr>${ds.map((d, i) => `<tr class="${d.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${d.name}</td><td>${d.points}</td><td>${d.wins}</td><td>${d.podiums}</td></tr>`).join('') || '<tr><td colspan=5>No races yet</td></tr>'}</table>
      <h3>Teams</h3><table class="table"><tr><th>#</th><th>Team</th><th>Pts</th></tr>${ts.map((t, i) => `<tr><td>${i + 1}</td><td class="tmc"><i style="background:${hex(t.color)}"></i>${t.name}</td><td>${t.points}</td></tr>`).join('')}</table>`;
    return p;
  }

  // ---------------------------------------------------------------- SETTINGS / CONTROLS
  showSettings(tab = 'graphics', back = null) {
    const D = this.settings.data;
    const s = this.show('solid'); s.append(el('div', 'title', 'Settings'));
    const tabs = el('div', 'tabs');
    for (const [id, name] of [['graphics', 'Graphics and performance'], ['audio', 'Audio'], ['controls', 'Controls'], ['touch', 'Touch']]) { const t = el('button', 'tab' + (tab === id ? ' on' : ''), name); t.onclick = () => this.showSettings(id, back); tabs.appendChild(t); }
    s.appendChild(tabs);
    const body = el('div', 'panel'); s.appendChild(body);
    const perf = this.game.perf;
    if (tab === 'graphics') {
      body.append(
        this.select('Graphics profile', [['auto', `Auto (${perf.qualityName()})`], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], () => D.graphics, (v) => { D.graphics = v; perf.level = 0; this.game.renderer.onPerfChange(); }),
        this.toggle('Cinematic look (glow, light shafts, speed blur, colour grade)', () => D.fx !== false, (v) => { D.fx = v; this.game.renderer.applyScale(); }),
        this.select('Target frame rate', [['auto', `Auto (${perf.targetFps} fps)`], [30, '30 fps, saves battery'], [60, '60 fps, recommended'], [90, '90 fps'], [120, '120 fps']], () => D.fps, (v) => { D.fps = v; }),
        this.slider('Max render resolution', 0.5, 1, 0.05, () => D.resolution, (v) => { D.resolution = v; perf.setScale(Math.min(perf.scale, v)); this.game.renderer.applyScale(); }, (v) => Math.round(v * 100) + '%'),
        this.toggle('Dynamic resolution', () => D.dynamicResolution, (v) => { D.dynamicResolution = v; }),
        this.toggle('Thermal / sustained-load protection', () => D.thermalGuard, (v) => { D.thermalGuard = v; }),
        this.toggle('Show FPS / frame timings', () => D.ui.fps, (v) => { D.ui.fps = v; }),
        this.select('Speed units', [['kmh', 'km/h'], ['mph', 'mph']], () => D.ui.units, (v) => { D.ui.units = v; }),
        this.slider('HUD size', 0.6, 1.6, 0.1, () => D.ui.hudScale, (v) => { D.ui.hudScale = v; this.game.hud.setScale(v); }, (v) => v.toFixed(1)),
      );
      body.append(el('div', 'sub', `This device: ${perf.dev.mobile ? 'mobile' : 'desktop'}, ${perf.dev.cores} cores, display about ${perf.refreshHz} Hz. Current profile ${perf.qualityName()}, governor level ${perf.level}, render scale ${(perf.scale * 100).toFixed(0)}%. If the device cannot keep up or reports heat, the game lowers resolution first, then shadows, then frame rate; it never bypasses the system's thermal control.`));
    } else if (tab === 'audio') {
      const A = D.audio;
      body.append(
        this.slider('Master volume', 0, 1, 0.05, () => A.master, (v) => { A.master = v; this.game.audio.applyVolumes(); }, (v) => Math.round(v * 100) + '%'),
        this.slider('Engine', 0, 1, 0.05, () => A.engine, (v) => { A.engine = v; this.game.audio.applyVolumes(); }, (v) => Math.round(v * 100) + '%'),
        this.slider('Effects', 0, 1, 0.05, () => A.effects, (v) => { A.effects = v; this.game.audio.applyVolumes(); }, (v) => Math.round(v * 100) + '%'),
      );
      const ch = this.game.audio.engineChoices(), rec = !!this.game.audio.bank;
      if (this.game.audio.ready) {
        body.append(this.select('Your engine sound', [['auto', 'By team'], ...ch], () => A.engineSound, (v) => { A.engineSound = v; }));
        body.append(this.toggle('Room reverb (not used on the Low profile)', () => A.reverb !== false, (v) => { A.reverb = v; }));
        body.append(el('div', 'sub', rec
          ? 'Engines marked V10/V8 with a year are cut from real Formula 1 recordings (CC BY-SA 3.0, "Edvvc", see public/audio/CREDITS.txt) and pitch-shifted to this simulator\'s rpm; the "(synth)" ones are computed by the game from a firing-order model and are not recordings.'
          : 'No recordings are installed: every engine here ("synth") is computed by the game from a firing-order model (V6 hybrid, V8, V10, V12). They follow rpm, throttle and gear changes but are not recordings of real cars. Room reverb applies after a restart of the session.'));
      } else body.append(el('div', 'sub', 'Press any button once to start the audio engine.'));
    } else if (tab === 'controls') {
      const C = D.controls;
      body.append(
        this.slider('Steering sensitivity', 0.4, 2, 0.05, () => C.steerSensitivity, (v) => { C.steerSensitivity = v; }, (v) => v.toFixed(2)),
        this.slider('Steering linearity (1 = linear)', 0.6, 2.2, 0.05, () => C.steerLinearity, (v) => { C.steerLinearity = v; }, (v) => v.toFixed(2)),
        this.slider('Keyboard steering speed', 1, 6, 0.1, () => C.keyboardSteerRate, (v) => { C.keyboardSteerRate = v; }, (v) => v.toFixed(1)),
        this.slider('Throttle linearity', 0.6, 2.2, 0.05, () => C.throttleLinearity, (v) => { C.throttleLinearity = v; }, (v) => v.toFixed(2)),
        this.slider('Brake linearity', 0.6, 2.2, 0.05, () => C.brakeLinearity, (v) => { C.brakeLinearity = v; }, (v) => v.toFixed(2)),
        this.slider('Gamepad dead zone', 0, 0.3, 0.01, () => C.deadzone, (v) => { C.deadzone = v; }, (v) => v.toFixed(2)),
        this.toggle('Vibration / haptics', () => C.haptics, (v) => { C.haptics = v; }),
      );
      const kl = el('div', 'keylist');
      for (const a of Object.keys(KEY_LABELS)) {
        const row = el('div', 'keyrow'); row.append(el('span', null, KEY_LABELS[a]));
        const b = el('button', null, D.keys[a].map((k) => k.replace('Key', '').replace('Arrow', '↔').replace('Bracket', '')).join(' / '));
        b.onclick = () => { b.textContent = 'press a key…'; this.game.input.startRebind(a, () => this.showSettings('controls', back)); };
        row.append(b); kl.appendChild(row);
      }
      body.append(el('h3', null, 'Keyboard'), kl, el('div', 'sub', 'Gamepad (standard layout): RT throttle, LT brake, left stick steers, RB/LB shift, X DRS, Y camera, A pit limiter, B replay, Start pauses, D-pad for brake bias, ERS and pit.'));
      const r = this.btn('Reset bindings and controls', () => { Object.assign(D.keys, JSON.parse(JSON.stringify(DEFAULT_KEYS))); this.settings.save(); this.game.input.rebuildKeymap(); this.showSettings('controls', back); }, 'small');
      body.append(r);
    } else {
      const C = D.controls, T = D.touch;
      body.append(
        this.select('Steering style', [['buttons', 'Left / right buttons (digital)'], ['wheel', 'Virtual wheel (analog, drag)']], () => C.touchMode, (v) => { C.touchMode = v; this.game.touch.apply(); }),
        this.toggle('Tilt steering (gyro)', () => C.tilt, (v) => { C.tilt = v; if (v) this.game.input.enableTilt(); this.game.touch.apply(); }),
        this.slider('Control opacity', 0.15, 1, 0.05, () => T.opacity, (v) => { T.opacity = v; this.game.touch.apply(); }, (v) => Math.round(v * 100) + '%'),
        this.slider('Control size', 0.6, 1.5, 0.05, () => T.scale, (v) => { T.scale = v; this.game.touch.apply(); }, (v) => v.toFixed(2)),
      );
      const row = el('div', 'row');
      row.append(this.btn('Edit button layout', () => { this.hide(); this.game.editTouchLayout(); }, 'small'), this.btn('Reset layout', () => { this.game.touch.resetLayout(); this.toast('Layout reset'); }, 'small ghost'));
      body.append(row, el('div', 'sub', 'In the editor, drag a button to move it and use the sliders to set its size and opacity. GAS (bottom right) and BRAKE (left of it) are hold buttons; steering is on the left. All buttons work together with multi-touch, and external gamepads work too.'));
    }
    const f = el('div', 'footer'); f.append(this.btn('Back', () => { this.settings.save(); this.game.input.rebuildKeymap(); this.game.hud.setScale(D.ui.hudScale); if (back) back(); else this.showMain(); }, 'small')); s.appendChild(f);
  }

  // ---------------------------------------------------------------- PAUSE
  showPause() {
    const s = this.show('dim');
    const rm = this.game.rm, p = rm && rm.player;
    const head = el('div', 'boardhead');
    if (p) {
      const race = rm.cfg.mode === 'race';
      head.innerHTML = pitBoard(race ? 'Race' : 'Session', '#' + (p.number ?? ''), [['P', p.pos || '-', '/' + rm.drivers.length], ['L', race ? Math.min(rm.totalLaps, p.lapsCompleted + 1) : p.lapsCompleted, race ? '/' + rm.totalLaps : '']]);
    }
    const tw = el('div'); tw.append(el('div', 'title', 'Paused'), el('div', 'sub', rm ? (CIRCUITS.find((c) => c.id === rm.cfg.trackId) || {}).name || '' : ''));
    head.append(tw); s.append(head);
    const m = el('div', 'menu');
    m.append(
      this.btn('Resume', () => this.game.resume(), 'primary'),
      this.btn('Restart session', () => this.game.restart()),
      this.btn('Settings', () => this.showSettings('graphics', () => this.showPause())),
      this.btn('Controls', () => this.showSettings('controls', () => this.showPause())),
      this.btn('Quit to main menu', () => this.game.quit()),
    );
    s.appendChild(m);
  }

  // ---------------------------------------------------------------- RESULTS
  showResults(rows, rm) {
    const mode = rm.cfg.mode;
    const s = this.show('solid');
    const title = { race: 'Race classification', quali: 'Qualifying result', practice: 'Practice result', timetrial: 'Time trial' }[mode];
    const me = rows.find((r) => r.driver.isPlayer);
    const head = el('div', 'boardhead');
    if (me) head.innerHTML = pitBoard(mode === 'race' ? 'Finish' : 'Result', '#' + (me.number ?? ''), [['P', me.status === 'dnf' ? 'DNF' : me.pos, '/' + rows.length]]);
    const tw = el('div'); tw.append(el('div', 'title', title));
    const tname = (CIRCUITS.find((c) => c.id === rm.cfg.trackId) || {}).name || '';
    tw.append(el('div', 'sub', me && isFinite(me.best) ? `${tname}. Your best lap: ${fmtTime(me.best)}` : tname));
    head.append(tw); s.append(head);
    const p = el('div', 'panel');
    const hdr = mode === 'race' ? '<tr><th>Pos</th><th>Driver</th><th>Team</th><th>Laps</th><th>Time / gap</th><th>Best</th><th>Stops</th><th>Pen</th><th>Pts</th></tr>' : '<tr><th>Pos</th><th>Driver</th><th>Team</th><th>Laps</th><th>Best lap</th><th>Gap</th></tr>';
    const lines = rows.map((r) => {
      const name = r.driver.isPlayer ? '<b>YOU</b>' : r.name;
      if (mode === 'race') {
        const t = r.status === 'dnf' ? 'DNF' : r.pos === 1 ? fmtTime(r.time) : r.gap != null ? '+' + r.gap.toFixed(3) : r.laps < rows[0].laps ? `+${rows[0].laps - r.laps} lap` : '-';
        return `<tr class="${r.driver.isPlayer ? 'me' : ''}"><td>${r.pos}</td><td>${name}</td><td class="tmc"><i style="background:${hex(r.team.color)}"></i>${r.team.name}</td><td>${r.laps}</td><td>${t}</td><td>${isFinite(r.best) ? fmtTime(r.best) : '-'}</td><td>${r.pits}</td><td>${r.penalty ? '+' + r.penalty + 's' : ''}</td><td>${r.points}</td></tr>`;
      }
      return `<tr class="${r.driver.isPlayer ? 'me' : ''}"><td>${r.pos}</td><td>${name}</td><td class="tmc"><i style="background:${hex(r.team.color)}"></i>${r.team.name}</td><td>${r.laps}</td><td>${isFinite(r.best) ? fmtTime(r.best) : '-'}</td><td>${isFinite(r.best) && r.gap ? '+' + r.gap.toFixed(3) : ''}</td></tr>`;
    });
    p.innerHTML = `<table class="table">${hdr}${lines.join('')}</table>`;
    s.appendChild(p);
    const f = el('div', 'footer');
    const champ = this.game.championship;
    if (mode === 'race' && this.game.inChampionship) f.append(this.btn('Championship standings', () => { this.game.finishChampionshipRound(rows); }, 'primary small'));
    else {
      if (mode === 'quali') f.append(this.btn('Race from this grid', () => this.game.startRaceFromQuali(rows), 'primary small'));
      f.append(this.btn('Restart', () => this.game.restart(), (mode === 'quali' ? '' : 'primary ') + 'small'));
    }
    f.append(this.btn('Watch replay', () => this.game.startReplay(), 'small'), this.btn('Main menu', () => this.game.quit(), 'small ghost'));
    s.appendChild(f);
  }
}

