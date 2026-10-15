// CarModel: procedural single-seater with three levels of detail, animated suspension/wheels/wings/DRS and damage visuals.
// Geometry is built once and shared; every team gets one set of materials (+ baked vertex-colour LODs for far cars).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR, WX, WY } from '../physics/VehiclePhysics.js';
import { TEAMS } from '../race/Roster.js';
import { COMPOUNDS } from '../physics/TireModel.js';
import { carbonTexture } from './Textures.js';
import { wrapPi } from '../core/math.js';

// ------------------------------------------------------------------ geometry helpers (+x = left, +y = up, +z = forward)
function boxG(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z); return g;
}
function cylG(r1, r2, h, seg, x, y, z, axis = 'x') {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z); return g;
}
function tubeG(a, b, r, seg = 6) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  const m = va.clone().add(vb).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z); return g;
}
/** lofted body from cross-sections with chamfered corners; optional x offset (side pods) */
function loft(sections, xOff = 0, chamfer = 0.045) {
  const pos = [], idx = [];
  const ring = (s) => {
    const w = s.w, b = s.bot, t = s.top, c = Math.min(chamfer, w * 0.9, (t - b) * 0.45);
    return [[-w + c, b], [w - c, b], [w, b + c], [w, t - c], [w - c, t], [-w + c, t], [-w, t - c], [-w, b + c]];
  };
  const rings = sections.map((s) => ring(s));
  const per = 8;
  rings.forEach((r, i) => r.forEach((p) => pos.push(p[0] + xOff, p[1], sections[i].z)));
  for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < per; k++) {
    const a = i * per + k, b = i * per + ((k + 1) % per), c = (i + 1) * per + k, d = (i + 1) * per + ((k + 1) % per);
    idx.push(a, c, b, b, c, d);
  }
  // caps
  const cf = pos.length / 3; pos.push(xOff, (sections[0].bot + sections[0].top) / 2, sections[0].z);
  for (let k = 0; k < per; k++) idx.push(cf, k, (k + 1) % per);
  const last = rings.length - 1; const cb = pos.length / 3; pos.push(xOff, (sections[last].bot + sections[last].top) / 2, sections[last].z);
  for (let k = 0; k < per; k++) idx.push(cb, last * per + ((k + 1) % per), last * per + k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
const strip = (g) => { const r = g.index ? g.toNonIndexed() : g.clone(); for (const k of Object.keys(r.attributes)) if (!['position', 'normal', 'color'].includes(k)) r.deleteAttribute(k); return r; };
const merge = (list) => mergeGeometries(list.map(strip), false);
function tint(g, color) {
  const n = g.attributes.position.count, c = new THREE.Color(color), arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return g;
}
function clean(g) { const r = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(r.attributes)) if (!['position', 'normal', 'color'].includes(k)) r.deleteAttribute(k); return r; }

let SHARED = null;
function buildShared() {
  if (SHARED) return SHARED;
  const S = {};
  // ---- main body (carbon monocoque) + engine cover + airbox
  const mono = loft([
    { z: 2.45, w: 0.035, bot: 0.085, top: 0.15 }, { z: 2.1, w: 0.085, bot: 0.09, top: 0.22 }, { z: 1.5, w: 0.17, bot: 0.10, top: 0.30 },
    { z: 0.9, w: 0.24, bot: 0.10, top: 0.44 }, { z: 0.35, w: 0.28, bot: 0.11, top: 0.55 }, { z: -0.4, w: 0.27, bot: 0.12, top: 0.62 },
    { z: -1.2, w: 0.22, bot: 0.14, top: 0.55 }, { z: -2.0, w: 0.12, bot: 0.20, top: 0.40 }, { z: -2.35, w: 0.07, bot: 0.28, top: 0.40 },
  ]);
  const airbox = loft([{ z: 0.05, w: 0.12, bot: 0.58, top: 0.66 }, { z: -0.1, w: 0.17, bot: 0.55, top: 0.88 }, { z: -0.6, w: 0.15, bot: 0.55, top: 0.88 }, { z: -1.0, w: 0.08, bot: 0.52, top: 0.7 }], 0, 0.03);
  const podL = loft([{ z: 0.65, w: 0.15, bot: 0.1, top: 0.32 }, { z: 0.0, w: 0.21, bot: 0.1, top: 0.42 }, { z: -0.9, w: 0.2, bot: 0.1, top: 0.36 }, { z: -1.8, w: 0.07, bot: 0.12, top: 0.2 }], 0.50);
  const podR = loft([{ z: 0.65, w: 0.15, bot: 0.1, top: 0.32 }, { z: 0.0, w: 0.21, bot: 0.1, top: 0.42 }, { z: -0.9, w: 0.2, bot: 0.1, top: 0.36 }, { z: -1.8, w: 0.07, bot: 0.12, top: 0.2 }], -0.50);
  const floor = loft([{ z: 1.5, w: 0.45, bot: 0.04, top: 0.075 }, { z: 0.8, w: 0.82, bot: 0.04, top: 0.075 }, { z: -1.8, w: 0.74, bot: 0.04, top: 0.075 }, { z: -2.15, w: 0.5, bot: 0.07, top: 0.11 }], 0, 0.01);
  const diffuser = boxG(0.9, 0.02, 0.5, 0, 0.12, -2.25, 0.25);
  // ---- livery pieces (accent colour)
  const stripe = loft([{ z: -0.1, w: 0.045, bot: 0.866, top: 0.884 }, { z: -0.6, w: 0.045, bot: 0.866, top: 0.884 }], 0, 0.005);
  const stripeNose = boxG(0.14, 0.012, 0.9, 0, 0.255, 1.6, -0.12);
  const podStripeL = boxG(0.04, 0.012, 1.3, 0.50, 0.425, -0.3), podStripeR = boxG(0.04, 0.012, 1.3, -0.50, 0.425, -0.3);
  // ---- front wing (halves are separate so damage can remove one)
  const fw = (sx) => merge([
    boxG(1.0, 0.025, 0.36, sx * 0.5, 0.10, 2.62), boxG(0.9, 0.02, 0.22, sx * 0.55, 0.165, 2.55, -0.18), boxG(0.8, 0.02, 0.18, sx * 0.6, 0.225, 2.5, -0.3),
    boxG(0.025, 0.2, 0.5, sx * 0.99, 0.17, 2.58),
  ]);
  const fwNose = merge([boxG(0.05, 0.1, 0.5, 0.12, 0.13, 2.25), boxG(0.05, 0.1, 0.5, -0.12, 0.13, 2.25)]);
  // ---- rear wing: fixed part + DRS flap (pivot at the flap's leading edge)
  const rwFixed = merge([boxG(0.95, 0.03, 0.42, 0, 0.92, -2.5), boxG(0.02, 0.55, 0.5, 0.48, 0.74, -2.5), boxG(0.02, 0.55, 0.5, -0.48, 0.74, -2.5), boxG(0.07, 0.5, 0.1, 0, 0.66, -2.35), boxG(0.7, 0.02, 0.22, 0, 0.45, -2.38)]);
  const rwFlap = boxG(0.93, 0.025, 0.28, 0, 0, -0.14); // origin at the pivot
  // ---- halo, helmet, mirrors, steering wheel
  const halo = merge([tubeG([0.0, 0.64, 0.74], [0.0, 0.84, 0.50], 0.022), tubeG([0.0, 0.84, 0.50], [0.2, 0.8, 0.12], 0.02), tubeG([0.0, 0.84, 0.50], [-0.2, 0.8, 0.12], 0.02), tubeG([0.2, 0.8, 0.12], [0.24, 0.6, 0.12], 0.02), tubeG([-0.2, 0.8, 0.12], [-0.24, 0.6, 0.12], 0.02)]);
  const helmet = new THREE.SphereGeometry(0.135, 12, 10); helmet.translate(0, 0.72, 0.1);
  const mirrors = merge([boxG(0.14, 0.07, 0.06, 0.46, 0.72, 0.72), boxG(0.14, 0.07, 0.06, -0.46, 0.72, 0.72)]);
  // ---- wheel parts (origin at the wheel centre; wide wheels are scaled for the rear)
  const tire = (w) => cylG(1, 1, w, 22, 0, 0, 0); // radius scaled per wheel
  S.tire = [tire(0.40), tire(0.46)];
  S.rim = [cylG(0.58, 0.58, 0.41, 14, 0, 0, 0), cylG(0.58, 0.58, 0.47, 14, 0, 0, 0)];
  S.disc = cylG(0.38, 0.38, 0.05, 14, 0, 0, 0);
  S.ring = new THREE.RingGeometry(0.80, 0.97, 24); S.ring.rotateY(Math.PI / 2);
  // ---- suspension arms (body space)
  const arms = [];
  for (let i = 0; i < 4; i++) {
    const x = Math.sign(WY[i]) * 0.3, side = Math.sign(WY[i]);
    const wx = WX[i], wy = WY[i] - Math.sign(WY[i]) * 0.2;
    arms.push(tubeG([side * 0.25, 0.23, wx + 0.28], [wy, 0.32, wx + 0.02], 0.012), tubeG([side * 0.25, 0.17, wx - 0.28], [wy, 0.30, wx - 0.02], 0.012));
  }
  const armsG = merge(arms);
  S.parts = { mono, airbox, podL, podR, floor, diffuser, stripe, stripeNose, podStripeL, podStripeR, fwL: fw(1), fwR: fw(-1), fwNose, rwFixed, rwFlap, halo, helmet, mirrors, armsG };
  S.carbon = merge([floor, diffuser, fwNose, halo, mirrors, armsG].map((g) => g.clone()));
  SHARED = S; return S;
}

// ------------------------------------------------------------------ materials per team
const matCache = new Map();
function teamMaterials(teamIdx, quality) {
  const key = teamIdx + ':' + quality;
  if (matCache.has(key)) return matCache.get(key);
  const t = TEAMS[teamIdx % TEAMS.length];
  const std = quality === 'low' ? (p) => new THREE.MeshLambertMaterial({ color: p.color }) : (p) => new THREE.MeshStandardMaterial(p);
  const m = {
    body: quality === 'low' ? std({ color: t.color }) : new THREE.MeshPhysicalMaterial({ color: t.color, metalness: 0.35, roughness: 0.3, clearcoat: quality === 'high' ? 1.0 : 0.5, clearcoatRoughness: 0.12 }),
    accent: std({ color: t.accent, metalness: 0.2, roughness: 0.4 }),
    carbon: std({ color: 0x2b2d34, metalness: 0.3, roughness: 0.42 }),
    black: new THREE.MeshLambertMaterial({ color: 0x1f2024 }),
    rim: std({ color: 0xb8bcc4, metalness: 0.9, roughness: 0.25 }),
    helmet: std({ color: t.accent, metalness: 0.2, roughness: 0.3 }),
  };
  matCache.set(key, m); return m;
}
const lodGeoCache = new Map();
function lodGeometry(teamIdx, level) {
  const key = teamIdx + ':' + level;
  if (lodGeoCache.has(key)) return lodGeoCache.get(key);
  const S = buildShared(), P = S.parts, t = TEAMS[teamIdx % TEAMS.length];
  const gs = [
    tint(clean(merge([P.mono, P.airbox, P.podL, P.podR])), t.color),
    tint(clean(merge([P.stripe, P.stripeNose, P.podStripeL, P.podStripeR])), t.accent),
    tint(clean(merge([P.floor, P.diffuser, P.fwNose, P.halo, P.mirrors, P.rwFixed])), 0x25272d),
    tint(clean(merge([P.fwL, P.fwR])), 0x2a2c33),
    tint(clean(P.helmet.clone()), t.accent),
  ];
  const body = merge(gs.map((g) => g));
  const flap = tint(clean(P.rwFlap.clone().translate(0, 1.0, -2.4)), 0x1a1b20);
  const out = merge([body, flap]);
  lodGeoCache.set(key, out); return out;
}
const wheelLod = new Map();
function wheelGeo(rear, compound) {
  const key = (rear ? 'r' : 'f') + compound;
  if (wheelLod.has(key)) return wheelLod.get(key);
  const S = buildShared(); const R = rear ? CAR.Rw[2] : CAR.Rw[0];
  const idx = rear ? 1 : 0;
  const tire = tint(clean(S.tire[idx].clone().scale(R, 1, R)), 0x25272c);
  const rim = tint(clean(S.rim[idx].clone().scale(R, 1, R)), 0xaab0b8);
  const comp = tint(clean(S.ring.clone().scale(1, R, R).translate(rear ? 0.235 : 0.205, 0, 0)), new THREE.Color(COMPOUNDS[compound].color));
  const g = merge([tire, rim, comp]);
  wheelLod.set(key, g); return g;
}

export class CarVisual {
  constructor(teamIdx, quality, opts = {}) {
    this.teamIdx = teamIdx; this.quality = quality;
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.body = new THREE.Group(); this.body.rotation.order = 'XYZ';    // pitch / roll visuals
    this.root.add(this.body);
    this.lodLevel = -1;
    this.compound = null;
    this.ghost = !!opts.ghost;
    this.lastLap = 0;
    this.build();
    this.setLod(opts.lod ?? 0);
  }

  build() {
    const S = buildShared(), P = S.parts;
    const M = teamMaterials(this.teamIdx, this.quality);
    const ghostMat = this.ghost ? new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.35, depthWrite: false }) : null;
    const mat = (m) => ghostMat || m;
    // ---------------- LOD0
    const l0 = new THREE.Group(); this.l0 = l0; this.body.add(l0);
    const mesh = (g, m, shadow = true) => { const o = new THREE.Mesh(g, mat(m)); o.castShadow = shadow && !this.ghost; return o; };
    l0.add(mesh(merge([P.mono, P.airbox, P.podL, P.podR]), M.body));
    l0.add(mesh(merge([P.stripe, P.stripeNose, P.podStripeL, P.podStripeR]), M.accent, false));
    l0.add(mesh(merge([P.floor, P.diffuser, P.fwNose, P.halo, P.mirrors, P.armsG]), M.carbon));
    this.rwFixedMesh = mesh(P.rwFixed, M.carbon); l0.add(this.rwFixedMesh);
    this.fwL = mesh(P.fwL, M.carbon); this.fwR = mesh(P.fwR, M.carbon); l0.add(this.fwL, this.fwR);
    this.rwFlap = new THREE.Group(); this.rwFlap.position.set(0, 1.0, -2.4); this.rwFlap.add(mesh(P.rwFlap, M.carbon)); l0.add(this.rwFlap);
    const helmet = mesh(P.helmet, M.helmet, false); l0.add(helmet);
    // wheels (each: pivot for steering -> spin group)
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const rear = i >= 2, R = CAR.Rw[i];
      const pivot = new THREE.Group(); const spin = new THREE.Group();
      const tireM = new THREE.Mesh(S.tire[rear ? 1 : 0], mat(M.black)); tireM.scale.set(1, R, R); tireM.castShadow = !this.ghost;
      const rimM = new THREE.Mesh(S.rim[rear ? 1 : 0], mat(M.rim)); rimM.scale.set(1, R, R);
      const discMat = new THREE.MeshBasicMaterial({ color: 0x331100 });
      const disc = new THREE.Mesh(S.disc, ghostMat || discMat); disc.scale.set(1, R, R);
      const ring = new THREE.Mesh(S.ring, ghostMat || new THREE.MeshBasicMaterial({ color: 0xffd23b, side: THREE.DoubleSide })); ring.scale.set(1, R, R);
      const out = Math.sign(WY[i]);
      ring.position.x = out * (rear ? 0.235 : 0.205); ring.rotation.y = out > 0 ? 0 : Math.PI;
      spin.add(tireM, rimM, disc, ring); pivot.add(spin);
      pivot.position.set(WY[i], R, WX[i]);
      this.body.add(pivot);
      this.wheels.push({ pivot, spin, ring, discMat, disc, R, ringMat: ring.material, tire: tireM });
      pivot.visible = true;
    }
    // ---------------- LOD1: baked body + 4 wheels
    const l1 = new THREE.Group(); this.l1 = l1; this.root.add(l1);
    const vm = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.l1Body = new THREE.Mesh(lodGeometry(this.teamIdx, 1), ghostMat || vm); l1.add(this.l1Body);
    this.l1Wheels = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(wheelGeo(i >= 2, 'medium'), ghostMat || vm); m.rotation.order = 'YXZ'; m.position.set(WY[i], CAR.Rw[i], WX[i]); l1.add(m); this.l1Wheels.push(m);
    }
    // ---------------- LOD2: one static mesh
    const l2 = new THREE.Group(); this.l2 = l2; this.root.add(l2);
    const g2 = merge([lodGeometry(this.teamIdx, 2), ...[0, 1, 2, 3].map((i) => wheelGeo(i >= 2, 'medium').clone().translate(WY[i], CAR.Rw[i], WX[i]))]);
    l2.add(new THREE.Mesh(g2, ghostMat || vm));
    this.fwLost = [false, false]; this.rwLost = false;
    // camera anchors (driver eyes, T-cam above the airbox, nose cam)
    const mkA = (x, y, z) => { const a = new THREE.Object3D(); a.position.set(x, y, z); this.body.add(a); return a; };
    this.anchors = { cockpit: mkA(0, 0.86, 0.22), tcam: mkA(0, 1.18, -0.75), nose: mkA(0, 0.36, 1.95) };
    this.helmetMesh = helmet;
  }

  setLod(l) {
    if (l === this.lodLevel) return;
    this.lodLevel = l;
    this.body.visible = l === 0; this.l1.visible = l === 1; this.l2.visible = l === 2;
  }

  setCompound(id) {
    if (this.compound === id) return; this.compound = id;
    const c = COMPOUNDS[id].color;
    for (const w of this.wheels) w.ringMat.color && w.ringMat.color.set(c);
  }

  /** static pose for non-simulated cars (safety car, showroom) */
  setPose(x, y, z, psi) { this.root.position.set(x, y, z); this.root.rotation.y = psi; }

  /** apply the interpolated pose and the animated bits from the simulation state */
  update(car, alpha, track, vis = 4) {
    const pv = car.prev;
    const x = pv[0] + (car.x - pv[0]) * alpha, z = pv[1] + (car.z - pv[1]) * alpha;
    const yTrack = pv[2] + (car.y - pv[2]) * alpha;
    const psi = pv[3] + wrapPi(car.psi - pv[3]) * alpha;
    const heave = pv[4] + (car.h - pv[4]) * alpha, pitch = pv[5] + (car.th - pv[5]) * alpha, roll = pv[6] + (car.ph - pv[6]) * alpha;
    const steer = pv[7] + (car.steer - pv[7]) * alpha;
    const loc = car.loc;
    this.root.position.set(x, yTrack + heave * vis * 0.4, z);
    this.root.rotation.y = psi;
    // follow the road surface slope/camber + exaggerated body motion
    const grade = Math.atan(loc.slope), camber = Math.atan(loc.cross);
    this.root.rotation.x = -(grade) * 0.0;
    this.body.rotation.x = -(grade + pitch * vis);
    this.body.rotation.z = camber + roll * vis;
    if (this.lodLevel === 0) {
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        const a = pv[8 + i] + (car.wheelAngle[i] - pv[8 + i]) * alpha;
        w.spin.rotation.x = -(a % (Math.PI * 2));
        if (i < 2) w.pivot.rotation.y = steer;
        const lift = (car.d[i] * vis * 2.2);
        w.pivot.position.y = w.R + lift;
        const gone = car.damage.wheelOff[i] === 1;
        w.pivot.visible = !gone;
        // brake disc glow
        const T = car.brakes.temp[i];
        const g = Math.max(0, Math.min(1, (T - 350) / 650));
        w.discMat.color.setRGB(0.2 + g * 0.8, 0.07 + g * 0.35, 0.03 + g * 0.05);
      }
      const d = car.damage;
      this.fwL.visible = d.fwL < 0.92; this.fwR.visible = d.fwR < 0.92;
      this.fwL.rotation.z = -d.fwL * 0.35; this.fwR.rotation.z = d.fwR * 0.35;
      this.fwL.position.y = -d.fwL * 0.05; this.fwR.position.y = -d.fwR * 0.05;
      this.rwFlap.visible = d.rw < 0.9; this.rwFixedMesh.visible = d.rw < 0.9;
      this.rwFlap.rotation.x = car.aero.drsOpen * 0.55 + d.rw * 0.25;
      this.setCompound(car.compound.id);
    } else if (this.lodLevel === 1) {
      for (let i = 0; i < 4; i++) {
        const m = this.l1Wheels[i];
        const a = pv[8 + i] + (car.wheelAngle[i] - pv[8 + i]) * alpha;
        m.rotation.x = -(a % (Math.PI * 2)); if (i < 2) m.rotation.y = steer;
        m.visible = car.damage.wheelOff[i] !== 1;
      }
    }
  }
}

export { buildShared };
