// Smoke test of every mode / weather / track in headless Chromium: page errors, console errors, NaN in car state, stuck sim.
//   node scripts/modes-test.mjs   (needs `vite preview` on :4173)
import { launch } from './browser.mjs';
const b = await launch(); const results = [];
const cases = [
  ['race', 'monaco', 'heavy', 6], ['race', 'spa', 'dynamic', 19], ['quali', 'silverstone', 'dry', 10], ['practice', 'suzuka', 'light', 5], ['timetrial', 'bahrain', 'dry', 0], ['race', 'monza', 'dry', 19],
];
for (const [mode, track, weather, ai] of cases) {
  const p = await b.newPage({ viewport: { width: 800, height: 450 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await p.goto(`http://localhost:4173/?autostart=1&mode=${mode}&track=${track}&ai=${ai}&weather=${weather}&quality=low&laps=2`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  const r = await p.evaluate(async () => {
    const g = window.__game, rm = g.rm, out = { nan: [], steps: 0 };
    g.fastForward(14);
    for (let k = 0; k < 24; k++) {                      // ~ 2 simulated minutes, player on throttle
      rm.player.car.ctrl.throttle = 1; g.fastForward(5);
      for (const c of rm.cars) for (const key of ['x', 'z', 'psi', 'speed', 'steer']) if (!Number.isFinite(c[key])) out.nan.push(`${c.name}.${key}`);
      for (const c of rm.cars) if (!Number.isFinite(c.pt.rpm) || !Number.isFinite(c.fz[0])) out.nan.push(c.name + '.pt/fz');
      await new Promise((r) => setTimeout(r, 0));
    }
    // UI actions that touch many systems
    g.pause(); g.resume();
    out.phase = rm.phase; out.t = +rm.simTime.toFixed(1); out.retired = rm.cars.filter((c) => c.retired).length; out.n = rm.cars.length;
    out.top = Math.max(...rm.cars.map((c) => c.speed)).toFixed(0); return out;
  });
  const ok = errs.length === 0 && r.nan.length === 0;
  console.log((ok ? 'PASS ' : 'FAIL ') + `${mode}/${track}/${weather}/${ai}ai`, JSON.stringify(r), errs.slice(0, 3).join(' | ')); results.push(ok);
  await p.close();
}
await b.close(); process.exit(results.every(Boolean) ? 0 : 1);
