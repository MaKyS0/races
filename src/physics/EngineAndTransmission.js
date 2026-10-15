// EngineAndTransmission: ICE torque curve, 8-speed seamless gearbox, rev limiter, clutch/launch, engine braking,
// fuel burn and an MGU-K style ERS (deploy + regen) that the brake system compensates for.
import { clamp, table, expK } from '../core/math.js';

// full-throttle ICE torque (Nm) vs rpm
const TORQUE = [0, 0, 3500, 240, 5000, 320, 6500, 390, 8000, 445, 9500, 488, 11000, 500, 12000, 482, 13000, 445, 14000, 392, 15000, 330, 16000, 150];
export const RPM_IDLE = 4200, RPM_LIMIT = 15000, RPM_MAX_SAFE = 15900;
export const GEAR_RATIOS = [0, 19.6, 15.2, 12.1, 9.9, 8.35, 7.1, 6.15, 5.45]; // overall incl. final drive
export const DRIVELINE_EFF = 0.93;
export const I_DRIVE = 0.11; // kg m^2 engine+MGU+clutch inertia reflected through the gear squared
const FUEL_PER_JOULE = 4.8e-8; // kg per J of mechanical ICE work (~100 kg/h at 580 kW)
export const ERS_CAPACITY = 4.0e6; // J
export const ERS_POWER = 120e3;    // W

export class Powertrain {
  constructor() {
    this.rpm = RPM_IDLE;
    this.gear = 1;
    this.auto = true;
    this.shiftTimer = 0;     // >0 while shifting (torque dip)
    this.shiftCooldown = 0;
    this.limiter = false;
    this.clutchLocked = false;
    this.throttleApplied = 0;
    this.engineTorque = 0;   // Nm at crank (ICE only)
    this.axleTorque = 0;     // Nm total at rear axle (wheel side), signed
    this.engineBraking = 0.7;// 0..1 map
    this.fuel = 100;         // kg
    this.fuelRate = 0;       // kg/s
    this.ers = ERS_CAPACITY * 0.7; // J
    this.ersMode = 1;        // 0 harvest, 1 balanced, 2 attack
    this.ersDeploy = 0;      // W currently deployed
    this.ersHarvest = 0;     // W currently harvested
    this.power = 0;          // W ICE+ERS
    this.health = 1;         // power-unit health 0..1
    this.dead = false;
    this.redline = false;
    this.upshiftRpm = 13100;
  }

  /** Torque the MGU-K could regenerate at the rear axle right now (Nm at wheels), for brake blending. */
  regenAvailable(brakePedal, wheelOmegaRear, speed) {
    if (this.dead || this.ers >= ERS_CAPACITY * 0.995) return 0;
    const lvl = this.ersMode === 0 ? 1.0 : this.ersMode === 1 ? 0.75 : 0.55;
    const w = Math.max(wheelOmegaRear, 12);
    const pMax = ERS_POWER * lvl;
    const t = Math.min(pMax / w, 2600);
    return t * clamp(brakePedal * 3, 0, 1) * (speed > 8 ? 1 : speed / 8);
  }

  /**
   * One tick. wOmegaRear = average rear wheel speed (rad/s).
   * Returns axle torque (Nm at wheels, + drives forward). Also integrates fuel/ERS.
   */
  update(dt, throttleIn, brakePedal, wOmegaRear, speed, wantUp, wantDown, regenTorqueActive, tcCut, limiter) {
    if (this.fuel <= 0 || this.dead) {
      this.engineTorque = 0; this.power = 0; this.fuelRate = 0; this.ersDeploy = 0;
      this.axleTorque = -this.engineBrakeAxle(wOmegaRear) * 0.3;
      this.rpm = Math.max(0, Math.min(this.rpm, wOmegaRear * GEAR_RATIOS[this.gear] * 9.5493));
      return this.axleTorque;
    }
    const ratio = GEAR_RATIOS[this.gear];
    const rpmWheel = wOmegaRear * ratio * 9.5493;

    // ---------- gear changes ----------
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.shiftCooldown <= 0) {
      let up = wantUp, down = wantDown;
      if (this.auto) {
        up = false; down = false;
        const thr = throttleIn;
        const upRpm = 12600 + 700 * thr;
        if (this.gear < 8 && rpmWheel > upRpm) up = true;
        else if (this.gear > 1) {
          const lower = GEAR_RATIOS[this.gear - 1];
          const rpmAfter = wOmegaRear * lower * 9.5493;
          const dnRpm = 6900 + 1800 * brakePedal;
          if (rpmWheel < dnRpm && rpmAfter < 14000) down = true;
        }
      }
      if (up && this.gear < 8) { this.gear++; this.shiftTimer = 0.045; this.shiftCooldown = 0.16; }
      else if (down && this.gear > 1) {
        const rpmAfter = wOmegaRear * GEAR_RATIOS[this.gear - 1] * 9.5493;
        if (rpmAfter < RPM_MAX_SAFE) { this.gear--; this.shiftTimer = 0.05; this.shiftCooldown = 0.16; }
      }
    }
    const g = GEAR_RATIOS[this.gear];
    const rpmW = wOmegaRear * g * 9.5493;

    // ---------- clutch / engine speed ----------
    const engage = 5600;
    if (rpmW >= engage || (this.clutchLocked && rpmW > RPM_IDLE * 0.95)) {
      this.clutchLocked = true;
      this.rpm = Math.max(rpmW, RPM_IDLE);
    } else {
      this.clutchLocked = false;
      const tgt = RPM_IDLE + (11500 - RPM_IDLE) * clamp(throttleIn * 1.3, 0, 1);
      this.rpm += (Math.max(tgt, rpmW) - this.rpm) * expK(9, dt);
    }
    // limiter with hysteresis
    if (this.rpm >= RPM_LIMIT) this.limiter = true;
    else if (this.rpm < RPM_LIMIT - 250) this.limiter = false;
    this.redline = this.rpm > RPM_LIMIT - 400;

    // ---------- torque ----------
    let thr = throttleIn * (1 - tcCut);
    if (limiter) thr = Math.min(thr, 0.22);
    this.throttleApplied += (thr - this.throttleApplied) * expK(32, dt); // pedal -> throttle body lag
    const tFull = table(TORQUE, this.rpm) * (0.55 + 0.45 * this.health);
    const tBrake = -(48 + 0.0092 * this.rpm) * this.engineBraking;
    let tIce = this.throttleApplied * tFull + (1 - this.throttleApplied) * tBrake;
    if (this.limiter) tIce = Math.min(tIce, tBrake * 0.4);
    if (this.shiftTimer > 0) tIce *= 0.35;
    // ERS
    const rpmE = Math.max(this.rpm, 3500);
    const wE = rpmE / 9.5493;
    let pDeploy = 0, pHarvest = 0;
    const lvlDeploy = this.ersMode === 0 ? 0.4 : this.ersMode === 1 ? 0.8 : 1.0;
    if (this.ers > 0 && this.throttleApplied > 0.5 && !this.limiter && this.shiftTimer <= 0) {
      pDeploy = ERS_POWER * lvlDeploy * clamp((this.throttleApplied - 0.5) * 2.5, 0, 1);
      // Deployment tapers off at very high speed (like the real 290 km/h fade-out), keeps top speed realistic.
      if (speed > 83) pDeploy *= clamp(1 - (speed - 83) / 22, 0, 1);
      if (this.ersMode !== 2 && this.ers < ERS_CAPACITY * 0.1) pDeploy *= this.ers / (ERS_CAPACITY * 0.1);
    }
    // MGU-H harvest at high rpm/full throttle (small), MGU-K harvest from the brake system
    if (this.throttleApplied > 0.6 && this.rpm > 9000 && pDeploy === 0) pHarvest += (this.ersMode === 0 ? 55e3 : 28e3);
    if (regenTorqueActive > 0) pHarvest += regenTorqueActive * wOmegaRear;
    pHarvest = Math.min(pHarvest, 190e3);
    this.ersDeploy = pDeploy;
    this.ersHarvest = pHarvest;
    this.ers = clamp(this.ers - pDeploy * dt + pHarvest * dt * 0.92, 0, ERS_CAPACITY);
    const tErs = pDeploy / wE;
    let tCrank = tIce + tErs;
    this.engineTorque = tIce;
    this.power = Math.max(0, tIce * wE) + pDeploy;

    // fuel
    const pIce = Math.max(0, tIce * wE);
    this.fuelRate = pIce * FUEL_PER_JOULE + (this.rpm > RPM_IDLE ? 0.0006 : 0);
    this.fuel = Math.max(0, this.fuel - this.fuelRate * dt);

    // torque at the wheels. Clutch slip at launch limits what reaches the axle.
    let axle;
    if (this.clutchLocked) axle = tCrank * g * DRIVELINE_EFF;
    else {
      const clutchCap = 520; // Nm engine side
      const slip = clamp((this.rpm - rpmW) / 3000, 0, 1);
      axle = clamp(tCrank, -clutchCap, clutchCap) * g * DRIVELINE_EFF * (0.55 + 0.45 * slip);
    }
    this.axleTorque = axle;
    return axle;
  }

  engineBrakeAxle(wOmega) {
    return (48 + 0.0092 * this.rpm) * this.engineBraking * GEAR_RATIOS[this.gear];
  }

  /** inertia reflected to the axle (kg m^2, for both wheels combined) */
  reflectedInertia() {
    const g = GEAR_RATIOS[this.gear];
    return this.clutchLocked ? I_DRIVE * g * g : 0;
  }
}
