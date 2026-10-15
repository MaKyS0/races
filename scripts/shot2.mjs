// Scripted scene screenshot: node scripts/shot2.mjs "<query>" out.png ffSeconds [camera] [w] [h] [js-to-eval]
import { launch } from './browser.mjs';
const [query, out, ff = '30', cam = 'chase', w = '960', h = '540', js = ''] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[' + m.type() + ']', m.text().slice(0, 400)); });
p.on('pageerror', (e) => console.log('[pageerror]', e.message, (e.stack || '').split('\n')[1]));
await p.goto((process.env.URL || 'http://localhost:4173/') + '?' + query + '&shot=1');
await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
await p.evaluate(([ff, cam, js]) => { const g = window.__game; g.fastForward(+ff); g.camCtl.setMode(cam); g.camCtl.blend = 1; g.settings.data.ui.fps = true; if (js) eval(js); }, [ff, cam, js]);
const f0 = await p.evaluate(() => window.__game.perf.frames);
await p.waitForFunction((f) => window.__game.perf.frames > f + 3, f0, { timeout: 120000 });
await p.waitForTimeout(300);
await p.screenshot({ path: out });
const info = await p.evaluate(() => { const g = window.__game, rm = g.rm; return { sim: +rm.simTime.toFixed(1), phase: rm.phase, flag: rm.flag, pos: rm.player.pos, calls: g.renderer.renderer.info.render.calls, tris: g.renderer.renderer.info.render.triangles, retired: rm.cars.filter(c => c.retired).length }; });
console.log(JSON.stringify(info));
await b.close();
