// Graphics review: captures a fixed set of menu / race / weather / camera / quality scenes in one headless Chromium
// (SwiftShader software GL - image based lighting is disabled there by Renderer.probeEnv(), so reflections differ from a GPU).
//   node scripts/gfx-shots.mjs <outDir> [filterRegex]      (needs `vite preview` on :4173)
// Prints one JSON line per scene with draw calls / triangles of the last rendered frame.
import { launch } from './browser.mjs';
import fs from 'node:fs';
const [outDir = 'build-output/gfx', filter = ''] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.URL || 'http://localhost:4173/';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const re = filter ? new RegExp(filter) : null;
const b = await launch();

const waitFrames = async (p, n = 3) => { const f0 = await p.evaluate(() => window.__game.perf.frames); await p.waitForFunction(([f, n]) => window.__game.perf.frames > f + n, [f0, n], { timeout: 120000 }); };
const info = (p) => p.evaluate(() => { const g = window.__game, i = g.renderer.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geoms: i.memory.geometries, tex: i.memory.textures, q: g.perf.qualityName() }; });

async function race(name, query, { ff = 30, cam = 'chase', w = 1280, h = 720, js = '', mobile = false } = {}) {
  if (re && !re.test(name)) return;
  const ctx = mobile ? await b.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: UA }) : await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.goto(`${BASE}?${query}&shot=1`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  await p.evaluate(() => { window.__glLost = 0; window.__game.canvas.addEventListener('webglcontextlost', () => { window.__glLost++; }); });
  await p.evaluate(([ff, cam, js]) => { const g = window.__game; if (ff > 0) g.fastForward(ff); g.camCtl.setMode(cam); g.camCtl.blend = 1; if (js) (0, eval)(js); }, [ff, cam, js]);
  await waitFrames(p, 4); await p.waitForTimeout(400);
  await p.screenshot({ path: `${outDir}/${name}.png` });
  console.log(JSON.stringify({ name, ...(await info(p)), glLost: await p.evaluate(() => window.__glLost), errs: errs.slice(0, 2) }));
  await ctx.close();
}

async function menus(prefix, quality, w, h, mobile = false) {
  if (re && !re.test(prefix)) return;
  const ctx = mobile ? await b.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: UA }) : await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.goto(`${BASE}?quality=${quality}&shot=1`); await p.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const shot = async (n) => { await waitFrames(p, 3); await p.waitForTimeout(250); await p.screenshot({ path: `${outDir}/${prefix}-${n}.png` }); };
  await shot('main');
  await p.evaluate(() => { window.__game.menu.tab = 'session'; window.__game.menu.showSetup(); }); await p.waitForTimeout(1200); await shot('setup');
  await p.evaluate(() => { window.__game.menu.tab = 'car'; window.__game.menu.showSetup(); }); await p.waitForTimeout(600); await shot('car');
  for (const t of [3, 8]) { await p.evaluate((t) => { const m = window.__game.menu; m.draftCfg().team = t; window.__game.previewTeam(t); m.showSetup(); }, t); await p.waitForTimeout(500); await shot('car' + t); }
  await p.evaluate(() => { window.__game.menu.tab = 'rules'; window.__game.menu.showSetup(); }); await p.waitForTimeout(400); await shot('rules');
  await p.evaluate(() => window.__game.menu.showSettings('graphics')); await p.waitForTimeout(400); await shot('settings');
  await p.evaluate(() => window.__game.menu.showSettings('touch')); await p.waitForTimeout(400); await shot('touchset');
  await p.evaluate(() => window.__game.menu.showChampionship()); await p.waitForTimeout(400); await shot('champ');
  console.log(JSON.stringify({ name: prefix, ...(await info(p)), errs: errs.slice(0, 2) }));
  await ctx.close();
}

// pause + results + replay on one session
async function flow(name, query, w = 1280, h = 720) {
  if (re && !re.test(name)) return;
  const ctx = await b.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}?${query}&shot=1`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  await p.evaluate(() => window.__game.fastForward(45)); await waitFrames(p, 3);
  await p.evaluate(() => window.__game.pause()); await waitFrames(p, 3); await p.waitForTimeout(300);
  await p.screenshot({ path: `${outDir}/${name}-pause.png` });
  await p.evaluate(() => { const g = window.__game; g.resume(); g.rm.finishSession(); g.showResults(); }); await waitFrames(p, 4); await p.waitForTimeout(800);
  await p.screenshot({ path: `${outDir}/${name}-results.png` });
  console.log(JSON.stringify({ name, state: await p.evaluate(() => window.__game.state), errs: errs.slice(0, 2) }));
  await ctx.close();
}

// js snippet: park a fixed camera at the pit boxes looking along the pit lane
const PITCAM = `(() => { const g = window.__game, t = g.rm.track, b = t.pitBoxes[8] || t.pitBoxes[0], i = Math.round(b.s / t.ds) % t.N; const P = t.pointAt(b.s - 34, t.pitSide * (t.pitOuter[i] - 7), { x: 0, y: 0, z: 0, psi: 0 }); const Q = t.pointAt(b.s + 6, t.pitSide * (t.pitOuter[i] + 3), { x: 0, y: 0, z: 0, psi: 0 }); g.camCtl.update = function () { const c = this.cam; c.position.set(P.x, P.y + 5.5, P.z); c.up.set(0, 1, 0); c.lookAt(Q.x, Q.y + 1.2, Q.z); c.fov = 55; c.updateProjectionMatrix(); }; })()`;
// js snippet: high camera over the back of the grid looking forward (grid boxes, slot numbers, gantry)
const GRIDTOP = `(() => { const g = window.__game, t = g.rm.track, s = t.gridSlot(15); const P = t.pointAt(s.s - 14, 0, { x: 0, y: 0, z: 0, psi: 0 }); const Q = t.pointAt(s.s + 40, 0, { x: 0, y: 0, z: 0, psi: 0 }); g.camCtl.update = function () { const c = this.cam; c.position.set(P.x, P.y + 9, P.z); c.up.set(0, 1, 0); c.lookAt(Q.x, Q.y, Q.z); c.fov = 50; c.updateProjectionMatrix(); }; })()`;
// js snippet: camera in front of the grid looking back at the field and the gantry
const GRIDCAM = `(() => { const g = window.__game, t = g.rm.track; const P = t.pointAt(40, 4, { x: 0, y: 0, z: 0, psi: 0 }); const Q = t.pointAt(-30, 0, { x: 0, y: 0, z: 0, psi: 0 }); g.camCtl.update = function () { const c = this.cam; c.position.set(P.x, P.y + 4.5, P.z); c.up.set(0, 1, 0); c.lookAt(Q.x, Q.y + 1.5, Q.z); c.fov = 55; c.updateProjectionMatrix(); }; })()`;

await menus('menu', 'high', 1280, 720);
await menus('menu-phone', 'low', 844, 390, true);
for (const q of ['low', 'medium', 'high']) await race(`grid-monza-${q}`, `autostart=1&track=monza&ai=15&quality=${q}`, { ff: 0.01, cam: 'chase' });
await race('gridtop-silverstone', 'autostart=1&track=silverstone&ai=7&quality=high', { ff: 0.01, js: GRIDTOP });
await race('lights-monza', 'autostart=1&track=monza&ai=15&quality=high', { ff: 3.2, cam: 'chase', js: GRIDCAM });
// AP = the player car is driven by the autopilot (bench mode) so race scenes show the car at speed in traffic
const AP = 'bench=1&seconds=99999&';
for (const t of ['monza', 'monaco', 'spa', 'silverstone', 'suzuka', 'bahrain']) await race(`dry-${t}`, `${AP}autostart=1&track=${t}&ai=15&quality=high`, { ff: 40 });
await race('rain-spa-heavy', `${AP}autostart=1&track=spa&ai=15&quality=high&weather=heavy`, { ff: 40 });
await race('rain-monza-heavy-medium', `${AP}autostart=1&track=monza&ai=15&quality=medium&weather=heavy`, { ff: 40 });
await race('rain-silverstone-light', `${AP}autostart=1&track=silverstone&ai=15&quality=high&weather=light`, { ff: 40 });
await race('cam-cockpit', `${AP}autostart=1&track=suzuka&ai=15&quality=high`, { ff: 30, cam: 'cockpit' });
await race('cam-tcam', `${AP}autostart=1&track=suzuka&ai=15&quality=high`, { ff: 30, cam: 'tcam' });
await race('pitlane', 'autostart=1&track=silverstone&ai=15&quality=high', { ff: 2, js: PITCAM });
await race('low-monza', `${AP}autostart=1&track=monza&ai=15&quality=low`, { ff: 40 });
await race('touch-hud', 'autostart=1&track=monaco&ai=9&quality=low', { ff: 30, w: 844, h: 390, mobile: true });
await flow('flow', 'autostart=1&track=bahrain&ai=9&quality=medium&laps=1');
await b.close();
