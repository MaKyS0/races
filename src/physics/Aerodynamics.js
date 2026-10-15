// Aerodynamics: downforce ~ v^2, drag ~ v^2 (limits top speed), wing setup, ride-height platform effect,
// slipstream (drag reduction) and dirty air (downforce loss) for cars following another, DRS.
import { clamp } from '../core/math.js';

export const AIR_RHO = 1.2;

export const DEFAULT_AERO_SETUP = { frontWing: 5, rearWing: 5 }; // 0..10

export class Aerodynamics {
  constructor() {
    this.setup = { frontWing: 5, rearWing: 5 };
    this.drsOpen = 0;       // 0..1 flap position
    this.wake = 0;          // 0..1 slipstream strength (drag reduction)
    this.dirty = 0;         // 0..1 dirty air (downforce loss)
    // outputs
    this.downF = 0; this.downR = 0; this.drag = 0; this.cla = 0; this.cda = 0;
    this.balance = 0.4;
    this.floorFront = 1; this.floorRear = 1;
  }

  /** compute ClA / CdA from setup and damage. d = damage {fwL, fwR, rw, floor} each 0 ok..1 gone */
  coefficients(d) {
    const fw = this.setup.frontWing, rw = this.setup.rearWing;
    const fwHealth = 1 - 0.5 * (d.fwL + d.fwR);
    const claFw = (0.35 + 0.075 * fw) * (fwHealth > 0 ? fwHealth : 0);
    const rwHealth = 1 - d.rw;
    const drs = this.drsOpen;
    const claRw = (0.45 + 0.085 * rw) * rwHealth * (1 - 0.34 * drs);
    const floorH = 1 - 0.8 * d.floor;
    // damaged front wing also throws the floor's airflow off
    const floorMul = floorH * (1 - 0.12 * (d.fwL + d.fwR));
    const claFloorF = 0.88 * floorMul, claFloorR = 1.60 * floorMul;
    return { claFw, claRw, claFloorF, claFloorR, drs, rw, fw };
  }

  /**
   * @param q dynamic pressure 0.5*rho*v^2   rideF/rideR ride-height change in mm (+ = lower to the ground)
   */
  update(q, rideF, rideR, d) {
    const c = this.coefficients(d);
    const gF = clamp(1 + 0.010 * rideF, 0.72, 1.22);
    const gR = clamp(1 + 0.010 * rideR, 0.72, 1.22);
    const dirt = 1 - 0.34 * this.dirty;           // dirty air hurts mostly the front axle
    const dirtF = 1 - 0.42 * this.dirty;
    const claF = (c.claFw * dirtF + c.claFloorF * gF * dirt);
    const claR = (c.claRw * dirt + c.claFloorR * gR * dirt);
    this.downF = q * claF;
    this.downR = q * claR;
    this.cla = claF + claR;
    this.balance = claF / (claF + claR + 1e-6);
    // drag: body + wing drag + lift-induced drag; DRS strips most of the rear wing drag.
    const wingDrag = 0.016 * c.fw * (1 - 0.35 * d.fwL - 0.35 * d.fwR) + 0.040 * c.rw * (1 - d.rw * 0.6) * (1 - 0.72 * c.drs);
    const bodyDrag = 0.70 + 0.6 * d.floor * 0 + 0.07 * (d.fwL + d.fwR) + 0.1 * d.rw;
    this.cda = (bodyDrag + wingDrag + 0.075 * this.cla) * (1 - 0.27 * this.wake);
    this.drag = q * this.cda;
  }
}

/**
 * Computes slipstream/dirty-air for every car from the cars ahead (uses the spatial grid neighbour lists).
 * Cars must expose x,z,psi,u. Allocation free.
 */
export function computeWake(car, others, count) {
  let wake = 0, dirty = 0;
  const sn = Math.sin(car.psi), cs = Math.cos(car.psi);
  for (let k = 0; k < count; k++) {
    const o = others[k];
    if (o === car || o.retired) continue;
    const dx = o.x - car.x, dz = o.z - car.z;
    const ahead = dx * sn + dz * cs;           // distance in front of me along my heading
    if (ahead < 3 || ahead > 85) continue;
    const lat = dx * cs - dz * sn;             // left offset
    // wake follows the leader's heading; use a cone widening with distance
    const half = 1.1 + ahead * 0.045;
    const al = Math.abs(lat);
    if (al > half + 1.2) continue;
    const lateralF = clamp(1 - Math.max(0, al - 0.4) / (half + 0.8), 0, 1);
    const dist = ahead - 5;                     // gap from nose to tail roughly
    const w = lateralF * clamp(1 - Math.max(0, dist) / 80, 0, 1);
    if (w > wake) wake = w;
    const dd = lateralF * clamp(1 - Math.max(0, dist - 2) / 45, 0, 1);
    if (dd > dirty) dirty = dd;
  }
  car.aero.wake = wake;
  car.aero.dirty = dirty;
}
