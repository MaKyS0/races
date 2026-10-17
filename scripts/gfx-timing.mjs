// Relative render-cost benchmark: median time of a fully finished frame (render + gl.finish) for each quality profile, with the cinematic
// post-processing on and off. Software GL (SwiftShader) is CPU rasterisation, so the numbers scale with fragment / vertex work; they are
// only for comparing versions of this game on this machine, never as device FPS.
//   node scripts/gfx-timing.mjs [baseUrl=http://localhost:4173/] [track=monza] [frames=24]
import { launch } from './browser.mjs';
const [base = 'http://localhost:4173/', track = 'monza', frames = '24'] = process.argv.slice(2);
const b = await launch();
for (const q of ['low', 'medium', 'high']) {
  const p = await b.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
  await p.goto(`${base}?autostart=1&track=${track}&ai=11&quality=${q}&shot=1`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  const r = await p.evaluate(async (frames) => {
    const g = window.__game, R = g.renderer, ctx = R.renderer.getContext(), px = new Uint8Array(4);
    g.fastForward(35); g.renderer.focus = g.rm.cars[2];
    g.state = 'bench-hold';                                  // stop the game loop from rendering in between
    const time = (n) => { const t = []; for (let i = 0; i < n; i++) { R.sync(g.rm, 1, 0.016, g.camCtl); g.camCtl.update(0.016, R.focus, R.visuals[R.focus.id], g.rm.track); const t0 = performance.now(); R.render(); ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px); /* readPixels waits for the GPU, finish() does not in Chrome */ t.push(performance.now() - t0); } t.sort((a, b) => a - b); return +t[n >> 1].toFixed(1); };
    time(4);
    const on = time(frames); const was = R.post.enabled; R.post.enabled = false; const off = time(frames); R.post.enabled = was;
    return { postOn: on, postOff: off, post: was, w: R.renderer.domElement.width, h: R.renderer.domElement.height };
  }, +frames);
  console.log(q.padEnd(6), JSON.stringify(r)); await p.close();
}
await b.close();
