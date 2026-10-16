// EngineSynth: a procedural engine "sample bank" - the same seamless rpm-layer loops the recorded bank uses (see EngineBank.js), but
// computed at start-up from an engine-order model instead of being cut from recordings:
//   * the loop is exactly N engine cycles (720 deg), so it repeats without a seam; pitch = playbackRate = rpm / layer rpm
//   * the spectrum is built per ORDER: firing orders (cylinders x j per cycle) are strong and phase-aligned (sharp pulses = the
//     raspy part), the non-firing orders (cylinder-to-cylinder differences, imbalance) and the side-bands around every order
//     (cycle-to-cycle jitter) give the roughness and the burble
//   * fixed exhaust / intake resonances in HERE-and-NOW Hz (so the formants sweep through the harmonics as the engine revs, exactly as
//     a real exhaust does) and a steeper roll-off off-throttle; 'off' layers also contain over-run pops
//   * synthesis is one inverse FFT per layer (16384 points) -> a few ms each, done lazily per engine
// These are NOT recordings: they are a model. They sound like "an engine" with the right pitch / firing order / rpm behaviour; they
// will not be mistaken for a recording of a particular real car.
import { makeRng, clamp } from '../core/math.js';

export const SYNTH_SPECS = [
  { id: 'syn-v6', label: 'V6 hybrid (synth)', cyl: 6, rough: 0.55, formant: 1.0, scream: 0.9, pops: 1.0 },
  { id: 'syn-v8', label: 'V8 (synth)', cyl: 8, rough: 0.9, formant: 0.9, scream: 1.0, pops: 1.2 },
  { id: 'syn-v10', label: 'V10 (synth)', cyl: 10, rough: 0.7, formant: 1.1, scream: 1.35, pops: 0.8 },
  { id: 'syn-v12', label: 'V12 (synth)', cyl: 12, rough: 0.45, formant: 1.25, scream: 1.2, pops: 0.7 },
];
export const SYNTH_LAYER_RPM = [3800, 5300, 7200, 9300, 11700, 14000, 16500];
const L = 16384, SR_B = 32000;

/** in-place radix-2 FFT (forward when inv = false); sizes are powers of two */
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const bump = (f, f0, w) => 1 / (1 + ((f - f0) / w) ** 2);

/**
 * One seamless loop of an engine at 'rpm'. on = true: throttle open (rich, loud); false: over-run (dark, thin, with pops).
 * Returns { data: Float32Array(L), sampleRate, rpm } - rpm is the exact rpm at which the loop plays at its natural speed.
 */
export function synthLayer(spec, rpm, on, seed = 1) {
  const rnd = makeRng((seed * 7919 + Math.round(rpm) * 13 + (on ? 1 : 0) * 101 + spec.cyl * 31) >>> 0);
  const fc = rpm / 120;                                           // cycles per second
  const N = Math.max(2, Math.round(L * fc / SR_B));              // cycles in the loop
  const sr = L * fc / N;                                          // buffer sample rate that makes the loop exactly N cycles long
  const binHz = sr / L;
  const re = new Float64Array(L), im = new Float64Array(L);
  const add = (m, amp, phase) => { if (m < 1 || m >= L / 2) return; re[m] += amp * Math.cos(phase); im[m] += amp * Math.sin(phase); };
  const nyq = sr / 2 * 0.92;
  const F = spec.formant;
  // spectral envelope in Hz: low body + exhaust pipe resonances + intake / 'scream' band + roll-off
  const env = (f) => {
    const body = 0.55 * bump(f, 140 * F, 160 * F) + 1.0 * bump(f, 420 * F, 260 * F) + 0.85 * bump(f, 900 * F, 420 * F);
    const hi = (on ? 0.55 : 0.12) * spec.scream * (bump(f, 1700 * F, 700 * F) + 0.8 * bump(f, 3000 * F, 1100 * F) + 0.35 * bump(f, 5200, 1500));
    const roll = 1 / (1 + (f / (on ? 7000 : 2600)) ** 2);
    return (body + hi) * roll;
  };
  const hMax = Math.floor(nyq / (fc));                            // highest cycle-harmonic below the Nyquist limit
  const decay = on ? 0.95 : 1.7;
  const jitter = (on ? 0.045 : 0.09) * spec.rough;                // cycle-to-cycle amplitude jitter -> side-bands
  for (let h = 1; h <= hMax; h++) {
    const f = h * fc;
    const m0 = h * N;
    const firing = h % spec.cyl === 0, j = h / spec.cyl;
    let amp;
    if (firing) amp = Math.pow(j, -decay) * 1.0;                   // the firing orders carry the pitch
    else if (h < spec.cyl) amp = (h % 2 ? 0.30 : 0.22) * spec.rough * (on ? 0.8 : 1.2) / Math.sqrt(h);   // sub-orders: imbalance, cam, one bank vs the other
    else amp = 0.10 * spec.rough * Math.pow(h / spec.cyl, -1.0);   // between the firing orders: cylinder differences
    amp *= env(f) * (firing ? 1 : 0.9);
    // phases: firing orders aligned (a pulse per firing) with a little dispersion, the others random
    const ph = firing ? (0.9 * (rnd() - 0.5) + 0.012 * j * j) : rnd() * Math.PI * 2;
    add(m0, amp, ph);
    // side-bands: the 'N cycles' of the loop are all slightly different
    for (let d = 1; d <= 3; d++) { const a = amp * jitter * (rnd() * 0.8 + 0.2) / d; add(m0 + d, a, rnd() * 6.283); add(m0 - d, a, rnd() * 6.283); }
  }
  // mirror to the negative frequencies and synthesise; the imaginary parts become the Hermitian counterparts
  for (let k = 1; k < L / 2; k++) { re[L - k] = re[k]; im[L - k] = -im[k]; }
  fft(re, im, true);
  const data = new Float32Array(L);
  for (let i = 0; i < L; i++) data[i] = re[i];
  // combustion noise: a short noise burst at every firing event (so it is locked to the cycle and the loop stays seamless), low-passed
  // (darker off-throttle), mixed in at a fixed fraction of the harmonic part - this is the 'texture' between the pure orders
  {
    let hs = 0; for (let i = 0; i < L; i++) hs += data[i] * data[i];
    const hr = Math.sqrt(hs / L), nev = N * spec.cyl, per = L / nev, blen = Math.floor(per * 0.8);
    const nb = new Float32Array(L);
    for (let e = 0; e < nev; e++) { const st = Math.floor(e * per), amp = 0.7 + 0.6 * rnd(); for (let i = 0; i < blen; i++) nb[(st + i) % L] += (rnd() * 2 - 1) * amp * Math.exp(-i / (blen * 0.3)); }
    const a = 1 - Math.exp(-2 * Math.PI * (on ? 2300 : 800) / sr); let y = 0, y2 = 0;       // two poles, run twice round the loop so it is seamless
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < L; i++) { y += a * (nb[i] - y); y2 += a * (y - y2); if (pass) nb[i] = y2; }
    let ns = 0; for (let i = 0; i < L; i++) ns += nb[i] * nb[i];
    const gN = (hr * (on ? 0.20 : 0.12)) / Math.max(1e-9, Math.sqrt(ns / L));
    for (let i = 0; i < L; i++) data[i] += nb[i] * gN;
  }
  // over-run: pops (short noise + low thump) at random places, more of them at high rpm
  if (!on && rpm > 7000) {
    const n = Math.round(spec.pops * (rpm - 6500) / 2500 * 2);
    for (let p = 0; p < n; p++) {
      const at = Math.floor(rnd() * L), len = Math.floor(sr * (0.012 + rnd() * 0.02)), g = (0.25 + rnd() * 0.5) * 0.9;
      let lp = 0;
      for (let i = 0; i < len; i++) { const e = Math.exp(-i / (len * 0.28)); lp += 0.35 * ((rnd() * 2 - 1) - lp); data[(at + i) % L] += g * e * (lp * 0.9 + 0.5 * Math.sin(i * 0.11)); }
    }
  }
  // normalise to the loudness the voices expect (rms 0.12) and remove any DC
  let mean = 0; for (let i = 0; i < L; i++) mean += data[i]; mean /= L;
  let ss = 0; for (let i = 0; i < L; i++) { data[i] -= mean; ss += data[i] * data[i]; }
  const g = 0.12 / Math.max(1e-6, Math.sqrt(ss / L));
  for (let i = 0; i < L; i++) data[i] = clamp(data[i] * g, -0.95, 0.95);
  return { data, sampleRate: sr, rpm };   // sr was chosen so that the loop is exactly N cycles at this rpm
}

/** a complete engine ({ id, label, cyl, layers (on), offLayers }) as AudioBuffers; heavy part is lazy (call once per engine) */
export function buildSynthEngine(ctx, spec) {
  const mk = (on) => SYNTH_LAYER_RPM.map((r, i) => {
    const l = synthLayer(spec, r, on, i + 1);
    const b = ctx.createBuffer(1, L, l.sampleRate); b.getChannelData(0).set(l.data);
    return { rpm: Math.round(l.rpm), buffer: b };
  });
  return { id: spec.id, label: spec.label, cyl: spec.cyl, layers: mk(true), offLayers: mk(false), synth: true };
}
