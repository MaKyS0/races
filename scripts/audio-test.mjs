// Runtime check of the recorded-engine audio path in headless Chromium (needs `vite preview` on :4173 and public/audio installed).
//   node scripts/audio-test.mjs
import { launch } from './browser.mjs';
const b = await launch(['--autoplay-policy=no-user-gesture-required']);
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('' + (process.env.BASE || 'http://localhost:4173/') + '?autostart=1&track=monza&ai=5&quality=low&camera=chase');
await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
const results = []; const ok = (n, c, x = '') => { results.push(c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
await p.evaluate(() => { const g = window.__game; g.audio.unlock(); g.fastForward(14); });
await p.waitForFunction(() => window.__game.audio.bankState !== 'loading' && window.__game.audio.bankState !== 'idle', null, { timeout: 60000 }).catch(() => {});
const st = await p.evaluate(() => { const a = window.__game.audio; return { ready: a.ready, bank: a.bankState, engines: a.bank ? [...a.bank.engines.keys()] : [], ctx: a.ctx && a.ctx.state }; });
ok('audio context running', st.ready && st.ctx === 'running', JSON.stringify(st));
const bankMode = st.bank === 'ready';
console.log(bankMode ? 'mode: recorded engines' : 'mode: synthesised engine layers (no public/audio recordings installed)');
if (bankMode) ok('engine bank decoded', st.engines.length > 0, st.engines.join(','));
// analyser on the engine bus
await p.evaluate(() => { const a = window.__game.audio; a.an = a.ctx.createAnalyser(); a.an.fftSize = 4096; a.engineBus.connect(a.an); });
const meas = () => p.evaluate(() => {
  const a = window.__game.audio, an = a.an, f = new Float32Array(an.fftSize), sp = new Float32Array(an.frequencyBinCount);
  an.getFloatTimeDomainData(f); an.getFloatFrequencyData(sp);
  let s = 0; for (const v of f) s += v * v;
  let num = 0, den = 0; for (let i = 2; i < 400; i++) { const m = Math.pow(10, sp[i] / 20); num += i * m; den += m; }
  const c = window.__game.rm.player.car;
  return { rms: Math.sqrt(s / f.length), centroidBin: num / Math.max(den, 1e-12), rpm: Math.round(c.pt.rpm), slots: a.pVoice ? a.pVoice.slots.filter(Boolean).length : 1, gain: a.pVoice ? a.pVoice.amp.gain.value : a.eGain.gain.value, peak: Math.max(...f.map(Math.abs)) };
});
await p.waitForTimeout(800);
const idle = await meas();
ok('engine is audible at idle (non-silent output through the engine bus)', idle.rms > 0.003 && idle.slots >= 1, JSON.stringify(idle));
await p.keyboard.down('w');
await p.waitForFunction(() => window.__game.rm.player.car.pt.rpm > 9000, null, { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(500);
const fast = await meas();
ok('rpm rose with throttle', fast.rpm > idle.rpm + 1500, `${idle.rpm} -> ${fast.rpm}`);
ok('pitch / brightness follows rpm (spectral centroid rises)', fast.centroidBin > idle.centroidBin * 1.15, `${idle.centroidBin.toFixed(1)} -> ${fast.centroidBin.toFixed(1)}`);
ok('louder on throttle than at idle', fast.gain > idle.gain, `${idle.gain.toFixed(2)} -> ${fast.gain.toFixed(2)}`);
await p.keyboard.up('w');
await p.keyboard.down('s'); await p.waitForTimeout(1200);
const lift = await meas(); await p.keyboard.up('s');
ok('quieter / darker off-throttle', lift.gain < fast.gain, `${fast.gain.toFixed(2)} -> ${lift.gain.toFixed(2)}`);
// opponents get recorded voices too
// (the grid is > 260 m from the camera: move one AI car next to it for the check; the physics step may move it again, so poll)
await p.evaluate(() => { const g = window.__game, c = g.rm.cars.find((x) => x !== g.rm.player.car), cp = g.renderer.camera.position; c.x = cp.x + 12; c.z = cp.z + 18; });
await p.waitForFunction(() => window.__game.audio.aiVoices.size >= 1, null, { timeout: 5000 }).catch(() => {});
const ai = await p.evaluate(() => window.__game.audio.aiVoices.size);
if (bankMode) ok('nearby opponents have recorded-engine voices', ai >= 1, 'voices ' + ai);
// pause / resume / switching engine in settings must not throw
await p.evaluate(() => { const g = window.__game; g.pause(); g.resume(); g.settings.data.audio.engineSound = 'nonexistent'; });
await p.waitForTimeout(500);
if (bankMode) ok('unknown engine id falls back to a valid engine', (await p.evaluate(() => !!window.__game.audio.pVoice && window.__game.audio.pVoice.eng.id.length > 0)));
ok('no clipping at full throttle (peak < 0.98 on the engine bus)', fast.peak < 0.98, 'peak ' + fast.peak.toFixed(2));
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await b.close(); process.exit(failed ? 1 : 0);
