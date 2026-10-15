// Render-load bench in headless Chromium (SwiftShader software GL).
// IMPORTANT: FPS from this script is NOT representative of any phone/GPU. It is only useful for relative scene cost
// (draw calls, triangles, textures/geometries held) and for catching main-thread regressions/leaks.
// usage: node scripts/bench.mjs [quality=low|medium|high] [track] [ai] [seconds]
import { launch } from './browser.mjs';
const [quality = 'low', track = 'monza', ai = '19', seconds = '12'] = process.argv.slice(2);
const b = await launch(); const p = await b.newPage({ viewport: { width: 960, height: 540 } });
const logs = []; p.on('console', (m) => logs.push(m.text())); p.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await p.goto(`http://localhost:4173/?bench=1&track=${track}&ai=${ai}&seconds=${seconds}&quality=${quality}&autostart=1`);
await p.waitForFunction(() => window.__bench, null, { timeout: (+seconds + 120) * 1000 });
const r = await p.evaluate(() => { const g = window.__game, i = g.renderer?.renderer?.info || g.view?.renderer?.info; return { bench: window.__bench, info: i ? { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length } : null }; });
console.log(JSON.stringify(r, null, 1)); const errs = logs.filter((l) => /ERROR|error/.test(l)); if (errs.length) console.log('console errors:', errs.slice(0, 5));
await b.close();
