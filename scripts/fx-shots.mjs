// Screenshots of the cinematic post-processing at speed, with the sun in view, on every quality profile (off / medium / high).
//   node scripts/fx-shots.mjs [outDir=build-output/gfx3] [baseUrl=http://localhost:4173/]
import { launch } from './browser.mjs';
import fs from 'node:fs';
const out = process.argv[2] || 'build-output/gfx3', base = process.argv[3] || 'http://localhost:4173/'; fs.mkdirSync(out, { recursive: true });
const b = await launch();
for (const [track, q, fx, sun, tag] of [['monza', 'high', true, true, 'high-sun'], ['monza', 'high', false, true, 'off-sun'], ['spa', 'medium', true, false, 'medium'], ['silverstone', 'high', true, true, 'high-silverstone'], ['suzuka', 'high', true, false, 'high-suzuka']]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto(`${base}?autostart=1&track=${track}&ai=8&quality=${q}&shot=1&weather=dry`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  await p.evaluate(([fx, sun]) => {
    const g = window.__game; g.fastForward(30); g.settings.data.fx = fx; g.renderer.applyScale(); g.settings.data.ui.fps = false;
    g.renderer.debugSpeed = 88;
    if (sun) { const e = g.renderer.camera.matrixWorld.elements, f = [-e[8], -e[9], -e[10]], c = Math.cos(0.14), s = Math.sin(0.14), n = Math.hypot(f[0], f[2]);
      const d = [f[0] / n * c, s, f[2] / n * c]; g.renderer.sky.uniforms.sunDir.value.set(d[0], d[1], d[2]).normalize(); }
  }, [fx, sun]);
  const f0 = await p.evaluate(() => window.__game.perf.frames); await p.waitForFunction((f) => window.__game.perf.frames > f + 12, f0, { timeout: 120000 }); await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/fx-${tag}.png` }); console.log('ok', tag); await p.close();
}
await b.close();
