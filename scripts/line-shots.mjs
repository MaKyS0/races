// Screenshots of the live optimal line: waits (in simulation) until the followed car is in a braking zone, then captures.
//   node scripts/line-shots.mjs [outDir=build-output/gfx3] [baseUrl=http://localhost:4173/] [tracks=monza,spa,suzuka]
import { launch } from './browser.mjs';
import fs from 'node:fs';
const out = process.argv[2] || 'build-output/gfx3', base = process.argv[3] || 'http://localhost:4173/', tracks = (process.argv[4] || 'monza,spa,suzuka').split(',');
fs.mkdirSync(out, { recursive: true });
const b = await launch();
for (const t of tracks) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto(`${base}?autostart=1&track=${t}&ai=6&quality=high&shot=1&weather=dry`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  const found = await p.evaluate(() => {
    const g = window.__game; g.fastForward(30); const car = g.rm.cars[1]; g.renderer.focus = car; g.settings.data.ui.fps = false;
    for (let i = 0; i < 400; i++) { g.fastForward(0.1); g.renderer.dline.update(car, 'full', 0.1); if (g.renderer.dline.braking && car.speed > 55) return car.speed; }
    return -1;
  });
  const f0 = await p.evaluate(() => window.__game.perf.frames); await p.waitForFunction((f) => window.__game.perf.frames > f + 6, f0, { timeout: 120000 }); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/line-brake-${t}.png` }); console.log(t, 'braking zone found at', found.toFixed(0), 'm/s'); await p.close();
}
await b.close();
