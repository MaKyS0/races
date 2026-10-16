// CarModel: procedural single-seater (geometry in CarParts.js) with three levels of detail, animated suspension / wheels / wings / DRS
// and damage visuals. Geometry is built once and shared by every car; each team gets its own materials (+ baked vertex-colour LODs for far cars).
//   LOD0 (focus car / near cars): ~10 meshes for the body + 4 wheels x 4 meshes, lazily built the first time a car needs it
//   LOD1: baked body (one mesh) + 4 wheels,  LOD2: one static mesh
import * as THREE from 'three';
import { CAR, WX, WY } from '../physics/VehiclePhysics.js';
import { TEAMS } from '../race/Roster.js';
import { COMPOUNDS } from '../physics/TireModel.js';
import { wrapPi } from '../core/math.js';
import { buildParts, merge, tint, clean, wheelSpinGeo, wheelStaticGeo, discGeo, ringGeo, topAt, MONO, COL } from './CarParts.js';
import { applyLivery, applyDetail, bakeLivery, bakeMarkers, liveryOf } from './Livery.js';

const DETAIL = { low: 0, medium: 1, high: 2, std: 1 };
const partsCache = new Map();
function partsFor(detail) { if (!partsCache.has(detail)) partsCache.set(detail, buildParts(detail)); return partsCache.get(detail); }
const wheelCache = new Map();
function wheelGeos(rear, side, D) {
  const key = `${rear ? 'r' : 'f'}${side}${D}`;
  if (!wheelCache.has(key)) wheelCache.set(key, { spin: wheelSpinGeo(rear, D), disc: discGeo(rear, D), ring: ringGeo(rear, D), stat: wheelStaticGeo(rear, side, D) });
  return wheelCache.get(key);
}

// ------------------------------------------------------------------ materials per team
const matCache = new Map();
function teamMaterials(teamIdx, quality) {
  const key = teamIdx + ':' + quality;
  if (matCache.has(key)) return matCache.get(key);
  const t = TEAMS[teamIdx % TEAMS.length], low = quality === 'low';
  const std = low ? (p) => new THREE.MeshLambertMaterial({ color: p.color, vertexColors: !!p.vertexColors }) : (p) => new THREE.MeshStandardMaterial(p);
  // paint finish per team: gloss (clear coat), metal flake (silver) or matte (onyx)
  const L = liveryOf(teamIdx), hi = quality === 'high';
  const paint = L.finish === 'matte' ? { metalness: 0.05, roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5 }
    : L.finish === 'metal' ? { metalness: 0.6, roughness: 0.3, clearcoat: hi ? 1.0 : 0.6, clearcoatRoughness: 0.08 }
      : { metalness: 0.12, roughness: 0.34, clearcoat: hi ? 1.0 : 0.6, clearcoatRoughness: 0.06 };
  const m = {
    body: applyLivery(low ? std({ color: t.color }) : new THREE.MeshPhysicalMaterial({ color: t.color, ...paint }), teamIdx),
    accent: std({ color: t.accent, metalness: 0.1, roughness: 0.38 }),
    detail: applyDetail(std({ color: 0xffffff, vertexColors: true, metalness: 0.3, roughness: 0.42 }), teamIdx),     // carbon / metal / black parts, colours baked into the vertices
    helmet: std({ color: 0xffffff, vertexColors: true, metalness: 0.1, roughness: 0.22 }),
    tyre: std({ color: 0xffffff, vertexColors: true, metalness: 0.0, roughness: 0.9 }),
    light: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
  };
  matCache.set(key, m); return m;
}
const helmetCache = new Map();
function helmetGeo(teamIdx, D) {
  const key = teamIdx + ':' + D;
  if (!helmetCache.has(key)) {
    const P = partsFor(D), t = TEAMS[teamIdx % TEAMS.length];
    helmetCache.set(key, merge([tint(clean(P.helmetShell.clone()), t.accent), tint(clean(P.visor.clone()), COL.visor)]));
  }
  return helmetCache.get(key);
}
// number plates on the nose and both sides of the airbox (canvas texture per team + race number, cached)
const numTex = new Map();
function numberTexture(num, teamIdx) {
  const key = num + ':' + teamIdx;
  if (numTex.has(key)) return numTex.get(key);
  const t = TEAMS[teamIdx % TEAMS.length], c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  // race number on a chalk plate (the identity's plate), team colour keyline; numerals in the UI face
  g.fillStyle = '#f2efe6'; g.beginPath(); g.roundRect ? g.roundRect(8, 8, 112, 112, 14) : g.rect(8, 8, 112, 112); g.fill();
  g.lineWidth = 7; g.strokeStyle = '#' + t.color.toString(16).padStart(6, '0'); g.stroke();
  g.fillStyle = '#141518'; g.font = '700 84px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(num), 64, 70, 100);
  const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 4;
  numTex.set(key, tx); return tx;
}
function decalMesh(num, teamIdx) {
  const mk = (w, x, y, z, rx, ry) => { const g = new THREE.PlaneGeometry(w, w); g.rotateX(rx); g.rotateY(ry); g.translate(x, y, z); return g; };
  const geoms = [mk(0.15, 0, topAt(MONO, 1.62) + 0.006, 1.62, -Math.PI / 2 + 0.06, 0), mk(0.19, 0.153, 0.775, -0.42, 0, Math.PI / 2), mk(0.19, -0.153, 0.775, -0.42, 0, -Math.PI / 2)];
  for (const g of geoms) { g.deleteAttribute('normal'); }
  const geo = geoms.length ? (() => { const out = new THREE.BufferGeometry(); const pos = [], uv = [], idx = []; let o = 0; for (const g of geoms) { pos.push(...g.attributes.position.array); uv.push(...g.attributes.uv.array); for (const i of g.index.array) idx.push(i + o); o += g.attributes.position.count; } out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); out.setIndex(idx); return out; })() : null;
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: numberTexture(num, teamIdx), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  return m;
}

// ------------------------------------------------------------------ baked LODs (vertex colours, always the cheap detail-0 geometry)
const lodGeoCache = new Map();
function lodGeometry(teamIdx) {
  if (lodGeoCache.has(teamIdx)) return lodGeoCache.get(teamIdx);
  const P = partsFor(0), t = TEAMS[teamIdx % TEAMS.length];
  const body = merge([...P.body.map((g) => bakeLivery(clean(g.clone()), teamIdx)), ...P.accent.map((g) => tint(clean(g.clone()), t.accent))]);
  const out = bakeMarkers(merge([body, P.detail, P.fwL, P.fwR, P.fwNose, P.rwFixed, tint(clean(P.rwFlap.clone().translate(0, 1.0, -2.4)), COL.carbon), helmetGeo(teamIdx, 0)]), teamIdx);
  lodGeoCache.set(teamIdx, out); return out;
}
const wheelLod = new Map();
function wheelLodGeo(rear, side, compound) {
  const key = `${rear ? 'r' : 'f'}${side}${compound}`;
  if (!wheelLod.has(key)) {
    const G = wheelGeos(rear, side, 0), flip = (g) => (side < 0 ? g.clone().rotateY(Math.PI) : g);
    wheelLod.set(key, merge([flip(G.spin), tint(clean(flip(G.ring)), new THREE.Color(COMPOUNDS[compound].color))]));
  }
  return wheelLod.get(key);
}

export class CarVisual {
  constructor(teamIdx, quality, opts = {}) {
    this.teamIdx = teamIdx; this.quality = quality; this.D = DETAIL[quality] ?? 1;
    this.number = opts.number ?? 0;
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.body = new THREE.Group(); this.body.rotation.order = 'XYZ';    // pitch / roll visuals
    this.root.add(this.body);
    this.lodLevel = -1;
    this.compound = null;
    this.ghost = !!opts.ghost;
    this.l0 = null; this.wheels = []; this.helmetMesh = { visible: true };
    this.build();
    this.setLod(opts.lod ?? 0);
  }

  mat(m) { return this.ghostMat || m; }

  build() {
    this.ghostMat = this.ghost ? new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.35, depthWrite: false }) : null;
    const ghostMat = this.ghostMat;
    // ---------------- LOD1: baked body + 4 wheels
    const l1 = new THREE.Group(); this.l1 = l1; this.root.add(l1);
    const vm = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.l1Body = new THREE.Mesh(lodGeometry(this.teamIdx), ghostMat || vm); l1.add(this.l1Body);
    this.l1Wheels = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(wheelLodGeo(i >= 2, Math.sign(WY[i]), 'medium'), ghostMat || vm); m.rotation.order = 'YXZ'; m.position.set(WY[i], CAR.Rw[i], WX[i]); l1.add(m); this.l1Wheels.push(m);
    }
    // ---------------- LOD2: one static mesh
    const l2 = new THREE.Group(); this.l2 = l2; this.root.add(l2);
    const g2 = merge([lodGeometry(this.teamIdx), ...[0, 1, 2, 3].map((i) => wheelLodGeo(i >= 2, Math.sign(WY[i]), 'medium').clone().translate(WY[i], CAR.Rw[i], WX[i]))]);
    l2.add(new THREE.Mesh(g2, ghostMat || vm)); this.ownGeo = g2; this.ownMat = vm;
    this.fwLost = [false, false]; this.rwLost = false;
    // camera anchors (driver eyes, T-cam above the airbox, nose cam)
    const mkA = (x, y, z) => { const a = new THREE.Object3D(); a.position.set(x, y, z); this.body.add(a); return a; };
    this.anchors = { cockpit: mkA(0, 0.8, 0.1), tcam: mkA(0, 1.18, -0.75), nose: mkA(0, 0.36, 1.95) };
  }

  /** the detailed car; built the first time something needs it (most cars on the grid are far away and never do) */
  buildL0() {
    if (this.l0) return;
    const D = this.D, P = partsFor(D), M = teamMaterials(this.teamIdx, this.quality), ghostMat = this.ghostMat, mat = (m) => ghostMat || m;
    const l0 = new THREE.Group(); this.l0 = l0; this.body.add(l0);
    const mesh = (g, m, shadow = true) => { const o = new THREE.Mesh(g, mat(m)); o.castShadow = shadow && !this.ghost; return o; };
    const bodyG = merge(P.body), accG = merge(P.accent);
    l0.add(mesh(bodyG, M.body), mesh(accG, M.accent, false), mesh(P.detail, M.detail, D >= 2), mesh(P.suspension, M.detail, false));
    // rain / brake light: its own material so it can glow (HDR, picked up by the bloom) with this car's brake pedal
    this.lightMat = M.light.clone();
    if (!this.ghost) l0.add(mesh(P.lights, this.lightMat, false));
    this.rwFixedMesh = mesh(P.rwFixed, M.detail, D >= 1); l0.add(this.rwFixedMesh);
    this.fwL = mesh(P.fwL, M.detail, D >= 1); this.fwR = mesh(P.fwR, M.detail, D >= 1); l0.add(this.fwL, this.fwR, mesh(P.fwNose, M.detail, false));
    this.rwFlap = new THREE.Group(); this.rwFlap.position.set(0, 1.0, -2.4); this.rwFlap.add(mesh(P.rwFlap, M.detail)); if (P.rwFlap2) this.rwFlap.add(mesh(P.rwFlap2, M.detail, false)); l0.add(this.rwFlap);
    this.helmetMesh = mesh(helmetGeo(this.teamIdx, D), M.helmet, false); l0.add(this.helmetMesh);
    if (this.number && !this.ghost && D >= 1 && typeof document !== 'undefined') { this.decal = decalMesh(this.number, this.teamIdx); l0.add(this.decal); }
    // wheels: pivot (steering) -> spin (rolling) -> flip (mirrors right-hand wheels) ; non-rolling parts (upright, brake duct, calipers) hang on the pivot
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const rear = i >= 2, R = CAR.Rw[i], side = Math.sign(WY[i]), G = wheelGeos(rear, side, D);
      const pivot = new THREE.Group(), spin = new THREE.Group(), flip = new THREE.Group();
      if (side < 0) flip.rotation.y = Math.PI;
      const tire = mesh(G.spin, M.tyre);
      const discMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.07, 0.07, 0.075) });
      const disc = new THREE.Mesh(G.disc, ghostMat || discMat);
      const ring = new THREE.Mesh(G.ring, ghostMat || new THREE.MeshBasicMaterial({ color: 0xffd23b, side: THREE.DoubleSide }));
      flip.add(tire, disc, ring); spin.add(flip); pivot.add(spin);
      pivot.add(mesh(G.stat, M.detail, false));
      pivot.position.set(WY[i], R, WX[i]);
      this.body.add(pivot);
      this.wheels.push({ pivot, spin, ring, discMat, disc, R, ringMat: ring.material, tire });
    }
    this.compound = null;
  }

  /** free what this car owns (its merged far-LOD mesh, decal and per-wheel materials); shared part geometry stays cached */
  dispose() {
    if (this.ownGeo) this.ownGeo.dispose();
    if (this.ownMat) this.ownMat.dispose();
    if (this.ghostMat) this.ghostMat.dispose();
    if (this.decal) { this.decal.geometry.dispose(); this.decal.material.dispose(); }
    for (const w of this.wheels) { w.discMat.dispose(); w.ringMat.dispose(); }
  }

  setLod(l) {
    if (l === this.lodLevel) return;
    this.lodLevel = l;
    if (l === 0) this.buildL0();
    if (this.l0) this.l0.visible = l === 0;
    for (const w of this.wheels) w.pivot.visible = l === 0;
    this.l1.visible = l === 1; this.l2.visible = l === 2;
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
        // brake disc glow: cold iron grey -> dull red -> orange -> yellow-white (HDR, so the hot disc survives tone mapping)
        const T = car.brakes.temp[i];
        const g = Math.max(0, Math.min(1, (T - 300) / 750));
        if (g < 0.5) { const k = g * 2; w.discMat.color.setRGB(0.07 + k * 1.1, 0.07 + k * 0.1, 0.075 - k * 0.04); }
        else { const k = (g - 0.5) * 2; w.discMat.color.setRGB(1.17 + k * 1.4, 0.17 + k * 1.05, 0.035 + k * 0.3); }
      }
      if (this.lightMat) this.lightMat.color.setScalar(0.9 + 6.0 * Math.min(1, car.brakes.pedal) + (car.speed < 1.5 ? 0.6 : 0));
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

export { partsFor as buildShared };
