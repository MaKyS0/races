import { describe, it, expect } from 'vitest';
import { getTrack } from '../src/track/circuits/index.js';
import { Vehicle, CAR } from '../src/physics/VehiclePhysics.js';
import { CollisionSystem } from '../src/physics/CollisionAndDamage.js';

const track = getTrack('silverstone');
const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 1 };
const DT = 1 / 120;
function mk(id, s, n, v, rev = false) {
  const c = new Vehicle(id); c.assists.tc = 0; c.setFuel(30); c.fitTyres('medium', 90);
  c.place(track, s, n, v); if (rev) { c.psi += Math.PI; c.vx = -c.vx; c.vz = -c.vz; }
  c.d = { isPlayer: false }; c.retired = false;
  return c;
}
function sim(cars, steps, cs = new CollisionSystem(), free = true) {
  const ev = [];
  for (let i = 0; i < steps; i++) {
    for (const c of cars) { c.ctrl.throttle = 0; c.ctrl.brake = 0; c.step(DT, track, { ...ENV, forceSurface: free ? 0 : undefined }); }
    cs.clearEvents(); cs.update(cars, cars.length, track, DT);
    for (const e of cs.events) ev.push({ ...e });
  }
  return ev;
}
const mom = (cars) => cars.reduce((a, c) => [a[0] + c.mass * c.vx, a[1] + c.mass * c.vz], [0, 0]);

describe('car-car collisions', () => {
  it('head-on: both cars lose most of their speed, momentum is conserved, wings break', () => {
    const a = mk(0, 1000, 0, 50), b = mk(1, 1009, 0, 50, true);
    a.step(DT, track, ENV); b.step(DT, track, ENV);
    const p0 = mom([a, b]);
    const ev = sim([a, b], 120);
    const p1 = mom([a, b]);
    expect(ev.length).toBeGreaterThan(0);
    expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / (a.mass * 50)).toBeLessThan(0.12);
    expect(a.speed).toBeLessThan(18); expect(b.speed).toBeLessThan(18);
    expect(a.damage.fwL + a.damage.fwR).toBeGreaterThan(1.4); expect(b.damage.fwL + b.damage.fwR).toBeGreaterThan(1.4);
  });
  it('rear-end: the striker is identified, the car ahead gains speed, rear wing/front wing damage follow', () => {
    const behind = mk(0, 1000, 0, 60), ahead = mk(1, 1007, 0, 40);
    behind.step(DT, track, ENV); ahead.step(DT, track, ENV);
    const p0 = mom([behind, ahead]);
    const ev = sim([behind, ahead], 60);
    const hit = ev.find((e) => e.type === 'impact' && e.b);
    expect(hit).toBeTruthy(); expect(hit.striker).toBe(behind);
    expect(behind.speed).toBeLessThan(60 - 4); expect(ahead.speed).toBeGreaterThan(40 + 1);
    const p1 = mom([behind, ahead]);
    expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / Math.hypot(p0[0], p0[1])).toBeLessThan(0.12);
    expect(ahead.damage.rw).toBeGreaterThan(0.2); expect(behind.damage.fwL + behind.damage.fwR).toBeGreaterThan(0.2);
  });
  it('a light touch does not wreck the cars', () => {
    const a = mk(0, 1000, 0, 40), b = mk(1, 1000, 2.2, 40);   // wheels almost touching
    a.step(DT, track, ENV); b.step(DT, track, ENV);
    a.vx += Math.cos(a.psi) * 0.6; a.vz -= Math.sin(a.psi) * 0.6;   // drift 0.6 m/s sideways into b
    sim([a, b], 60);
    expect(a.damage.chassis).toBe(0); expect(a.damage.sus.every((x) => x < 0.2)).toBe(true); expect(a.retired).toBe(false);
  });
  it('impact severity scales with speed', () => {
    const hitAt = (v) => { const a = mk(0, 1000, 0, v), b = mk(1, 1008, 0, 15); a.step(DT, track, ENV); b.step(DT, track, ENV); sim([a, b], 80); return a.damage.fwL + a.damage.fwR + a.damage.chassis * 4; };
    const slow = hitAt(22), fast = hitAt(70);
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeLessThan(2.1);
  });
  it('an off-centre hit changes heading and yaw rate (impulse acts at the contact point)', () => {
    const ahead = mk(0, 1004, 0, 40), striker = mk(1, 996, 0, 55);
    ahead.step(DT, track, ENV); striker.step(DT, track, ENV);
    striker.x += Math.cos(striker.psi) * 1.0; striker.z -= Math.sin(striker.psi) * 1.0;   // nose lands on one side of the tail
    const ev = sim([striker, ahead], 40);
    expect(ev.some((e) => e.type === 'impact')).toBe(true);
    expect(Math.abs(striker.r) + Math.abs(ahead.r)).toBeGreaterThan(0.05);
  });
  it('overlapping cars are separated', () => {
    const a = mk(0, 1000, 0, 0), b = mk(1, 1000, 0.8, 0);
    sim([a, b], 30);
    const d = Math.hypot(a.x - b.x, a.z - b.z); expect(d).toBeGreaterThan(1.5);
  });
  it('broad phase only tests nearby pairs', () => {
    const cars = []; for (let i = 0; i < 20; i++) cars.push(mk(i, 100 + i * 120, 0, 30));
    const cs = new CollisionSystem(); cs.update(cars, 20, track, DT);
    expect(cs.pairCount).toBeLessThan(5);
  });
});

describe('barriers', () => {
  const wallN = track.wallL[500];
  function wallHit(v, ang = 0.0) {
    const c = mk(0, 1200, wallN - 8, v); c.d.isPlayer = false;
    c.psi += ang; c.vx = Math.sin(c.psi) * v; c.vz = Math.cos(c.psi) * v;
    c.place(track, 1200, wallN - 6, v, ang);
    const cs = new CollisionSystem(); let impacts = 0, maxN = 0;
    for (let i = 0; i < 240; i++) {
      c.ctrl.brake = 0; c.step(DT, track, { ...ENV, forceSurface: 0 }); cs.clearEvents(); cs.update([c], 1, track, DT);
      impacts += cs.events.length; for (const e of cs.events) maxN = Math.max(maxN, e.speed);
    }
    return { c, impacts, maxN };
  }
  it('walls stop cars physically (no tunnelling) and damage them', () => {
    const r = wallHit(45, 0.55);
    expect(r.impacts).toBeGreaterThan(0);
    const wall = track.wallL[r.c.loc.i];
    expect(r.c.loc.n).toBeLessThan(wall + 0.5);
    expect(r.c.damage.fwL + r.c.damage.fwR + r.c.damage.sus[0] + r.c.damage.sus[1] + r.c.damage.chassis).toBeGreaterThan(0.3);
  });
  it('severity: a low-speed scrape is survivable, a high-speed head-on is not', () => {
    const gentle = wallHit(14, 0.15), brutal = wallHit(80, 0.9);
    expect(gentle.c.retired).toBe(false);
    expect(brutal.c.damage.chassis + brutal.c.damage.sus.reduce((a, b) => a + b, 0)).toBeGreaterThan(gentle.c.damage.chassis + gentle.c.damage.sus.reduce((a, b) => a + b, 0) + 0.5);
    expect(brutal.maxN).toBeGreaterThan(gentle.maxN);
  });
  it('damage changes handling: a broken front wing shifts the aero balance rearwards', () => {
    const c = mk(0, 1000, 0, 60); c.step(DT, track, ENV);
    const q = 0.5 * 1.2 * 80 * 80; c.aero.update(q, 0, 0, c.damage); const b0 = c.aero.balance, d0 = c.aero.downF + c.aero.downR;
    c.damage.fwL = 1; c.damage.fwR = 1; c.aero.update(q, 0, 0, c.damage);
    expect(c.aero.balance).toBeLessThan(b0 - 0.08); expect(c.aero.downF + c.aero.downR).toBeLessThan(d0 * 0.9);
  });
  it('a punctured tyre loses grip and a lost wheel drags the corner', () => {
    const c = mk(0, 1000, 0, 60); c.step(DT, track, ENV);
    c.tires[0].puncture = 1; c.tires[0].eval(3000, 0, 0.1, { paved: true, mu: 1, muWet: 1, crr: 0.012, dig: 0 }, 0, 40, 1); const flat = c.tires[0].mu;
    c.tires[0].puncture = 0; c.tires[0].eval(3000, 0, 0.1, { paved: true, mu: 1, muWet: 1, crr: 0.012, dig: 0 }, 0, 40, 1);
    expect(flat).toBeLessThan(c.tires[0].mu * 0.6);
  });
});
