// BrakeSystem: pedal -> hydraulic pressure (rate-limited), bias, disc temperature/fade, ABS, MGU-K regen compensation.
import { clamp, table, expK } from '../core/math.js';

// pad+disc efficiency vs temperature (deg C): cold bite is poor, fades above ~900C
const EFF = [0, 0.50, 150, 0.58, 300, 0.80, 450, 0.97, 550, 1.0, 800, 1.0, 950, 0.82, 1100, 0.55];

export class BrakeSystem {
  constructor() {
    this.capacity = 17500;     // Nm: sum of the 4 wheel torques at pressure 1 and efficiency 1
    this.bias = 0.575;         // front fraction
    this.pedal = 0;            // filtered 0..1 pressure demand
    this.temp = new Float64Array([280, 280, 220, 220]);
    this.cap = new Float64Array([1500, 1500, 1200, 1200]); // disc+caliper+pad heat capacity J/K (front/rear)
    this.torque = new Float64Array(4);  // output: magnitude of friction torque per wheel (Nm, >=0)
    this.absRelease = new Float64Array(4); // 0..1 pressure reduction applied by ABS (for UI/sfx)
    this.efficiency = new Float64Array(4);
    this.regenTorque = 0;      // Nm at the rear axle currently produced by the MGU-K
    this.regenComp = 0;        // lagged compensation (brake-by-wire)
    this.regenError = 0;
  }

  /**
   * @param pedalIn raw 0..1 pedal   dt   wheelSlip[4] slip ratios (negative = braking slip)
   * @param absLevel 0 off, 1 lap, 2 strong   regenAvail Nm the MGU-K can supply this tick
   */
  update(dt, pedalIn, wheelSlip, absLevel, regenAvail, wetness, speedMS, damage) {
    // Pressure builds quickly but is not instant; release is faster.
    const target = clamp(pedalIn, 0, 1);
    const rate = target > this.pedal ? 7.5 : 14;
    const k = expK(rate, dt);
    this.pedal += (target - this.pedal) * k;
    if (this.pedal < 0.002 && target === 0) this.pedal = 0;

    const total = this.pedal * this.capacity;
    const front = total * this.bias * 0.5;
    const rear = total * (1 - this.bias) * 0.5;

    // MGU-K regen replaces part of the rear hydraulic torque. Compensation lags -> bias wobble when regen changes.
    const wantComp = Math.min(regenAvail, rear * 2);
    this.regenComp += (wantComp - this.regenComp) * expK(14, dt);
    this.regenTorque = wantComp;
    this.regenError = wantComp - this.regenComp;
    let rearHyd = rear - this.regenComp * 0.5;
    if (rearHyd < 0) rearHyd = 0;
    // axle-level regen torque appears at the rear wheels immediately (not lagged)
    const regenEach = wantComp * 0.5;

    const slipTarget = absLevel === 2 ? 0.115 : 0.15;
    const absGain = absLevel === 2 ? 0.92 : 0.8;
    for (let i = 0; i < 4; i++) {
      let base = i < 2 ? front : rearHyd;
      let rel = 0;
      if (absLevel > 0 && speedMS > 6) {
        // Slip-threshold controller; less effective on wet tarmac so it never makes the car invincible.
        const sl = -wheelSlip[i];
        if (sl > slipTarget) rel = clamp((sl - slipTarget) / 0.12, 0, 1) * absGain * (1 - 0.35 * wetness);
      }
      this.absRelease[i] = rel;
      base *= 1 - rel;
      const eff = table(EFF, this.temp[i]) * (damage ? damage[i] : 1);
      this.efficiency[i] = eff;
      this.torque[i] = base * eff + (i >= 2 ? regenEach : 0);
    }
  }

  /** disc temperature update from dissipated power; call after wheel speeds are known. */
  heat(dt, wheelOmega, speedMS, tAir) {
    for (let i = 0; i < 4; i++) {
      const hydTorque = this.torque[i] - (i >= 2 ? this.regenTorque * 0.5 : 0);
      const p = Math.max(0, hydTorque) * Math.abs(wheelOmega[i]);
      const cool = (i < 2 ? 4.5 : 3.2) + (i < 2 ? 0.95 : 0.7) * speedMS;
      const dT = (p - cool * (this.temp[i] - tAir)) / this.cap[i];
      this.temp[i] += dT * dt;
    }
  }
}
