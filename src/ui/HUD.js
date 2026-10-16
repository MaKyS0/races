// HUD: DOM-based race HUD. Elements are created once; per-frame updates only touch text/styles that changed, at 20-30 Hz.
import { fmtTime, clamp } from '../core/math.js';
import { COMPOUNDS } from '../physics/TireModel.js';
import { RPM_LIMIT } from '../physics/EngineAndTransmission.js';
import { TEAMS } from '../race/Roster.js';

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const CHAR = { soft: 'S', medium: 'M', hard: 'H', inter: 'I', wet: 'W' };

function tempColor(t, opt) {
  const d = t - opt;
  if (d < -35) return '#3d8bff'; if (d < -15) return '#46c3e0'; if (d < 25) return '#3dd47d'; if (d < 45) return '#ffc233'; return '#ff4d3d';
}
function brakeColor(t) { if (t < 250) return '#3d8bff'; if (t < 500) return '#3dd47d'; if (t < 800) return '#ffc233'; if (t < 1000) return '#ff8a2b'; return '#ff4d3d'; }

export class HUD {
  constructor(root, settings) {
    this.settings = settings;
    this.root = h('div', 'hud'); root.appendChild(this.root);
    this.cache = {};
    this.acc = 0; this.tAcc = 0;
    this.mapCanvas = null; this.mapBg = null;
    this.build();
  }
  set(key, el, value, prop = 'textContent') {
    if (this.cache[key] !== value) { this.cache[key] = value; el[prop] = value; }
  }
  build() {
    const R = this.root;
    // ---- top left: the pit board (position / lap / gap) + conditions
    const tl = h('div', 'hud-tl');
    const board = h('div', 'pitboard');
    this.elSession = h('span', null, ''); this.elBoardT = h('i', null, '');
    const head = h('div', 'pb-head'); head.append(this.elSession, this.elBoardT);
    this.elPos = h('span', 'big', '1'); this.elPosOf = h('span', 'small', '/20');
    this.elLap = h('span', 'big', '1'); this.elLapOf = h('span', 'small', '/3');
    const pbox = h('div', 'slot'); pbox.append(h('span', 'k', 'P'), this.elPos, this.elPosOf);
    const lbox = h('div', 'slot'); lbox.append(h('span', 'k', 'L'), this.elLap, this.elLapOf);
    this.elGapK = h('span', 'gk', ''); this.elGap = h('b', null, '');
    const gbox = h('div', 'slot gapslot'); gbox.append(this.elGapK, this.elGap);
    board.append(head, pbox, lbox, gbox);
    this.elWeather = h('div', 'weather', '');
    this.elPenalty = h('div', 'penalty', '');
    tl.append(board, this.elWeather, this.elPenalty);
    R.appendChild(tl);
    // ---- timing tower
    this.tower = h('div', 'tower'); R.appendChild(this.tower);
    this.towerRows = [];
    for (let i = 0; i < 11; i++) {
      const r = h('div', 'trow'); const p = h('span', 'tp'), c = h('span', 'tc'), n = h('span', 'tn'), g = h('span', 'tg'), t = h('span', 'tt');
      r.append(p, c, n, g, t); this.tower.appendChild(r); this.towerRows.push({ r, p, c, n, g, t });
    }
    // ---- top center: start lights, flag banner, messages
    const tc = h('div', 'hud-tc');
    this.lightsEl = h('div', 'lights'); this.lightEls = [];
    for (let i = 0; i < 5; i++) { const l = h('div', 'lamp'); this.lightsEl.appendChild(l); this.lightEls.push(l); }
    this.elFlag = h('div', 'flagbar', ''); this.elMsgs = h('div', 'msgs');
    this.elCountdown = h('div', 'sessiontime', '');
    tc.append(this.lightsEl, this.elFlag, this.elCountdown, this.elMsgs); R.appendChild(tc);
    // ---- top right: minimap + lap times
    const tr = h('div', 'hud-tr');
    this.mapCanvas = h('canvas', 'map'); this.mapCanvas.width = 220; this.mapCanvas.height = 220;
    this.mapCtx = this.mapCanvas.getContext('2d');
    this.times = h('div', 'times');
    this.elCur = h('div', 'tcur'); this.elLast = h('div', 'tlast'); this.elBest = h('div', 'tbest'); this.elDelta = h('div', 'tdelta');
    this.sectors = h('div', 'sectors'); this.sectorEls = [h('span'), h('span'), h('span')]; this.sectors.append(...this.sectorEls);
    this.times.append(this.elCur, this.elLast, this.elBest, this.elDelta, this.sectors);
    tr.append(this.mapCanvas, this.times); R.appendChild(tr);
    // ---- bottom centre: shift lights + speed + gear + rpm
    const bc = h('div', 'hud-bc');
    this.shiftLights = h('div', 'shiftlights'); this.shiftEls = [];
    for (let i = 0; i < 15; i++) { const s = h('i'); this.shiftLights.appendChild(s); this.shiftEls.push(s); }
    const dash = h('div', 'dash');
    this.elSpeed = h('div', 'speed', '0'); this.elUnit = h('div', 'unit', 'km/h'); this.elGear = h('div', 'gear', 'N');
    this.elRpm = h('div', 'rpm', '0'); this.elDrs = h('div', 'drs', 'DRS'); this.elLim = h('div', 'lim', 'Pit limiter');
    const left = h('div', 'dl'); left.append(this.elGear, this.elDrs);
    const mid = h('div', 'dm'); mid.append(this.elSpeed, this.elUnit);
    const right = h('div', 'dr'); right.append(this.elRpm, h('div', 'unit', 'rpm'));
    dash.append(left, mid, right);
    // energy / fuel bars
    const bars = h('div', 'bars');
    this.ersBar = h('div', 'bar ers'); this.ersFill = h('div', 'fill'); this.ersBar.append(h('span', null, 'ERS'), this.ersFill); this.ersTxt = h('b');
    this.ersBar.append(this.ersTxt);
    this.fuelBar = h('div', 'bar fuel'); this.fuelFill = h('div', 'fill'); this.fuelTxt = h('b'); this.fuelBar.append(h('span', null, 'Fuel'), this.fuelFill, this.fuelTxt);
    bars.append(this.ersBar, this.fuelBar);
    bc.append(this.shiftLights, dash, this.elLim, bars); R.appendChild(bc);
    // ---- bottom left: one top-view of the car - tyres (temperature ring, wear fill, brake strip) sit on the wheels, damage colours the parts
    const bl = h('div', 'hud-bl');
    const stat = h('div', 'carstat'), box = h('div', 'carbox');
    this.dmgSvg = h('div', 'dmg');
    this.dmgSvg.innerHTML = `<svg viewBox="0 0 60 100" width="100%" height="100%">
      <rect id="d-fwl" x="4" y="1" width="25" height="6" rx="1"/><rect id="d-fwr" x="31" y="1" width="25" height="6" rx="1"/>
      <rect id="d-body" x="22" y="9" width="16" height="70" rx="7"/>
      <rect id="d-w0" x="-1" y="12" width="21" height="27" rx="3"/><rect id="d-w1" x="40" y="12" width="21" height="27" rx="3"/>
      <rect id="d-w2" x="-1" y="54" width="21" height="27" rx="3"/><rect id="d-w3" x="40" y="54" width="21" height="27" rx="3"/>
      <rect id="d-rw" x="12" y="92" width="36" height="7" rx="1"/><rect id="d-floor" x="16" y="81" width="28" height="9" rx="2"/></svg>`;
    this.dmgEls = {}; for (const id of ['fwl', 'fwr', 'body', 'w0', 'w1', 'w2', 'w3', 'rw', 'floor']) this.dmgEls[id] = this.dmgSvg.querySelector('#d-' + id);
    this.tyreBox = h('div', 'tyres'); this.tyreEls = [];
    for (let i = 0; i < 4; i++) {
      const t = h('div', 'tyre'); const w = h('div', 'wear'), tx = h('div', 'ttxt'), br = h('div', 'brk');
      t.append(w, br, tx); this.tyreBox.appendChild(t); this.tyreEls.push({ t, w, tx, br });
    }
    box.append(this.dmgSvg, this.tyreBox);
    this.compEl = h('div', 'comp'); this.compAge = h('div', 'compage');
    stat.append(box, this.compEl, this.compAge);
    bl.append(stat); R.appendChild(bl);
    // ---- bottom right: pedals + driver aids
    const br = h('div', 'hud-br');
    const peds = h('div', 'peds'); this.thrBar = h('div', 'pedal thr'); this.brkBar = h('div', 'pedal brk'); this.thrFill = h('div', 'fill'); this.brkFill = h('div', 'fill');
    this.thrBar.appendChild(this.thrFill); this.brkBar.appendChild(this.brkFill);
    this.steerBar = h('div', 'steerbar'); this.steerDot = h('div', 'dot'); this.steerBar.appendChild(this.steerDot);
    peds.append(this.brkBar, this.thrBar);
    this.chips = h('div', 'chips');
    this.chipEls = {}; for (const k of ['ABS', 'TC', 'STEER', 'AUTO', 'ERS', 'BB', 'DIFF']) { const c = h('div', 'chip', k); this.chips.appendChild(c); this.chipEls[k] = c; }
    this.elNext = h('div', 'next');
    br.append(this.steerBar, peds, this.chips, this.elNext); R.appendChild(br);
    // ---- pit request compound chips
    this.pitPanel = h('div', 'pitpanel hidden'); this.pitChips = {};
    for (const id of ['soft', 'medium', 'hard', 'inter', 'wet']) { const c = h('button', 'pchip', CHAR[id]); c.style.setProperty('--c', COMPOUNDS[id].color); c.dataset.c = id; this.pitPanel.appendChild(c); this.pitChips[id] = c; }
    R.appendChild(this.pitPanel);
    this.pitPanel.addEventListener('click', (e) => { const c = e.target.closest('button'); if (c && this.onPitCompound) this.onPitCompound(c.dataset.c); });
    // ---- big center messages
    this.elBig = h('div', 'bigmsg hidden'); R.appendChild(this.elBig);
    this.elFps = h('div', 'fps hidden'); R.appendChild(this.elFps);
    this.elBlue = h('div', 'bluef hidden', 'Blue flag: let the leader through'); R.appendChild(this.elBlue);
  }

  setScale(s) { this.root.style.setProperty('--hs', s); }

  buildMap(track) {
    this.mapTrack = track;
    const c = document.createElement('canvas'); c.width = this.mapCanvas.width; c.height = this.mapCanvas.height;
    const g = c.getContext('2d');
    const b = track.bounds, pad = 14, W = c.width;
    const sc = (W - 2 * pad) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const ox = pad + ((W - 2 * pad) - (b.maxX - b.minX) * sc) / 2, oz = pad + ((W - 2 * pad) - (b.maxZ - b.minZ) * sc) / 2;
    this.mapT = { sc, ox, oz, b };
    const X = (x) => ox + (x - b.minX) * sc, Y = (z) => W - oz - (z - b.minZ) * sc;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(12,13,15,0.75)'; g.lineWidth = 10; g.beginPath();
    for (let i = 0; i <= track.N; i += 3) { const k = i % track.N; if (i === 0) g.moveTo(X(track.x[k]), Y(track.z[k])); else g.lineTo(X(track.x[k]), Y(track.z[k])); } g.closePath(); g.stroke();
    g.strokeStyle = '#f2efe6'; g.lineWidth = 4.5; g.stroke();
    // DRS zones
    g.strokeStyle = '#3dd47d'; g.lineWidth = 4.5;
    for (const z of track.drsZones) { g.beginPath(); for (let d = 0; d <= z.length; d += 20) { const s = (z.start + d) % track.length; const k = Math.round(s / track.ds) % track.N; if (d === 0) g.moveTo(X(track.x[k]), Y(track.z[k])); else g.lineTo(X(track.x[k]), Y(track.z[k])); } g.stroke(); }
    // start/finish
    { const k0 = 0, k1 = 4 % track.N, a = Math.atan2(-(track.z[k1] - track.z[k0]), track.x[k1] - track.x[k0]);
      g.save(); g.translate(X(track.x[0]), Y(track.z[0])); g.rotate(a + Math.PI / 2);
      for (let q = 0; q < 4; q++) { g.fillStyle = q % 2 ? '#141518' : '#f2efe6'; g.fillRect(-8 + q * 4, -2.5, 4, 5); } g.restore(); }
    // sector marks: short ticks across the line
    g.strokeStyle = '#9aa3ad'; g.lineWidth = 2;
    for (const s of track.sectors) { const k = Math.round(s / track.ds) % track.N, k1 = (k + 3) % track.N; const dx = X(track.x[k1]) - X(track.x[k]), dy = Y(track.z[k1]) - Y(track.z[k]), l = Math.hypot(dx, dy) || 1; g.beginPath(); g.moveTo(X(track.x[k]) - dy / l * 7, Y(track.z[k]) + dx / l * 7); g.lineTo(X(track.x[k]) + dy / l * 7, Y(track.z[k]) - dx / l * 7); g.stroke(); }
    this.mapBg = c;
  }

  update(rm, dt, input, perf, opts = {}) {
    this.tAcc += dt;
    const player = rm.player;
    if (!player) return;
    const car = player.car;
    const kmh = this.settings.data.ui.units !== 'mph';
    // ---- fast elements: speed, gear, rpm, shift lights, pedals
    const sp = car.speed * (kmh ? 3.6 : 2.23694);
    this.set('spd', this.elSpeed, Math.round(sp).toString());
    this.set('unit', this.elUnit, kmh ? 'km/h' : 'mph');
    const g = car.pt.gear;
    this.set('gear', this.elGear, car.speed < 0.5 && g === 1 ? 'N' : String(g));
    const rpm = car.pt.rpm;
    this.set('rpm', this.elRpm, Math.round(rpm / 10) * 10 + '');
    const lit = clamp(Math.floor(((rpm - 9500) / (RPM_LIMIT - 9500)) * 15 + 0.5), 0, 15);
    if (this.cache.shift !== lit) {
      this.cache.shift = lit;
      for (let i = 0; i < 15; i++) this.shiftEls[i].className = i < lit ? (i < 5 ? 'on g' : i < 10 ? 'on r' : 'on b') : '';
      this.shiftLights.classList.toggle('limit', lit >= 15);
    }
    this.thrFill.style.transform = `scaleY(${car.ctrl.throttle.toFixed(2)})`;
    this.brkFill.style.transform = `scaleY(${car.ctrl.brake.toFixed(2)})`;
    this.steerDot.style.transform = `translateX(${(-car.ctrl.steer * 48).toFixed(1)}px)`;
    // ---- slower HUD refresh (12 Hz)
    this.mapAcc = (this.mapAcc || 0) + dt;
    if (this.mapAcc > 0.09) { this.mapAcc = 0; this.drawMap(rm); }
    if (this.tAcc < 0.08) return;
    this.tAcc = 0;
    const mode = rm.cfg.mode;
    this.set('pos', this.elPos, String(player.pos));
    this.set('posOf', this.elPosOf, '/' + rm.drivers.length);
    const lap = mode === 'race' ? Math.min(rm.totalLaps, player.lapsCompleted + 1) : player.lapsCompleted + (player.timing ? 1 : 0);
    this.set('lap', this.elLap, String(lap || (mode === 'race' ? 1 : '-')));
    this.set('lapOf', this.elLapOf, mode === 'race' ? '/' + rm.totalLaps : '');
    // session label + car number on the board, interval to the car ahead
    const w = rm.weather;
    this.set('sess', this.elSession, this.sessionLabel(rm));
    this.set('num', this.elBoardT, '#' + (player.number ?? ''));
    if (this.cache.team !== player.team) { this.cache.team = player.team; document.documentElement.style.setProperty('--team', '#' + player.team.color.toString(16).padStart(6, '0')); }
    let gk = '', gv = '';
    if (player.pos > 1) {
      if (mode === 'race') { if (player.leaderLapsDown > 0) { gk = 'Leader'; gv = `+${player.leaderLapsDown}L`; } else if (rm.phase === 'racing' || rm.phase === 'finishing') { gk = 'Ahead'; gv = '+' + player.interval.toFixed(1); } }
      else if (isFinite(player.best) && player.gapLeader > 0) { gk = 'To P1'; gv = '+' + player.gapLeader.toFixed(3); }
    }
    this.set('gk', this.elGapK, gk); this.set('gv', this.elGap, gv);
    const sky = w.rain > 0.05 ? (w.rain > 0.6 ? 'Heavy rain' : 'Light rain') : w.cloud > 0.5 ? 'Overcast' : 'Dry';
    this.set('wx', this.elWeather, `<span><b>${sky}</b></span><span>Air ${w.tAir.toFixed(0)}°</span><span>Track ${w.tTrack.toFixed(0)}°</span>${w.water > 0.02 ? `<span>Water ${(w.water * 100).toFixed(0)}%</span>` : ''}`, 'innerHTML');
    this.set('pen', this.elPenalty, player.penaltySec > 0 ? `+${player.penaltySec}s penalty` : '');
    // timing
    const t = rm.time;
    const cur = (mode === 'race' || player.timing) ? t - player.lapStart : 0;
    const NONE = '-:--.---';
    this.set('cur', this.elCur, `<small>Lap</small> <span>${mode === 'race' || player.timing ? fmtTime(cur) : NONE}</span>`, 'innerHTML');
    this.set('last', this.elLast, `<small>Last</small> <span>${isFinite(player.last) ? fmtTime(player.last) : NONE}${player.lastValid === false ? ' <i>deleted</i>' : ''}</span>`, 'innerHTML');
    this.set('best', this.elBest, `<small>Best</small> <b>${isFinite(player.best) ? fmtTime(player.best) : NONE}</b>`, 'innerHTML');
    const dlt = player.bestTrace ? player.delta : null;
    this.set('delta', this.elDelta, dlt == null ? '' : `<span class="${dlt <= 0 ? 'good' : 'bad'}">${fmtTime(dlt, true)}</span>`, 'innerHTML');
    for (let i = 0; i < 3; i++) {
      const v = player.lastSectors[i], b = player.bestSectors[i];
      this.set('sec' + i, this.sectorEls[i], v > 0 ? v.toFixed(2) : `S${i + 1}`);
      const sc = v > 0 ? (b === v ? 'pb' : 'done') : '';
      if (this.cache['secc' + i] !== sc) { this.cache['secc' + i] = sc; this.sectorEls[i].className = sc; }
    }
    // flags / lights / messages
    this.drawFlags(rm, player);
    this.drawMessages(rm);
    this.drawTower(rm, player);
    // tyres, brakes, damage
    this.drawCar(car, player, rm);
    // bars
    const ers = car.pt.ers / 4e6;
    this.ersFill.style.transform = `scaleX(${ers.toFixed(2)})`;
    this.set('ersT', this.ersTxt, ['Harvest', 'Balanced', 'Attack'][car.pt.ersMode] + '  ' + Math.round(ers * 100) + '%');
    const fuelMax = Math.max(1, rm.fuelFor(mode === 'race' ? rm.cfg.laps : 20, 3));
    this.fuelFill.style.transform = `scaleX(${clamp(car.pt.fuel / fuelMax, 0, 1).toFixed(2)})`;
    const perLap = Math.max(0.1, (fuelMax - car.pt.fuel) / Math.max(0.2, player.lapsCompleted + (player.progress / rm.track.length - player.lapsCompleted)));
    this.set('fuelT', this.fuelTxt, car.pt.fuel.toFixed(1) + ' kg');
    // drs / limiter / aids
    const drsOn = car.aero.drsOpen > 0.5;
    const drsAv = car.drsAllowed;
    this.set('drs', this.elDrs, 'DRS'); const dcls = 'drs ' + (drsOn ? 'open' : drsAv ? 'ready' : '');
    if (this.cache.drsc !== dcls) { this.cache.drsc = dcls; this.elDrs.className = dcls; }
    const lcls = 'lim' + (car.limiterActive ? ' on' : '');
    if (this.cache.limc !== lcls) { this.cache.limc = lcls; this.elLim.className = lcls; }
    const A = car.assists;
    this.chip('ABS', A.abs > 0, car.absActive ? 'act' : '', A.abs > 0 ? 'ABS' + A.abs : 'ABS off');
    this.chip('TC', A.tc > 0, car.tcActive ? 'act' : '', A.tc > 0 ? 'TC' + A.tc : 'TC off');
    this.chip('STEER', A.steer > 0, '', A.steer > 0 ? 'STR' + A.steer : 'STR off');
    this.chip('AUTO', A.autoGear, '', A.autoGear ? 'AUTO' : 'MAN');
    this.chip('ERS', true, '', '');
    this.chipEls.ERS.textContent = 'ERS ' + ['H', 'B', 'A'][car.pt.ersMode];
    this.chipEls.BB.textContent = 'BB ' + (car.setup.brakeBias * 100).toFixed(1);
    this.chipEls.DIFF.textContent = 'DIFF ' + Math.round(car.setup.diffPreload);
    // pit request panel
    const wantPit = player.wantPit && !player.service;
    this.pitPanel.classList.toggle('hidden', !wantPit);
    if (wantPit) for (const id in this.pitChips) this.pitChips[id].classList.toggle('sel', player.nextCompound === id);
    // lapped-car blue flag
    this.elBlue.classList.toggle('hidden', !opts.blueFlag);
    if (opts.fps) { this.elFps.classList.remove('hidden'); this.set('fps', this.elFps, `${perf.fps.toFixed(0)} fps  ${perf.frameMs.toFixed(1)} ms  phys ${perf.physMs.toFixed(2)}  draw ${perf.renderMs.toFixed(1)}  res ${(perf.scale * 100).toFixed(0)}%  gov ${perf.level}${perf.heapMB ? '  heap ' + perf.heapMB.toFixed(0) + ' MB' : ''}`); }
    else this.elFps.classList.add('hidden');
  }
  chip(k, on, extra, txt) { const e = this.chipEls[k]; const cls = 'chip' + (on ? ' on' : '') + (extra ? ' ' + extra : ''); if (this.cache['c' + k] !== cls) { this.cache['c' + k] = cls; e.className = cls; } if (txt) this.set('ct' + k, e, txt); }

  sessionLabel(rm) {
    const m = rm.cfg.mode;
    if (m === 'race') return rm.phase === 'grid' ? 'Grid' : rm.phase === 'formation' ? 'Formation' : rm.phase === 'finishing' || rm.phase === 'finished' ? 'Finish' : 'Race';
    if (m === 'quali') return 'Qualifying';
    if (m === 'practice') return 'Practice';
    return 'Time trial';
  }
  drawFlags(rm, player) {
    // start lights
    const showLights = rm.phase === 'lights';
    this.lightsEl.style.display = showLights ? 'flex' : 'none';
    if (showLights) { const n = rm.lights; if (this.cache.lights !== n) { this.cache.lights = n; this.lightEls.forEach((l, i) => l.classList.toggle('on', i < n)); } }
    let text = '', cls = 'flagbar';
    const car = player.car;
    if (rm.chequered) { text = 'Chequered flag'; cls += ' chq'; }
    else if (rm.sc) { text = rm.sc.ending ? 'Safety car in this lap' : 'Safety car'; cls += ' sc'; }
    else if (rm.vsc) { text = 'Virtual safety car'; cls += ' vsc'; }
    else if (rm.inYellow(car.loc.s)) { text = 'Yellow flag: no overtaking'; cls += ' yellow'; }
    if (this.cache.flag !== text) { this.cache.flag = text; this.elFlag.textContent = text; }
    if (this.cache.flagc !== cls) { this.cache.flagc = cls; this.elFlag.className = cls; }
    // session countdown (practice / qualifying)
    let cd = '';
    if (rm.sessionLength > 0 && rm.phase !== 'finished') { const left = Math.max(0, rm.sessionLength - rm.time); cd = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`; }
    this.set('cd', this.elCountdown, cd);
  }
  drawMessages(rm) {
    const key = rm.messages.map((m) => m.text).join('|');
    if (this.cache.msgs === key) return;
    this.cache.msgs = key;
    this.elMsgs.innerHTML = rm.messages.slice(-4).map((m) => `<div class="msg ${m.level}">${m.text}</div>`).join('');
  }
  drawTower(rm, player) {
    const order = rm.order, n = order.length;
    const shown = [];
    const maxRows = this.towerRows.length;
    const top = Math.min(n, rm.cfg.mode === 'race' ? 8 : 6);
    for (let i = 0; i < top; i++) shown.push(i);
    if (player.pos > top) { if (player.pos - 1 > top) shown.push(-1); shown.push(player.pos - 1); }
    if (player.pos <= n - 1 && shown.length < maxRows && player.pos >= top) { /* nothing */ }
    for (let k = 0; k < this.towerRows.length; k++) {
      const row = this.towerRows[k]; const idx = shown[k];
      if (idx === undefined) { row.r.style.display = 'none'; continue; }
      row.r.style.display = '';
      if (idx === -1) { row.p.textContent = ''; row.c.style.background = 'transparent'; row.n.textContent = '…'; row.g.textContent = ''; row.t.textContent = ''; row.t.className = ''; row.r.className = 'trow gap'; continue; }
      const d = order[idx]; const car = d.car;
      row.p.textContent = idx + 1;
      row.c.style.background = '#' + d.team.color.toString(16).padStart(6, '0');
      row.n.textContent = d.isPlayer ? 'YOU' : d.short;
      let gp = '';
      if (rm.cfg.mode === 'race') {
        if (d.status === 'dnf') gp = 'OUT';
        else if (idx === 0) gp = d.lapsCompleted > 0 ? 'Lead' : '';
        else gp = d.leaderLapsDown > 0 ? `+${d.leaderLapsDown}L` : '+' + d.interval.toFixed(1);
      } else gp = isFinite(d.best) ? (idx === 0 ? fmtTime(d.best) : '+' + d.gapLeader.toFixed(3)) : '—';
      row.g.textContent = gp;
      const cid = car.compound.id;
      row.t.textContent = car.inPit ? 'PIT' : CHAR[cid];
      row.t.className = car.inPit ? 'tt pit' : 'tt';
      row.t.style.color = COMPOUNDS[cid].color;
      row.r.className = 'trow' + (d.isPlayer ? ' me' : '') + (d.status === 'dnf' ? ' out' : '');
    }
  }
  drawCar(car, player, rm) {
    for (let i = 0; i < 4; i++) {
      const t = car.tires[i], el = this.tyreEls[i];
      const Tm = 0.65 * t.tSurf + 0.35 * t.tCore;
      el.t.style.setProperty('--tc', t.puncture > 0.3 ? '#ff2a2a' : tempColor(Tm, t.compound.tOpt));
      el.w.style.height = (100 - t.wear * 100).toFixed(0) + '%';
      this.set('tt' + i, el.tx, t.puncture > 0.25 ? 'Flat' : Math.round(t.tSurf) + '°');
      const bt = car.brakes.temp[i];
      el.br.style.background = brakeColor(bt);
      el.br.title = Math.round(bt) + '°C';
    }
    const c = car.compound;
    this.set('comp', this.compEl, `<i style="color:${c.color}"></i>${c.name}`, 'innerHTML');
    const wearAvg = car.tires.reduce((a, t) => a + t.wear, 0) / 4;
    this.set('wearAvg', this.compAge, `${(wearAvg * 100).toFixed(0)}% worn`);
    const d = car.damage;
    const col = (v) => v < 0.05 ? '#4a4f57' : v < 0.4 ? '#ffc233' : v < 0.8 ? '#ff8a2b' : '#ff4d3d';   // intact parts stay neutral: colour only when something is wrong
    const E = this.dmgEls;
    E.fwl.style.fill = col(d.fwL); E.fwr.style.fill = col(d.fwR); E.rw.style.fill = col(d.rw); E.floor.style.fill = col(d.floor); E.body.style.fill = col(d.chassis);
    for (let i = 0; i < 4; i++) E['w' + i].style.fill = d.wheelOff[i] ? '#0c0c0e' : col(Math.max(d.sus[i], car.tires[i].puncture));
    if (car.retired) this.showBig(`Retired: ${car.retireReason}`, 'bad'); else if (this.cache.bigTxt && this.cache.bigKind === 'bad') this.showBig('');
  }
  showBig(text, kind = '') {
    if (this.cache.bigTxt === text) return;
    this.cache.bigTxt = text; this.cache.bigKind = kind;
    this.elBig.textContent = text; this.elBig.className = 'bigmsg ' + kind + (text ? '' : ' hidden');
  }

  drawMap(rm) {
    if (!this.mapBg) return;
    const g = this.mapCtx, W = this.mapCanvas.width, { sc, ox, oz, b } = this.mapT;
    const X = (x) => ox + (x - b.minX) * sc, Y = (z) => W - oz - (z - b.minZ) * sc;
    g.clearRect(0, 0, W, W); g.drawImage(this.mapBg, 0, 0);
    let me = null;
    g.lineWidth = 1.5; g.strokeStyle = '#141518';
    for (const d of rm.drivers) {
      const car = d.car; if (car.removed) continue;
      if (d.isPlayer) { me = d; continue; }
      g.fillStyle = car.retired ? '#55595f' : '#' + d.team.color.toString(16).padStart(6, '0');
      g.beginPath(); g.arc(X(car.x), Y(car.z), 4.2, 0, 6.3); g.fill(); g.stroke();
    }
    if (me) {   // the player on top: chalk plate with the team colour inside
      const c = me.car; g.fillStyle = '#f2efe6'; g.beginPath(); g.arc(X(c.x), Y(c.z), 7, 0, 6.3); g.fill();
      g.fillStyle = '#' + me.team.color.toString(16).padStart(6, '0'); g.beginPath(); g.arc(X(c.x), Y(c.z), 3.6, 0, 6.3); g.fill();
    }
    if (rm.sc) { const p = rm.track.pointAt(rm.sc.s, 0, { x: 0, y: 0, z: 0, psi: 0 }); g.fillStyle = '#ff9a1f'; g.fillRect(X(p.x) - 4, Y(p.z) - 4, 8, 8); }
    for (const y of rm.yellows) { const p = rm.track.pointAt(y.hazard.s, 0, { x: 0, y: 0, z: 0, psi: 0 }); g.fillStyle = '#ffc233'; g.beginPath(); g.moveTo(X(p.x), Y(p.z) - 8); g.lineTo(X(p.x) + 7, Y(p.z) + 5); g.lineTo(X(p.x) - 7, Y(p.z) + 5); g.fill(); }
  }
  show(on) { this.root.style.display = on ? '' : 'none'; }
}
