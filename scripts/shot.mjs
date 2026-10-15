// Headless smoke test + screenshots: node scripts/shot.mjs "<query>" out.png [waitMs] [width] [height]
import { launch } from './browser.mjs';
const [query = 'autostart=1', out = 'build-output/shot.png', wait = '8000', w = '1280', h = '720'] = process.argv.slice(2);
const base = process.env.URL || 'http://localhost:4173/';
const b = await launch();
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('BENCH')) console.log('[console.' + m.type() + ']', t.slice(0, 600)); });
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')); });
await p.goto(base + '?' + query, { waitUntil: 'load' });
await p.waitForTimeout(+wait);
await p.screenshot({ path: out });
const info = await p.evaluate(() => { const g = window.__game; return g ? { state: g.state, fps: g.perf.fps, frameMs: g.perf.frameMs, scale: g.perf.scale, q: g.perf.qualityName(), simTime: g.rm ? g.rm.simTime : 0, phase: g.rm ? g.rm.phase : null, err: g.fatal ? String(g.fatal.stack) : null, bench: window.__bench || null } : null; });
console.log(JSON.stringify(info));
await b.close();
process.exit(errs.length ? 1 : 0);
