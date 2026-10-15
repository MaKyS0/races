// End-to-end multi-touch test of the digital on-screen controls in (emulated) mobile Chromium with REAL touch events (CDP).
//   node scripts/touch-test.mjs      (needs `vite preview` on :4173)
import { launch } from './browser.mjs';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: UA });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://localhost:4173/?autostart=1&track=monza&ai=3&quality=low&camera=chase');
await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
const cdp = await ctx.newCDPSession(p);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const rect = (id) => p.evaluate((id) => { const r = document.querySelector(`.tctl[data-id="${id}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, id);
const st = () => p.evaluate(() => { const g = window.__game, i = g.input, c = g.rm.player.car; return { t: { ...i.touch }, thr: +i.state.throttle.toFixed(2), brk: +i.state.brake.toFixed(2), steer: +i.state.steer.toFixed(2), cThr: +c.ctrl.throttle.toFixed(2), cBrk: +c.ctrl.brake.toFixed(2), v: +c.speed.toFixed(1), phase: g.rm.phase }; });
const wait = (ms) => p.waitForTimeout(ms);
const results = []; const ok = (name, cond, extra = '') => { results.push([cond, name, extra]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

// get to the racing phase (lights out) so the car can move
await p.evaluate(() => { const g = window.__game; g.fastForward(14); });
await wait(300);
console.log('phase', (await st()).phase);

// ---------------------------------------------------------------- layout
const R = {}; for (const id of ['gas', 'brake', 'left', 'right']) R[id] = await rect(id);
ok('GAS is in the bottom-right area', R.gas.cx > 844 * 0.6 && R.gas.cy > 390 * 0.5, JSON.stringify({ x: R.gas.x | 0, y: R.gas.y | 0, w: R.gas.w | 0, h: R.gas.h | 0 }));
ok('BRAKE is left of GAS (same row)', R.brake.cx < R.gas.cx && Math.abs(R.brake.cy - R.gas.cy) < 60 && R.brake.x + R.brake.w <= R.gas.x + 4);
ok('steering is on the left side', R.left.cx < R.brake.cx && R.right.cx < R.brake.cx && R.left.cx < 844 * 0.35);
ok('buttons are large (>= 88 px)', [R.gas, R.brake, R.left, R.right].every((r) => r.w >= 88 && r.h >= 88), [R.gas, R.brake, R.left, R.right].map((r) => Math.round(r.w)).join('/'));
ok('no pedal bars / fill elements exist', (await p.evaluate(() => document.querySelectorAll('.tc-pedal, .tc-pedal .fill, .touch .fill').length)) === 0);
ok('buttons do not overlap each other', (() => { const a = [R.gas, R.brake, R.left, R.right]; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i].x < a[j].x + a[j].w && a[j].x < a[i].x + a[i].w && a[i].y < a[j].y + a[j].h && a[j].y < a[i].y + a[i].h) return false; return true; })());

// ---------------------------------------------------------------- GAS hold / release
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }]); await wait(500);
let s = await st();
for (let k = 0; k < 40 && s.v <= 1; k++) { await wait(100); s = await st(); }   // (software-GL frames are slow: give the simulation time to move)
ok('GAS held -> throttle on, car accelerates', s.t.gas && s.cThr > 0.9 && s.v > 1, JSON.stringify(s));
const v1 = s.v; await wait(500); s = await st(); ok('speed keeps rising while GAS is held', s.v > v1, `${v1} -> ${s.v}`);
await touch('touchEnd', []); await wait(300);
s = await st(); ok('GAS released -> throttle goes to 0', !s.t.gas && s.cThr < 0.05, JSON.stringify(s));
const v2 = s.v; await wait(500); s = await st(); ok('car coasts (still moving, slowly decelerating, no throttle)', s.v > 1 && s.v <= v2 + 0.5 && s.cThr < 0.05, `${v2} -> ${s.v}`);

// ---------------------------------------------------------------- GAS + steer together (two fingers)
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }, { x: R.left.cx, y: R.left.cy, id: 2 }]); await wait(600);
s = await st(); ok('GAS + LEFT at the same time (multi-touch)', s.t.gas && s.t.left && s.cThr > 0.9 && s.steer > 0.05, JSON.stringify(s));
// lift only the steering finger: gas must stay on
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }, { x: R.left.cx, y: R.left.cy, id: 2 }]);
await touch('touchEnd', [{ x: R.left.cx, y: R.left.cy, id: 2 }]); await wait(500);
s = await st(); ok('lifting the steering finger keeps GAS held', s.t.gas && !s.t.left && s.cThr > 0.9 && Math.abs(s.steer) < 0.3, JSON.stringify(s));
await touch('touchEnd', []); await wait(300);

// ---------------------------------------------------------------- BRAKE + steer together
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }]); await wait(900);
const vFast = (await st()).v;
await touch('touchEnd', []);
await touch('touchStart', [{ x: R.brake.cx, y: R.brake.cy, id: 3 }, { x: R.right.cx, y: R.right.cy, id: 4 }]); await wait(500);
s = await st(); ok('BRAKE + RIGHT at the same time (multi-touch)', s.t.brake && s.t.right && s.cBrk > 0.3 && s.steer < -0.05, JSON.stringify(s));
await wait(400); const s2 = await st(); ok('braking slows the car, not to a dead stop instantly', s2.v < vFast && s2.v > 0, `${vFast} -> ${s2.v}`);
await touch('touchEnd', []); await wait(400);
s = await st(); ok('BRAKE released -> brake force off', !s.t.brake && s.cBrk < 0.05, JSON.stringify(s));

// ---------------------------------------------------------------- stuck-key protection
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }, { x: R.brake.cx, y: R.brake.cy, id: 2 }]); await wait(300);
s = await st(); ok('(setup) GAS + BRAKE both held', s.t.gas && s.t.brake);
await p.evaluate(() => window.dispatchEvent(new Event('blur'))); await wait(300);
s = await st(); ok('window blur releases everything', !s.t.gas && !s.t.brake && s.cThr < 0.05 && s.cBrk < 0.05, JSON.stringify(s));
await touch('touchEnd', []);
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }]); await wait(300);
await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }); await wait(300);
s = await st(); ok('page hidden (app backgrounded) releases GAS', !s.t.gas && s.cThr < 0.05, JSON.stringify(s));
await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); window.__game.resume(); });
await touch('touchEnd', []);
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }]); await wait(300);
await touch('touchCancel', []); await wait(300);
s = await st(); ok('touchcancel (system gesture) releases GAS', !s.t.gas && s.cThr < 0.05, JSON.stringify(s));
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }]); await wait(300);
await p.evaluate(() => window.__game.pause()); await wait(200);
s = await st(); ok('pausing the game releases GAS', !s.t.gas && s.cThr < 0.05, JSON.stringify(s));
await touch('touchEnd', []);
await p.evaluate(() => window.__game.resume()); await wait(200);

// ---------------------------------------------------------------- finger slides off the button: capture keeps it held, no movement needed
await touch('touchStart', [{ x: R.gas.cx, y: R.gas.cy, id: 1 }]); await wait(200);
await touch('touchMove', [{ x: R.gas.cx - 150, y: R.gas.cy - 120, id: 1 }]); await wait(300);
s = await st(); ok('sliding the finger off the button does not change anything while it is down', s.t.gas && s.cThr > 0.9, JSON.stringify(s));
await touch('touchEnd', []); await wait(300);

// ---------------------------------------------------------------- layout editor: move / resize / opacity, persisted
await p.evaluate(() => { const g = window.__game; g.pause(); g.menu.hide(); g.editTouchLayout(); });
await wait(300);
const g0 = await rect('gas');
await touch('touchStart', [{ x: g0.cx, y: g0.cy, id: 7 }]); await touch('touchMove', [{ x: g0.cx - 80, y: g0.cy - 40, id: 7 }]); await touch('touchEnd', []); await wait(200);
const g1 = await rect('gas');
ok('editor: GAS can be dragged to a new position', Math.abs(g1.x - g0.x) > 40 && g1.y < g0.y - 15, `${g0.x | 0},${g0.y | 0} -> ${g1.x | 0},${g1.y | 0}`);
await p.evaluate(() => { const i = document.querySelector('.tce-size'); i.value = 1.5; i.dispatchEvent(new Event('input')); const o = document.querySelector('.tce-op'); o.value = 0.4; o.dispatchEvent(new Event('input')); });
await wait(100);
const g2 = await rect('gas');
ok('editor: size slider enlarges the button', g2.w > g1.w * 1.3, `${g1.w | 0} -> ${g2.w | 0}`);
await p.evaluate(() => document.querySelector('.tce-done').click()); await wait(200);
const op = await p.evaluate(() => getComputedStyle(document.querySelector('.tctl[data-id="gas"]')).opacity);
ok('editor: opacity slider changes the button opacity', Math.abs(+op - 0.6 * 0.4) < 0.06, 'opacity ' + op);
const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('apexgp.settings.v1')).touch);
ok('editor: layout is saved in the settings', saved.layout && saved.layout.gas && saved.layout.gas.s === 1.5 && saved.layoutV === 2, JSON.stringify(saved.layout && saved.layout.gas));

ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await p.screenshot({ path: 'build-output/touch-ui.png' });
const failed = results.filter((r) => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await b.close();
process.exit(failed ? 1 : 0);
