// Barlow / Barlow Condensed (SIL OFL 1.1, bundled - works offline in the app): latin subset, only the weights the UI uses
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import './ui/style.css';
import { Game } from './Game.js';

const root = document.getElementById('app');
const q0 = new URLSearchParams(location.search);
if (q0.get('quality')) { try { const st = JSON.parse(localStorage.getItem('apexgp.settings.v1') || '{}'); st.graphics = q0.get('quality'); localStorage.setItem('apexgp.settings.v1', JSON.stringify(st)); } catch (e) { /* ignore */ } }
const game = new Game(root);
window.__game = game;
game.start();

// ---- developer / CI hooks: ?bench=1&track=monza&ai=19&seconds=60&quality=low&autostart=1
const q = new URLSearchParams(location.search);
if (q.get('autostart') || q.get('bench')) {
  const cfg = {
    ...game.settings.data.game, mode: q.get('mode') || 'race', trackId: q.get('track') || 'monza', aiCount: +(q.get('ai') ?? 19), laps: +(q.get('laps') || 3),
    weather: q.get('weather') || 'dry', assists: game.settings.data.assists, setup: game.settings.data.setup, camera: q.get('camera') || 'chase', bench: !!q.get('bench'), seed: 7,
  };
  if (q.get('quality')) game.settings.data.graphics = q.get('quality');
  if (q.get('fps')) game.settings.data.fps = q.get('fps') === 'auto' ? 'auto' : +q.get('fps');
  game.settings.data.preserveBuffer = !!q.get('shot');
  setTimeout(async () => {
    try { await Promise.race([document.fonts.load('700 64px "Barlow Condensed"'), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* trackside boards fall back to the system face */ }
    await game.startSession(cfg);
    if (q.get('bench')) runBench(game, +(q.get('seconds') || 30));
  }, 50);
}
function runBench(game, seconds) {
  const frames = []; let last = performance.now(); const t0 = last; const start = game.rm.simTime;
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const tick = () => {
    const now = performance.now();
    frames.push(now - last); last = now;
    if (now - t0 < seconds * 1000) requestAnimationFrame(tick);
    else {
      frames.shift();
      const s = frames.slice().sort((a, b) => a - b), avg = frames.reduce((a, b) => a + b, 0) / frames.length;
      window.__bench = { seconds, frames: frames.length, avgMs: avg, p50: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], p99: s[Math.floor(s.length * 0.99)], max: s[s.length - 1], fps: 1000 / avg,
        physMs: game.perf.physMs, renderMs: game.perf.renderMs, scale: game.perf.scale, level: game.perf.level, quality: game.perf.qualityName(), heapStartMB: heap0 / 1048576, heapEndMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0, gcDrops: game.perf.heapDrops, simSeconds: game.rm.simTime - start, longFrames: game.perf.longFrames };
      console.log('BENCH ' + JSON.stringify(window.__bench));
    }
  };
  requestAnimationFrame(tick);
}
