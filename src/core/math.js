// Small allocation-free math helpers used by the hot loops.
export const TAU = Math.PI * 2;
export const G = 9.81;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (x) => (x < 0 ? -1 : 1);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export function wrapPi(a) {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}
/** exponential smoothing factor that is independent of the step size */
export const expK = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Piecewise linear lookup on a flat [x0,y0,x1,y1,...] table. */
export function table(t, x) {
  const n = t.length;
  if (x <= t[0]) return t[1];
  if (x >= t[n - 2]) return t[n - 1];
  for (let i = 2; i < n; i += 2) {
    if (x <= t[i]) {
      const x0 = t[i - 2], y0 = t[i - 1];
      return y0 + ((t[i + 1] - y0) * (x - x0)) / (t[i] - x0);
    }
  }
  return t[n - 1];
}

/** Deterministic PRNG (mulberry32) so races/tests are reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.gauss = () => {
    let u = 0;
    for (let i = 0; i < 4; i++) u += f();
    return (u - 2) * 1.7320508; // ~N(0,1)
  };
  return f;
}

export function fmtTime(t, signed = false) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const s = signed ? (t < 0 ? '-' : '+') : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  const ss = sec.toFixed(3).padStart(6, '0');
  return signed && m === 0 ? `${s}${sec.toFixed(3)}` : `${s}${m}:${ss}`;
}
