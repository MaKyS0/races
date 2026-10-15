// Close-up renders of the car model in the showroom: node scripts/car-shots.mjs [quality=high] [team=0]  -> build-output/car/<quality>-<view>.png
import { launch } from './browser.mjs';
import fs from 'node:fs';
const quality = process.argv[2] || 'high', team = +(process.argv[3] || 0);
fs.mkdirSync('build-output/car', { recursive: true });
const b = await launch(); const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message, (e.stack || '').split('\n')[1]));
p.on('console', (m) => { if (['error'].includes(m.type())) console.log('[error]', m.text().slice(0, 300)); });
await p.goto(`http://localhost:4173/?quality=${quality}`); await p.waitForFunction(() => window.__game && window.__game.renderer, null, { timeout: 60000 }); await p.waitForTimeout(3000);
await p.evaluate((t) => { const g = window.__game; g.settings.data.game.team = t; g.enterMenuScene(t); g.menu.hide && g.menu.hide(); }, team);
await p.waitForTimeout(1500);
const views = {
  front34: [4.2, 1.5, 4.6, 0, 0.45, 0.8, 38], rear34: [-4.0, 1.7, -5.2, 0, 0.55, -0.6, 38], side: [8.2, 0.8, 0.3, 0, 0.45, 0.2, 30], top: [0.1, 8.5, 0.6, 0, 0, 0.2, 34],
  nose: [1.6, 0.55, 5.2, 0, 0.18, 2.4, 40], wheel: [1.9, 0.55, 3.0, 0.8, 0.33, 1.96, 34], cockpit: [2.6, 1.7, 0.1, 0, 0.62, 0.1, 34], rearwing: [1.6, 1.3, -4.7, 0, 0.9, -2.5, 36],
};
for (const [name, v] of Object.entries(views)) {
  await p.evaluate(([v]) => { const r = window.__game.renderer; r.updateShowroom = function () { const s = this.showroom; if (!s) return; this.camera.position.set(v[0], v[1], v[2]); this.camera.up.set(0, 1, 0); this.camera.lookAt(v[3], v[4], v[5]); if (this.camera.fov !== v[6]) { this.camera.fov = v[6]; this.camera.updateProjectionMatrix(); } s.car.root.rotation.y = 0; s.car.rwFlap.rotation.x = 0.1; }; }, [v]);
  const f0 = await p.evaluate(() => window.__game.perf.frames); await p.waitForFunction((f) => window.__game.perf.frames > f + 3, f0, { timeout: 60000 });
  await p.screenshot({ path: `build-output/car/${quality}-${name}.png` });
}
console.log(JSON.stringify(await p.evaluate(() => { const i = window.__game.renderer.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geoms: i.memory.geometries }; })));
await b.close();
