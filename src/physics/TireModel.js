// TireModel: combined-slip Pacejka-style force model with thermal, wear, wet-weather and puncture state.
import { clamp, table } from '../core/math.js';

// Pacejka shape constants chosen so that the curve peaks exactly at normalised slip s = 1
// (B=2, C=1.5, E=0.3 -> sin(1.5*atan(...)) = 1 at s = 1, asymptote ~0.707 when fully sliding).
const PB = 2.0, PC = 1.5, PE = 0.3;
export function shape(s) {
  const bs = PB * s;
  return Math.sin(PC * Math.atan(bs - PE * (bs - Math.atan(bs))));
}
export const SHAPE_SLOPE = PB * PC; // initial slope per unit normalised slip
/** derivative of shape() w.r.t. s */
export function shapeD(s) {
  const bs = PB * s;
  const x = bs - PE * (bs - Math.atan(bs));
  const dx = PB * (1 - PE + PE / (1 + bs * bs));
  return Math.cos(PC * Math.atan(x)) * (PC / (1 + x * x)) * dx;
}

/**
 * Compounds. wet[] is grip multiplier vs water depth (0..1), tOpt/tWin in deg C.
 * life = energy (MJ) of tyre slip work until fully worn (before the user wear multiplier).
 */
export const COMPOUNDS = {
  soft:   { id: 'soft',   name: 'Soft',   color: '#ff3b3b', mu0: 2.62, tOpt: 92,  tWin: 36, life: 11, kP: 0.105, aP: 0.112, vAq: 17, wet: [0, 1, 0.08, 0.80, 0.25, 0.42, 0.55, 0.22, 1.0, 0.12] },
  medium: { id: 'medium', name: 'Medium', color: '#ffd23b', mu0: 2.50, tOpt: 97,  tWin: 40, life: 19, kP: 0.108, aP: 0.115, vAq: 17, wet: [0, 1, 0.08, 0.80, 0.25, 0.42, 0.55, 0.22, 1.0, 0.12] },
  hard:   { id: 'hard',   name: 'Hard',   color: '#f2f2f2', mu0: 2.38, tOpt: 103, tWin: 44, life: 32, kP: 0.110, aP: 0.118, vAq: 17, wet: [0, 1, 0.08, 0.80, 0.25, 0.42, 0.55, 0.22, 1.0, 0.12] },
  inter:  { id: 'inter',  name: 'Intermediate', color: '#2fcf55', mu0: 2.20, tOpt: 78, tWin: 40, life: 15, kP: 0.130, aP: 0.140, vAq: 30, wet: [0, 0.80, 0.08, 0.93, 0.25, 1.0, 0.55, 0.82, 1.0, 0.50] },
  wet:    { id: 'wet',    name: 'Wet',    color: '#2f7bff', mu0: 2.05, tOpt: 62,  tWin: 38, life: 14, kP: 0.150, aP: 0.160, vAq: 44, wet: [0, 0.66, 0.08, 0.80, 0.25, 0.95, 0.55, 1.0, 1.0, 0.92] },
};
export const DRY_COMPOUNDS = ['soft', 'medium', 'hard'];

/** Surface table: grip multiplier (dry/wet), rolling resistance, roughness, drag-ish digging, wet-ability. */
export const SURFACES = {
  asphalt: { id: 0, mu: 1.0,  muWet: 1.0,  crr: 0.012, rough: 0.0,  dig: 0,   paved: true },
  kerb:    { id: 1, mu: 0.93, muWet: 0.78, crr: 0.020, rough: 1.0,  dig: 0,   paved: true },
  runoff:  { id: 2, mu: 0.97, muWet: 1.0,  crr: 0.014, rough: 0.05, dig: 0,   paved: true },   // asphalt run-off
  grass:   { id: 3, mu: 0.44, muWet: 0.28, crr: 0.075, rough: 0.35, dig: 0.3, paved: false },
  gravel:  { id: 4, mu: 0.58, muWet: 0.50, crr: 0.32,  rough: 0.55, dig: 1.0, paved: false },
  pit:     { id: 5, mu: 1.0,  muWet: 1.0,  crr: 0.012, rough: 0.0,  dig: 0,   paved: true },
  sand:    { id: 6, mu: 0.50, muWet: 0.55, crr: 0.45,  rough: 0.3,  dig: 1.4, paved: false },
};
export const SURFACE_LIST = [SURFACES.asphalt, SURFACES.kerb, SURFACES.runoff, SURFACES.grass, SURFACES.gravel, SURFACES.pit, SURFACES.sand];

const FZ0 = 2600;      // reference load (N) for load sensitivity
const LOAD_SENS = 0.055;

/** One tyre instance (state + force evaluation). Allocation free. */
export class Tire {
  constructor(compound = 'medium', startTemp = 80) {
    this.compound = COMPOUNDS[compound];
    this.tSurf = startTemp;
    this.tCore = startTemp - 6;
    this.wear = 0;          // 0 new .. 1 destroyed
    this.puncture = 0;      // 0 ok .. 1 flat
    this.leak = 0;          // deflation rate per second
    this.syRelax = 0;       // relaxed tan(slip angle)
    // outputs of last evaluation
    this.fx = 0; this.fy = 0; this.mu = 0; this.gripTemp = 0; this.gripWear = 0; this.slipRatio = 0; this.slipAngle = 0;
    this.slipPower = 0; this.sliding = 0; this.aqua = 1;
    this.slipEnergy = 0;
  }

  fit(compound, startTemp = 75) {
    this.compound = COMPOUNDS[compound];
    this.tSurf = startTemp; this.tCore = startTemp - 6;
    this.wear = 0; this.puncture = 0; this.leak = 0; this.syRelax = 0; this.slipEnergy = 0;
  }

  tempGrip() {
    const c = this.compound;
    const T = 0.65 * this.tSurf + 0.35 * this.tCore;
    const d = T - c.tOpt;
    if (d < 0) { const k = d / (c.tWin * 1.6); return clamp(1 - k * k, 0.6, 1); }
    const k = d / c.tWin; return clamp(1 - 0.9 * k * k, 0.45, 1);
  }
  wearGrip() {
    const w = this.wear;
    let g = 1 - 0.20 * w;
    if (w > 0.72) { const k = (w - 0.72) / 0.28; g -= 0.38 * k * k; }
    return clamp(g, 0.35, 1);
  }
  /** grip factor from standing water (depth 0..1) and aquaplaning at speed */
  wetGrip(water, speed) {
    const c = this.compound;
    const g = table(c.wet, water);
    const vcrit = (c.vAq * 1.3) / Math.sqrt(water * 1.2 + 0.06);
    const r = speed / vcrit;
    this.aqua = 1 / (1 + r * r * r * r * r * r * 0.9);
    return g * (water > 0.03 ? this.aqua : 1);
  }

  /**
   * Evaluate forces.
   * @param fz vertical load (N)  kappa slip ratio  tanA relaxed tan(slip angle)  surf SURFACES entry
   * Fx positive = forward (driving) on the car, Fy positive = towards the tyre's left.
   * kappa sign: >0 wheel faster than ground.
   */
  eval(fz, kappa, tanA, surf, water, speed, damageGrip) {
    const c = this.compound;
    if (fz <= 1) { this.fx = this.fy = 0; this.mu = 0; return; }
    const wetOn = surf.paved ? water : water * 0.6;
    let mu = c.mu0 * (1 - LOAD_SENS * (fz / FZ0 - 1));
    mu = clamp(mu, 0.9, 3.0);
    this.gripTemp = this.tempGrip();
    this.gripWear = this.wearGrip();
    mu *= this.gripTemp * this.gripWear;
    if (surf.paved) mu *= this.wetGrip(wetOn, speed);
    else { this.aqua = 1; }
    mu *= (water > 0.05 ? (surf.mu + (surf.muWet - surf.mu) * clamp(water * 1.5, 0, 1)) : surf.mu);
    mu *= 1 - 0.55 * this.puncture;
    mu *= damageGrip;
    // wet compounds on dry tarmac work, they just overheat (handled thermally); paved only here.
    this.mu = mu;
    const kP = c.kP * (1 + 0.5 * this.puncture);
    const aP = c.aP * (1 + 0.6 * this.puncture);
    const sx = kappa / kP;
    const sy = tanA / aP;
    const s = Math.sqrt(sx * sx + sy * sy);
    this.slipRatio = kappa; this.slipAngle = tanA;
    this.sliding = s; this.sxN = sx; this.kP = kP;
    if (s < 1e-5) { this.fx = this.fy = 0; return; }
    const F = mu * fz * shape(s);
    this.fx = (F * sx) / s;
    this.fy = (-F * sy) / s;
  }

  /** local dFx/dkappa (kept positive, floored) for the implicit wheel integration */
  slopeX(fz) {
    const s = this.sliding;
    if (!(s > 1e-4)) return (SHAPE_SLOPE * this.mu * fz) / this.compound.kP;
    const c2 = (this.sxN * this.sxN) / (s * s);
    const d = shapeD(s) * c2 + (shape(s) / s) * (1 - c2);
    return Math.max(0.12 * SHAPE_SLOPE, d) * this.mu * fz / this.kP;
  }

  /**
   * Thermal + wear update.
   * @param vSlipX/vSlipY patch slip velocities (m/s)  speed ground speed  tAir ambient  tTrack track temp
   * @param tDisc brake disc temp feeding heat into the rim/core   wearMult user multiplier
   */
  thermal(dt, fz, vSlipX, vSlipY, speed, tAir, tTrack, tDisc, water, wearMult) {
    const c = this.compound;
    const pSlip = Math.abs(this.fx * vSlipX) + Math.abs(this.fy * vSlipY);
    this.slipPower = pSlip;
    const pHyst = 0.011 * fz * speed * (1 + 1.5 * this.puncture); // carcass flexing
    // Heat into the surface from sliding + flexing; cooling by air (more with speed, much more in the wet), road conduction.
    const hAir = 6 + 0.45 * speed + water * 260;
    const hRoad = 20 + water * 90;
    const dS = (0.45 * pSlip + 0.45 * pHyst - hAir * (this.tSurf - tAir) - hRoad * (this.tSurf - tTrack) * 0.5 - 150 * (this.tSurf - this.tCore)) / 3800;
    const kc = 18 + 0.6 * speed;
    const dC = (150 * (this.tSurf - this.tCore) + 0.55 * pHyst + 2.2 * (tDisc - this.tCore) - kc * (this.tCore - tAir)) / 13500;
    this.tSurf = clamp(this.tSurf + dS * dt, tAir - 5, 230);
    this.tCore = clamp(this.tCore + dC * dt, tAir - 5, 200);
    // Wear: slip work, accelerated when over/under heated.
    const T = 0.65 * this.tSurf + 0.35 * this.tCore;
    const over = clamp((T - (c.tOpt + 22)) / 30, 0, 2);
    const cold = clamp(((c.tOpt - 38) - T) / 30, 0, 1);
    let rate = (pSlip + 0.0006 * fz * speed) / (c.life * 1e6) * (1 + 1.8 * over + 0.7 * cold);
    // wet tyres on dry tarmac chew themselves up, slicks in the wet barely wear
    if (c.id === 'wet' || c.id === 'inter') rate *= 1 + (1 - clamp(water * 3, 0, 1)) * 2.2;
    this.wear = clamp(this.wear + rate * wearMult * dt, 0, 1);
    this.slipEnergy += pSlip * dt;
    if (this.leak > 0) this.puncture = clamp(this.puncture + this.leak * dt, 0, 1);
  }
}
