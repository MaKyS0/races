// Decor: start gantry + lights, grid boxes, chequered line, pit garages, grandstands, trees/buildings (instanced, bucketed per
// stretch of track so they can be culled), braking boards and advertising hoardings.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, wrapPi } from '../core/math.js';
import { crowdTexture, windowTexture, numberBoardTexture, logoTexture } from './Textures.js';
import { TEAMS } from '../race/Roster.js';

const P = { x: 0, y: 0, z: 0, psi: 0 };
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export class Decor {
  constructor(track, quality, mats) {
    this.track = track; this.q = quality; this.mats = mats;
    this.group = new THREE.Group();
    this.buckets = [];           // {group, cx, cz, kind}
    this.rnd = makeRng(hash(track.id));
    this.lights = [];
    this.build();
  }

  build() {
    this.buildStartLine();
    this.buildGantry();
    this.buildGrid();
    this.buildPit();
    this.buildBoards();
    this.buildHoardings();
    this.buildStands();
    if (this.track.def.theme && this.track.def.theme.city) this.buildBuildings(); else this.buildTrees();
  }

  place(s, n) { return this.track.pointAt(s, n, P); }

  // ---------------------------------------------------------------- start / finish + grid
  buildStartLine() {
    const t = this.track, w = Math.min(t.wl[0], t.wr[0]) * 2;
    const c = document.createElement('canvas'); c.width = 128; c.height = 32; const g = c.getContext('2d');
    for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) { g.fillStyle = (x + y) % 2 ? '#101010' : '#f2f2f2'; g.fillRect(x * 8, y * 16, 8, 16); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter;
    const geo = new THREE.PlaneGeometry(w, 1.6); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.place(0, 0);
    m.position.set(P.x, P.y + 0.025, P.z); m.rotation.y = P.psi; m.renderOrder = 3;
    this.group.add(m);
  }
  buildGrid() {
    const t = this.track;
    const geo = [];
    for (let k = 0; k < 20; k++) {
      const slot = t.gridSlot(k);
      this.place(slot.s, slot.n);
      const g = new THREE.PlaneGeometry(0.18, 4.2); g.rotateX(-Math.PI / 2);
      const g2 = new THREE.PlaneGeometry(1.6, 0.18); g2.rotateX(-Math.PI / 2); g2.translate(0, 0, 2.0);
      const m = new THREE.Matrix4().makeRotationY(P.psi); m.setPosition(P.x, P.y + 0.03, P.z);
      const a = g.clone().translate(0.9, 0, 0).applyMatrix4(m), b = g.clone().translate(-0.9, 0, 0).applyMatrix4(m), c = g2.clone().applyMatrix4(m);
      geo.push(a, b, c);
    }
    const merged = mergeGeometries(geo.map((x) => { const r = x.index ? x.toNonIndexed() : x; return r; }));
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color: 0xf0f0f0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    mesh.renderOrder = 3; this.group.add(mesh);
  }
  buildGantry() {
    const t = this.track;
    this.place(0.5, 0);
    const half = Math.max(t.wl[0], t.wr[0]) + 3.2;
    const g = new THREE.Group();
    const steel = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.2, 1.1, 1.3), steel); beam.position.set(0, 7.0, 0); g.add(beam);
    for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, 7.4, 1.0), steel); p.position.set(sx * half, 3.7, 0); g.add(p); }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(half * 1.3, 1.3), new THREE.MeshBasicMaterial({ map: logoTexture('APEX  GRAND  PRIX', '#fff', '#b3121c') }));
    sign.position.set(0, 7.0, 0.66); g.add(sign);
    const sign2 = sign.clone(); sign2.position.z = -0.66; sign2.rotation.y = Math.PI; g.add(sign2);
    // start lights: 5 columns x 2 lamps on the approach side of the beam
    const off = new THREE.MeshBasicMaterial({ color: 0x330505 }), on = new THREE.MeshBasicMaterial({ color: 0xff1a12 });
    this.lampOff = off; this.lampOn = on;
    const lampGeo = new THREE.SphereGeometry(0.28, 10, 8);
    this.lamps = [];
    const housing = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.5, 0.4), new THREE.MeshLambertMaterial({ color: 0x0b0b0d })); housing.position.set(0, 5.9, -0.9); g.add(housing);
    for (let i = 0; i < 5; i++) {
      for (const dy of [0.35, -0.3]) {
        const m = new THREE.Mesh(lampGeo, off); m.position.set(-2.2 + i * 1.1, 5.9 + dy, -1.15); g.add(m);
        (this.lamps[i] = this.lamps[i] || []).push(m);
      }
    }
    g.position.set(P.x, P.y, P.z); g.rotation.y = P.psi;
    this.group.add(g);
  }
  /** number of red lights lit (0-5) */
  setLights(n) {
    for (let i = 0; i < 5; i++) for (const m of this.lamps[i]) m.material = i < n ? this.lampOn : this.lampOff;
  }

  // ---------------------------------------------------------------- pit buildings
  buildPit() {
    const t = this.track;
    const L = t.length, span = t.pitLength;
    const side = t.pitSide;
    const buildStart = (t.pitInS + 110) % L, buildLen = span - 220;
    if (buildLen < 50) return;
    const seg = 40, count = Math.floor(buildLen / seg);
    const win = windowTexture(); win.repeat.set(2, 1);
    const wallMat = new THREE.MeshLambertMaterial({ map: win, color: 0xd9d4ca });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x55585e });
    const boxes = [], roofs = [];
    const doorGeo = new THREE.BoxGeometry(0.2, 3.2, 8);
    const doors = new THREE.InstancedMesh(doorGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), t.pitBoxes.length);
    for (let k = 0; k < count; k++) {
      const s = (buildStart + k * seg + seg / 2) % L;
      const i = Math.round(s / t.ds) % t.N;
      const n = side * (t.pitOuter[i] + 8);
      this.place(s, n);
      const m = new THREE.Mesh(new THREE.BoxGeometry(14, 7.5, seg - 0.2), wallMat); m.position.set(P.x, P.y + 3.7, P.z); m.rotation.y = P.psi;
      this.group.add(m);
      const r = new THREE.Mesh(new THREE.BoxGeometry(15, 0.4, seg - 0.2), roofMat); r.position.set(P.x, P.y + 7.7, P.z); r.rotation.y = P.psi; this.group.add(r);
    }
    // garage doors in team colours at each pit box
    const dummy = new THREE.Object3D();
    t.pitBoxes.forEach((b, k) => {
      const i = Math.round(b.s / t.ds) % t.N;
      const n = side * (t.pitOuter[i] + 1.2);
      this.place(b.s, n);
      dummy.position.set(P.x, P.y + 1.7, P.z); dummy.rotation.set(0, P.psi, 0); dummy.updateMatrix();
      doors.setMatrixAt(k, dummy.matrix);
      doors.setColorAt(k, new THREE.Color(TEAMS[(k >> 1) % TEAMS.length].color));
    });
    doors.instanceMatrix.needsUpdate = true; if (doors.instanceColor) doors.instanceColor.needsUpdate = true;
    this.group.add(doors);
  }

  // ---------------------------------------------------------------- braking boards, DRS boards
  buildBoards() {
    const t = this.track;
    const plane = new THREE.PlaneGeometry(1.6, 1.6);
    const mk = (txt, n) => new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ map: numberBoardTexture(txt), side: THREE.DoubleSide }), n);
    const list = t.cornerList.filter((c) => c.minR < 230 && c.s1 - c.s0 > 20);
    const meshes = { 150: mk('150', list.length), 100: mk('100', list.length), 50: mk('50', list.length) };
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x444444 }), list.length * 3);
    const d = new THREE.Object3D(); let pi = 0;
    list.forEach((c, k) => {
      const left = c.dir < 0;       // boards on the outside of the corner... right turn -> left side
      for (const dist of [150, 100, 50]) {
        const s = (c.s0 - dist + t.length) % t.length;
        const i = Math.round(s / t.ds) % t.N;
        const nWall = left ? t.wallL[i] : -t.wallR[i];
        const n = nWall - Math.sign(nWall) * 1.6;
        this.place(s, n);
        d.position.set(P.x, P.y + 2.2, P.z); d.rotation.set(0, P.psi + Math.PI, 0); d.updateMatrix();
        meshes[dist].setMatrixAt(k, d.matrix);
        d.position.y = P.y + 1.0; d.updateMatrix(); poles.setMatrixAt(pi++, d.matrix);
      }
    });
    for (const m of Object.values(meshes)) { m.instanceMatrix.needsUpdate = true; this.group.add(m); }
    poles.count = pi; poles.instanceMatrix.needsUpdate = true; this.group.add(poles);
    // DRS zone boards (green)
    t.drsZones.forEach((z) => {
      const i = Math.round(z.start / t.ds) % t.N;
      this.place(z.start, -t.wallR[i] + 1.5);
      const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: logoTexture('DRS', '#fff', '#0a7d3a'), side: THREE.DoubleSide }));
      m.scale.set(1.8, 0.8, 1); m.position.set(P.x, P.y + 2.2, P.z); m.rotation.y = P.psi + Math.PI; this.group.add(m);
    });
  }

  buildHoardings() {
    const t = this.track; const N = t.N;
    const texA = logoTexture('APEX GP', '#fff', '#c4161c'), texB = logoTexture('VELOCITY', '#111', '#ffd23b'), texC = logoTexture('TURBO·X', '#fff', '#1b4fd8');
    const geo = new THREE.PlaneGeometry(8, 1.2);
    const per = [[], [], []];
    for (let s = 120; s < t.length; s += 64) {
      const i = Math.round(s / t.ds) % N;
      // only along straight-ish parts
      if (Math.abs(t.k[i]) > 1 / 700) continue;
      for (const sg of [1, -1]) {
        const wn = sg > 0 ? t.wallL[i] : t.wallR[i];
        if ((sg > 0 ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0) continue;
        const n = sg * (wn - 0.25);
        this.place(s, n);
        per[Math.floor(this.rnd() * 3)].push([P.x, P.y + 0.75, P.z, P.psi + (sg > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.PI / 2 * 0, sg]);
      }
    }
    const d = new THREE.Object3D();
    [texA, texB, texC].forEach((tx, k) => {
      if (!per[k].length) return;
      const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: tx, side: THREE.DoubleSide }), per[k].length);
      per[k].forEach((p, j) => { d.position.set(p[0], p[1], p[2]); d.rotation.set(0, p[3], 0); d.updateMatrix(); im.setMatrixAt(j, d.matrix); });
      im.instanceMatrix.needsUpdate = true;
      this.addBucket(im, per[k][0][0], per[k][0][2], 'hoarding', 1e9);
    });
  }

  addBucket(obj, cx, cz, kind, dist) { this.group.add(obj); this.buckets.push({ obj, cx, cz, kind, dist }); }

  // ---------------------------------------------------------------- grandstands
  buildStands() {
    const t = this.track, N = t.N;
    const crowd = crowdTexture(); crowd.repeat.set(1, 1);
    const mat = new THREE.MeshLambertMaterial({ map: crowd });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x6b6f78 });
    const spots = [];
    const addRange = (s0, s1, side) => { for (let s = s0; s < s1; s += 34) spots.push([(s + t.length) % t.length, side]); };
    // main straight, opposite the pits and behind the garages
    addRange(-380, 320, -t.pitSide);
    // outside of the tightest corners
    const corners = t.cornerList.slice().sort((a, b) => a.minR - b.minR).slice(0, 4);
    for (const c of corners) addRange(c.apex - 80, c.apex + 80, c.dir > 0 ? -1 : 1);
    const geo = new THREE.BoxGeometry(10, 8, 30);
    const roofGeo = new THREE.BoxGeometry(11, 0.4, 31);
    const buckets = new Map();
    for (const [s, side] of spots) {
      const i = Math.round(s / t.ds) % N;
      const wn = side > 0 ? t.wallL[i] : t.wallR[i];
      if (side === t.pitSide && t.pitOuter[i] > 0) continue;
      const key = Math.floor(s / 600);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push([s, side, wn]);
    }
    const d = new THREE.Object3D();
    for (const arr of buckets.values()) {
      const stands = new THREE.InstancedMesh(geo, mat, arr.length), roofs = new THREE.InstancedMesh(roofGeo, roofMat, arr.length);
      arr.forEach(([s, side, wn], j) => {
        const nn = side * (wn + 9 + this.rnd() * 3);
        this.place(s, nn);
        d.position.set(P.x, P.y + 4.4, P.z); d.rotation.set(0, P.psi, 0); d.scale.set(1, 1, 1); d.updateMatrix(); stands.setMatrixAt(j, d.matrix);
        d.position.y = P.y + 9.2; d.updateMatrix(); roofs.setMatrixAt(j, d.matrix);
      });
      stands.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
      const g = new THREE.Group(); g.add(stands, roofs);
      this.place(arr[0][0], 0);
      this.addBucket(g, P.x, P.z, 'stand', 1100);
    }
  }

  // ---------------------------------------------------------------- trees (forest/desert scrub) and city blocks
  buildTrees() {
    const t = this.track, N = t.N, th = t.def.theme || {};
    const density = th.forest ? 1.0 : th.desert ? 0.12 : 0.45;
    const leaf = new THREE.ConeGeometry(2.6, 9, 7); leaf.translate(0, 7.5, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 5); trunk.translate(0, 1.6, 0);
    const tint = (g, c) => { const n = g.attributes.position.count, col = new THREE.Color(c), a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
    const treeGeo = mergeGeometries([tint(leaf.toNonIndexed(), th.desert ? 0x8a8f4a : 0x1f5a2a), tint(trunk.toNonIndexed(), 0x4a3524)]);
    if (th.desert) treeGeo.scale(0.5, 0.35, 0.5);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const spacing = 30 / density;
    const buckets = new Map();
    for (let s = 0; s < t.length; s += spacing) {
      const i = Math.round(s / t.ds) % N;
      const key = Math.floor(s / 500);
      for (const sg of [1, -1]) {
        if (this.rnd() < 0.15) continue;
        const wn = sg > 0 ? t.wallL[i] : t.wallR[i];
        if ((sg > 0 ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0) continue;
        const nn = sg * (wn + 14 + this.rnd() * 70);
        this.place(s + (this.rnd() - 0.5) * 20, nn);
        // keep clear of other parts of the circuit
        const loc = { i: 0 };
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push([P.x, P.y - 1.4 - 0.02 * Math.abs(nn - sg * wn) * 0, P.z, 0.7 + this.rnd() * 0.9]);
      }
    }
    const d = new THREE.Object3D();
    for (const arr of buckets.values()) {
      const im = new THREE.InstancedMesh(treeGeo, mat, arr.length);
      arr.forEach((p, j) => { d.position.set(p[0], p[1], p[2]); d.scale.set(p[3], p[3] * (0.9 + this.rnd() * 0.5), p[3]); d.rotation.y = this.rnd() * 6; d.updateMatrix(); im.setMatrixAt(j, d.matrix); });
      im.instanceMatrix.needsUpdate = true;
      this.addBucket(im, arr[0][0], arr[0][2], 'tree', 900);
    }
  }
  buildBuildings() {
    const t = this.track, N = t.N;
    const win = windowTexture(); win.repeat.set(2, 3);
    const mat = new THREE.MeshLambertMaterial({ map: win });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const buckets = new Map();
    for (let s = 0; s < t.length; s += 26) {
      const i = Math.round(s / t.ds) % N;
      const key = Math.floor(s / 400);
      for (const sg of [1, -1]) {
        if ((sg > 0 ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0) continue;
        const wn = sg > 0 ? t.wallL[i] : t.wallR[i];
        const h = 14 + this.rnd() * 36, w = 14 + this.rnd() * 12, dpt = 16 + this.rnd() * 14;
        const nn = sg * (wn + 3 + dpt / 2 + this.rnd() * 3);
        this.place(s, nn);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push([P.x, P.y + h / 2 - 3, P.z, P.psi, w, h, dpt]);
      }
    }
    const d = new THREE.Object3D();
    for (const arr of buckets.values()) {
      const im = new THREE.InstancedMesh(geo, mat, arr.length);
      arr.forEach((p, j) => { d.position.set(p[0], p[1], p[2]); d.rotation.set(0, p[3], 0); d.scale.set(p[4], p[5], p[6]); d.updateMatrix(); im.setMatrixAt(j, d.matrix); });
      im.instanceMatrix.needsUpdate = true;
      this.addBucket(im, arr[0][0], arr[0][2], 'building', 800);
    }
  }

  /** cull per bucket by distance and density settings */
  update(camX, camZ, q) {
    for (const b of this.buckets) {
      const d = Math.hypot(camX - b.cx, camZ - b.cz);
      let lim = b.dist * (b.kind === 'tree' ? q.trees : b.kind === 'stand' ? q.stands : q.decor + 0.2);
      if (b.kind === 'hoarding') lim = q.drawDistance;
      b.obj.visible = d < lim + 300;
    }
  }
}
