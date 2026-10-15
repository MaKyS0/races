// Forward/backward-pass speed profile along the racing line, using the same physical limits as the car model
// (aero downforce, drag, engine power, friction). The AI follows it but all actual motion comes from the physics.
import { G } from '../core/math.js';

export const AI_CAR = { mass: 850, power: 585e3, claBase: 4.3, cdaBase: 1.3, rho: 1.2, muLat: 1.75, muBrake: 1.75, muTrac: 1.45 };

export function buildSpeedProfile(track, opt = {}) {
  const N = track.N, ds = track.ds;
  const o = { ...AI_CAR, ...opt };
  const m = o.mass;
  const k = new Float64Array(N), vlim = new Float64Array(N), v = new Float64Array(N);
  const half = 0.5 * o.rho;
  const vTop = 118;
  for (let i = 0; i < N; i++) {
    k[i] = Math.max(Math.abs(track.lineK[i]), 1e-5);
    // v^2 * k = mu (g + cla*rho/2 * v^2 / m)  ->  v^2 (k - mu cla rho / (2 m)) = mu g
    const den = k[i] - (o.muLat * o.claBase * half) / m;
    vlim[i] = den <= 1e-6 ? vTop : Math.min(vTop, Math.sqrt((o.muLat * G) / den));
    v[i] = vlim[i];
  }
  const dsLine = (i) => {
    const j = (i + 1) % N;
    return Math.hypot(track.lineX[j] - track.lineX[i], track.lineZ[j] - track.lineZ[i]);
  };
  const aLong = (vel, lat, accel) => {
    const q = half * vel * vel;
    const df = q * o.claBase;
    const grip = (accel ? o.muTrac : o.muBrake) * (m * G + df);
    const latUsed = Math.min(1, (vel * vel * lat * m) / (o.muLat * (m * G + df)));
    const circle = Math.sqrt(Math.max(0, 1 - latUsed * latUsed));
    const drag = q * o.cdaBase + 0.012 * m * G;
    if (accel) {
      const aEng = (o.power / Math.max(vel, 8) - drag) / m;
      return Math.min(aEng, grip / m) * circle;
    }
    return ((grip + drag) / m) * circle * 0.95;
  };
  for (let pass = 0; pass < 3; pass++) {
    // backward (braking)
    for (let n = 0; n < N * 2; n++) {
      const i = (2 * N - 1 - n) % N, j = (i + 1) % N;
      const a = aLong(v[j], k[j], false);
      const vmax = Math.sqrt(v[j] * v[j] + 2 * a * dsLine(i));
      if (vmax < v[i]) v[i] = vmax;
    }
    // forward (accel)
    for (let n = 0; n < N * 2; n++) {
      const i = n % N, j = (i + 1) % N;
      const a = aLong(v[i], k[i], true);
      const vmax = Math.sqrt(v[i] * v[i] + 2 * Math.max(a, 0) * dsLine(i));
      if (vmax < v[j]) v[j] = vmax;
    }
  }
  let t = 0;
  for (let i = 0; i < N; i++) t += dsLine(i) / Math.max(5, v[i]);
  return { v: Float32Array.from(v), vlim: Float32Array.from(vlim), lapTime: t, opt: o };
}
