// Decor: start gantry + lights, grid boxes with painted slot numbers, chequered line, pit building with team garages and
// pit-box markings, grandstands, trees/buildings (instanced, bucketed per stretch of track so they can be culled),
// braking boards and sponsor hoardings. Everything is procedural; repeated things are instanced or merged.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/math.js';
import { crowdTexture, windowTexture, numberBoardTexture, logoTexture, sponsorTexture, gridNumberAtlas, sparkTexture, SPONSORS, INK } from './Textures.js';
import { TEAMS } from '../race/Roster.js';

const P = { x: 0, y: 0, z: 0, psi: 0 };
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const tintGeo = (g, c) => { g = g.index ? g.toNonIndexed() : g; const n = g.attributes.position.count, col = new THREE.Color(c), a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); if (g.attributes.uv) g.deleteAttribute('uv'); return g; };
const box = (w, h, d, x, y, z, c) => tintGeo(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
/** low-poly crown with radial normals: reads as a soft rounded canopy instead of a faceted crystal */
const crownGeo = (r, x, y, z, sx = 1, sy = 1, sz = 1) => { const g = new THREE.IcosahedronGeometry(r, 0); g.scale(sx, sy, sz); const p = g.attributes.position, n = g.attributes.normal; for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3(p.getX(i) / sx, p.getY(i) / sy, p.getZ(i) / sz).normalize(); n.setXYZ(i, v.x, v.y, v.z); } return g.translate(x, y, z); };

export class Decor {
  constructor(track, quality, mats) {
    this.track = track; this.q = quality; this.mats = mats;
    this.group = new THREE.Group();
    this.buckets = [];           // {obj, cx, cz, kind, dist}
    this.rnd = makeRng(hash(track.id));
    this.lights = [];
    this.vcMat = new THREE.MeshLambertMaterial({ vertexColors: true });
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
    for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) { g.fillStyle = (x + y) % 2 ? '#141518' : '#f2efe6'; g.fillRect(x * 8, y * 16, 8, 16); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.anisotropy = 4;
    const geo = new THREE.PlaneGeometry(w, 1.6); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.place(0, 0);
    m.position.set(P.x, P.y + 0.025, P.z); m.rotation.y = P.psi; m.renderOrder = 3; m.receiveShadow = true;
    this.group.add(m);
  }
  buildGrid() {
    const t = this.track;
    const lines = [], nums = [];
    const S = 1.3;   // painted slot number size (m)
    for (let k = 0; k < 20; k++) {
      const slot = t.gridSlot(k);
      this.place(slot.s, slot.n);
      const m = new THREE.Matrix4().makeRotationY(P.psi); m.setPosition(P.x, P.y + 0.03, P.z);
      const side = new THREE.PlaneGeometry(0.16, 2.2).rotateX(-Math.PI / 2);
      const front = new THREE.PlaneGeometry(1.9, 0.2).rotateX(-Math.PI / 2).translate(0, 0, 2.1);
      lines.push(side.clone().translate(0.95, 0, 1.0).applyMatrix4(m), side.clone().translate(-0.95, 0, 1.0).applyMatrix4(m), front.applyMatrix4(m));
      // slot number ahead of the box line, readable from the car behind
      const q = new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2).rotateY(Math.PI).translate(0, 0.002, 3.05);
      const uv = q.attributes.uv, u0 = (k % 5) / 5, v0 = 1 - (Math.floor(k / 5) + 1) / 4;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) / 5, v0 + uv.getY(i) / 4);
      nums.push(q.applyMatrix4(m));
    }
    const mat = new THREE.MeshLambertMaterial({ color: 0xf2efe6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = new THREE.Mesh(mergeGeometries(lines.map((x) => (x.index ? x.toNonIndexed() : x))), mat);
    mesh.renderOrder = 3; mesh.receiveShadow = true; this.group.add(mesh);
    const nm = new THREE.Mesh(mergeGeometries(nums.map((x) => (x.index ? x.toNonIndexed() : x))), new THREE.MeshLambertMaterial({ map: gridNumberAtlas(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    nm.renderOrder = 3; this.group.add(nm);
  }
  buildGantry() {
    const t = this.track;
    this.place(0.5, 0);
    const half = Math.max(t.wl[0], t.wr[0]) + 3.2;
    const g = new THREE.Group();
    // steel structure (one merged, vertex-coloured mesh): two lattice-look legs, a deep beam, the light housing
    const steel = 0x3a3e45, dark = 0x17181b, edge = 0x9aa3ad;
    const parts = [];
    for (const sx of [-1, 1]) {
      parts.push(box(0.35, 7.6, 0.35, sx * half - 0.35, 3.8, -0.35, steel), box(0.35, 7.6, 0.35, sx * half + 0.35, 3.8, -0.35, steel), box(0.35, 7.6, 0.35, sx * half - 0.35, 3.8, 0.35, steel), box(0.35, 7.6, 0.35, sx * half + 0.35, 3.8, 0.35, steel));
      for (let y = 1; y < 7.5; y += 1.25) parts.push(box(1.05, 0.12, 1.05, sx * half, y, 0, steel));
      parts.push(box(1.6, 0.3, 1.6, sx * half, 0.15, 0, 0x55595f));
    }
    parts.push(box(half * 2 + 1.4, 1.5, 1.2, 0, 7.25, 0, dark), box(half * 2 + 1.4, 0.08, 1.24, 0, 8.0, 0, edge), box(half * 2 + 1.4, 0.08, 1.24, 0, 6.5, 0, edge));
    parts.push(box(6.4, 1.9, 0.5, 0, 5.75, -0.85, dark), box(6.6, 0.12, 0.6, 0, 6.72, -0.85, edge));
    for (let i = 0; i < 5; i++) parts.push(box(0.95, 1.65, 0.12, -2.4 + i * 1.2, 5.75, -1.13, 0x0c0c0e));   // five light pods
    const gm = new THREE.Mesh(mergeGeometries(parts), this.vcMat); gm.castShadow = true; g.add(gm);
    // identity banner both sides of the beam
    const banner = logoTexture('Apex GP', INK.board, INK.chalk, 'apex');
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(half * 1.5, 16), 1.3), new THREE.MeshLambertMaterial({ map: banner }));
    sign.position.set(0, 7.25, 0.61); g.add(sign);
    const sign2 = sign.clone(); sign2.position.z = -0.61; sign2.rotation.y = Math.PI; g.add(sign2);
    // start lights: 5 pods x 2 lamps on the approach side; lit lamps are HDR red so they stay red-hot after tone mapping
    const off = new THREE.MeshBasicMaterial({ color: 0x2a0705 }), on = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.0, 0.28, 0.18) });
    this.lampOff = off; this.lampOn = on;
    const lampGeo = new THREE.CircleGeometry(0.3, 14); lampGeo.rotateY(Math.PI);
    this.lamps = [];
    const glowPos = [];
    for (let i = 0; i < 5; i++) {
      for (const dy of [0.42, -0.36]) {
        const m = new THREE.Mesh(lampGeo, off); m.position.set(-2.4 + i * 1.2, 5.75 + dy, -1.2); g.add(m);
        (this.lamps[i] = this.lamps[i] || []).push(m);
        glowPos.push(-2.4 + i * 1.2, 5.75 + dy, -1.3);
      }
    }
    // additive glow halos (one Points draw call; colour = black when off)
    if (this.q.particles >= 0.5) {
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3)); pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(glowPos.length), 3));
      this.glow = new THREE.Points(pg, new THREE.PointsMaterial({ map: sparkTexture(), size: 2.6, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      this.glow.renderOrder = 6; g.add(this.glow);
    }
    g.position.set(P.x, P.y, P.z); g.rotation.y = P.psi;
    this.group.add(g);
    this.litN = -1;
  }
  /** number of red lights lit (0-5) */
  setLights(n) {
    if (n === this.litN) return; this.litN = n;
    for (let i = 0; i < 5; i++) for (const m of this.lamps[i]) m.material = i < n ? this.lampOn : this.lampOff;
    if (this.glow) { const c = this.glow.geometry.attributes.color; for (let i = 0; i < 10; i++) { const v = (i >> 1) < n ? 1 : 0; c.setXYZ(i, v, v * 0.12, v * 0.06); } c.needsUpdate = true; }
  }

  // ---------------------------------------------------------------- pit building, garages, pit boxes
  buildPit() {
    const t = this.track;
    const L = t.length, span = t.pitLength;
    const side = t.pitSide;
    const buildStart = (t.pitInS + 110) % L, buildLen = span - 220;
    if (buildLen < 50) return;
    const seg = 20, count = Math.floor(buildLen / seg);
    const win = windowTexture(2); win.repeat.set(seg / 10, 0.4);
    const glass = [], frame = [];
    for (let k = 0; k < count; k++) {
      const s = (buildStart + k * seg + seg / 2) % L;
      const i = Math.round(s / t.ds) % t.N;
      const n = side * (t.pitOuter[i] + 9);
      this.place(s, n);
      const m = new THREE.Matrix4().makeRotationY(P.psi + (side > 0 ? 0 : Math.PI)); m.setPosition(P.x, P.y, P.z);
      // upper floor (glazed hospitality band) on a darker garage level; roof overhang towards the pit lane
      glass.push(new THREE.BoxGeometry(14, 4.2, seg - 0.1).translate(0.4, 6.0, 0).applyMatrix4(m));
      frame.push(box(15, 3.9, seg - 0.1, 0, 1.95, 0, 0x8f949a).applyMatrix4(m), box(17.5, 0.45, seg - 0.05, -1.4, 8.35, 0, 0xe4e2dc).applyMatrix4(m), box(17.6, 0.25, seg - 0.05, -1.4, 4.05, 0, 0x2b2e33).applyMatrix4(m));
    }
    const gm = new THREE.Mesh(mergeGeometries(glass.map((x) => x.toNonIndexed())), new THREE.MeshLambertMaterial({ map: win, color: 0xe6e8ea }));
    const fm = new THREE.Mesh(mergeGeometries(frame), this.vcMat);
    gm.castShadow = fm.castShadow = this.q.shadows > 1;
    this.group.add(gm, fm);
    // garage doors in team colours at each pit box, plus the painted box on the lane (one instanced mesh each)
    const dummy = new THREE.Object3D();
    const doors = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 3.0, 7.2), new THREE.MeshLambertMaterial({ color: 0xffffff }), t.pitBoxes.length);
    const boxGeo = new THREE.PlaneGeometry(4.2, 7.0); boxGeo.rotateX(-Math.PI / 2);
    const pads = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), t.pitBoxes.length);
    t.pitBoxes.forEach((b, k) => {
      const i = Math.round(b.s / t.ds) % t.N;
      const col = new THREE.Color(TEAMS[(k >> 1) % TEAMS.length].color);
      this.place(b.s, side * (t.pitOuter[i] + 1.4));
      dummy.position.set(P.x, P.y + 1.5, P.z); dummy.rotation.set(0, P.psi, 0); dummy.updateMatrix();
      doors.setMatrixAt(k, dummy.matrix); doors.setColorAt(k, col.clone().multiplyScalar(0.8));
      this.place(b.s, side * (t.pitOuter[i] - 2.4));
      dummy.position.set(P.x, P.y + 0.02, P.z); dummy.updateMatrix(); pads.setMatrixAt(k, dummy.matrix); pads.setColorAt(k, col);
    });
    for (const im of [doors, pads]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
    pads.renderOrder = 2;
    this.group.add(doors, pads);
  }

  // ---------------------------------------------------------------- braking boards, DRS boards
  buildBoards() {
    const t = this.track;
    const plane = new THREE.PlaneGeometry(1.6, 1.6);
    const mk = (txt, n) => new THREE.InstancedMesh(plane, new THREE.MeshLambertMaterial({ map: numberBoardTexture(txt), side: THREE.DoubleSide }), n);
    const list = t.cornerList.filter((c) => c.minR < 230 && c.s1 - c.s0 > 20);
    const meshes = { 150: mk('150', list.length), 100: mk('100', list.length), 50: mk('50', list.length) };
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x55595f }), list.length * 3);
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
    const drsMat = new THREE.MeshLambertMaterial({ map: logoTexture('DRS', INK.chalk, '#11865a'), side: THREE.DoubleSide });
    t.drsZones.forEach((z) => {
      const i = Math.round(z.start / t.ds) % t.N;
      this.place(z.start, -t.wallR[i] + 1.5);
      const m = new THREE.Mesh(plane, drsMat);
      m.scale.set(1.8, 0.8, 1); m.position.set(P.x, P.y + 2.2, P.z); m.rotation.y = P.psi + Math.PI; this.group.add(m);
    });
  }

  buildHoardings() {
    const t = this.track; const N = t.N;
    const K = SPONSORS.length;
    const geo = new THREE.PlaneGeometry(8, 1.5);
    const per = Array.from({ length: K }, () => []);
    let run = 0;
    for (let s = 120; s < t.length; s += 64) {
      const i = Math.round(s / t.ds) % N;
      // only along straight-ish parts
      if (Math.abs(t.k[i]) > 1 / 700) continue;
      run++;
      for (const sg of [1, -1]) {
        const wn = sg > 0 ? t.wallL[i] : t.wallR[i];
        if ((sg > 0 ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0) continue;
        const n = sg * (wn - 0.25);
        this.place(s, n);
        const x = P.x, y = P.y, z = P.z; this.place(s, 0);
        per[(run + (sg > 0 ? 0 : 2)) % K].push([x, y + 1.95, z, P.x, P.z]);   // faces the centreline (lookAt), so text never reads mirrored
      }
    }
    const d = new THREE.Object3D();
    per.forEach((arr, k) => {
      if (!arr.length) return;
      const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ map: sponsorTexture(k) }), arr.length);
      arr.forEach((p, j) => { d.position.set(p[0], p[1], p[2]); d.rotation.set(0, 0, 0); d.lookAt(p[3], p[1], p[4]); d.updateMatrix(); im.setMatrixAt(j, d.matrix); });
      im.instanceMatrix.needsUpdate = true;
      this.addBucket(im, arr[0][0], arr[0][2], 'hoarding', 1e9);
    });
  }

  addBucket(obj, cx, cz, kind, dist) { this.group.add(obj); this.buckets.push({ obj, cx, cz, kind, dist }); }

  // ---------------------------------------------------------------- grandstands
  /** one 30 m stand facing local -x: raked seating (crowd texture) + structure (back wall, end walls, columns, roof) */
  standGeometries() {
    if (this._standGeo) return this._standGeo;
    const seats = new THREE.BufferGeometry();
    const xf = -4.6, yf = 1.2, xb = 3.8, yb = 7.6, hz = 15;   // front low edge -> back high edge
    seats.setAttribute('position', new THREE.Float32BufferAttribute([xf, yf, -hz, xf, yf, hz, xb, yb, hz, xb, yb, -hz], 3));
    seats.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 3, 0, 3, 1, 0, 1], 2));
    seats.setIndex([0, 2, 1, 0, 3, 2]); seats.computeVertexNormals();
    const conc = 0x9a9ea3, roof = 0xe4e2dc, steel = 0x4a4f57;
    const parts = [
      box(0.5, 8.4, 30, 4.2, 4.2, 0, conc),                              // back wall
      box(9.2, 1.2, 30, -0.2, 0.6, 0, 0x7d8288),                         // base under the front
      box(0.3, 1.0, 30, -4.75, 1.6, 0, 0x2b2e33),                        // front parapet
      box(10.8, 0.3, 31, -0.6, 10.6, 0, roof),                           // roof slab
    ];
    for (const z of [-14.6, 14.6]) { const end = new THREE.BufferGeometry(); end.setAttribute('position', new THREE.Float32BufferAttribute([xf, 0, z, xb + 0.4, 0, z, xb + 0.4, yb + 0.6, z, xf, 0, z, xb + 0.4, yb + 0.6, z, xf, yf + 0.4, z], 3)); end.computeVertexNormals(); parts.push(tintGeo(end, conc)); const e2 = end.clone(); const ix = e2.attributes.position; for (let i = 0; i < ix.count; i += 3) { const a = [ix.getX(i + 1), ix.getY(i + 1), ix.getZ(i + 1)]; ix.setXYZ(i + 1, ix.getX(i + 2), ix.getY(i + 2), ix.getZ(i + 2)); ix.setXYZ(i + 2, a[0], a[1], a[2]); } e2.computeVertexNormals(); parts.push(tintGeo(e2, conc)); }
    for (const z of [-13, 0, 13]) parts.push(box(0.3, 9.2, 0.3, -4.4, 6.0, z, steel), box(0.3, 3.0, 0.3, 4.2, 9.5, z, steel));
    this._standGeo = { seats, frame: mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g))) };
    return this._standGeo;
  }
  buildStands() {
    const t = this.track, N = t.N;
    const crowd = crowdTexture(); crowd.repeat.set(1, 1);
    const mat = new THREE.MeshLambertMaterial({ map: crowd, side: THREE.DoubleSide });
    const spots = [];
    const addRange = (s0, s1, side) => { for (let s = s0; s < s1; s += 31) spots.push([(s + t.length) % t.length, side]); };
    // main straight, opposite the pits and behind the garages
    addRange(-380, 320, -t.pitSide);
    // outside of the tightest corners
    const corners = t.cornerList.slice().sort((a, b) => a.minR - b.minR).slice(0, 4);
    for (const c of corners) addRange(c.apex - 80, c.apex + 80, c.dir > 0 ? -1 : 1);
    const G = this.standGeometries();
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
      const stands = new THREE.InstancedMesh(G.seats, mat, arr.length), frames = new THREE.InstancedMesh(G.frame, this.vcMat, arr.length);
      arr.forEach(([s, side, wn], j) => {
        const nn = side * (wn + 8 + this.rnd() * 3);
        this.place(s, nn);
        d.position.set(P.x, P.y - 0.2, P.z); d.rotation.set(0, P.psi + (side > 0 ? 0 : Math.PI), 0); d.scale.set(1, 1, 1); d.updateMatrix(); stands.setMatrixAt(j, d.matrix); frames.setMatrixAt(j, d.matrix);
      });
      stands.instanceMatrix.needsUpdate = true; frames.instanceMatrix.needsUpdate = true;
      frames.castShadow = this.q.shadows > 1;
      const g = new THREE.Group(); g.add(stands, frames);
      this.place(arr[0][0], 0);
      this.addBucket(g, P.x, P.z, 'stand', 1100);
    }
  }

  // ---------------------------------------------------------------- trees (forest conifers / parkland / desert scrub) and city blocks
  buildTrees() {
    const t = this.track, N = t.N, th = t.def.theme || {};
    const density = th.forest ? 1.0 : th.desert ? 0.12 : 0.45;
    let crown;
    if (th.forest) {            // conifer: two stacked cones
      const a = new THREE.ConeGeometry(2.8, 6.5, 7).translate(0, 5.6, 0), b = new THREE.ConeGeometry(2.0, 5.5, 7).translate(0, 9.2, 0);
      crown = mergeGeometries([tintGeo(a, 0x2a5a30), tintGeo(b, 0x34683a)]);
    } else if (th.desert) {     // low scrub
      crown = tintGeo(crownGeo(1.6, 0, 1.6, 0, 1.3, 0.7, 1.3), 0x8a8a4e);
    } else {                    // broadleaf: lumpy crown
      crown = mergeGeometries([tintGeo(crownGeo(3.0, 0, 6.6, 0), 0x3d6e33), tintGeo(crownGeo(2.2, 1.3, 7.8, 0.6), 0x4a7d3c), tintGeo(crownGeo(2.0, -1.2, 7.2, -0.8), 0x36622f)]);
    }
    const trunk = tintGeo(new THREE.CylinderGeometry(0.28, 0.45, th.forest ? 3.4 : 4.4, 5).translate(0, th.forest ? 1.7 : 2.2, 0), 0x4a3524);
    const treeGeo = mergeGeometries([crown, trunk]);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const spacing = 30 / density;
    const buckets = new Map();
    const tintA = new THREE.Color();
    for (let s = 0; s < t.length; s += spacing) {
      const i = Math.round(s / t.ds) % N;
      const key = Math.floor(s / 500);
      for (const sg of [1, -1]) {
        if (this.rnd() < 0.15) continue;
        const wn = sg > 0 ? t.wallL[i] : t.wallR[i];
        if ((sg > 0 ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0) continue;
        const nn = sg * (wn + 14 + this.rnd() * 70);
        this.place(s + (this.rnd() - 0.5) * 20, nn);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push([P.x, P.y - 1.4, P.z, 0.7 + this.rnd() * 0.9]);
      }
    }
    const d = new THREE.Object3D();
    for (const arr of buckets.values()) {
      const im = new THREE.InstancedMesh(treeGeo, mat, arr.length);
      arr.forEach((p, j) => {
        d.position.set(p[0], p[1], p[2]); d.scale.set(p[3], p[3] * (0.9 + this.rnd() * 0.5), p[3]); d.rotation.y = this.rnd() * 6; d.updateMatrix(); im.setMatrixAt(j, d.matrix);
        const v = 0.78 + this.rnd() * 0.4; tintA.setRGB(v * (0.92 + this.rnd() * 0.16), v, v * (0.85 + this.rnd() * 0.2)); im.setColorAt(j, tintA);   // per-tree shade variation
      });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.addBucket(im, arr[0][0], arr[0][2], 'tree', 900);
    }
  }
  buildBuildings() {
    const t = this.track, N = t.N;
    const win = windowTexture(2, true); win.repeat.set(1.5, 2.2);
    const mat = new THREE.MeshLambertMaterial({ map: win });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const pastel = [0xf6e2c4, 0xf0cdb8, 0xfaf4ea, 0xe8d6b0, 0xf3d8c8, 0xdfe3e2, 0xf7e4bc, 0xe9c7a6];
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
        buckets.get(key).push([P.x, P.y + h / 2 - 3, P.z, P.psi, w, h, dpt, pastel[Math.floor(this.rnd() * pastel.length)]]);
      }
    }
    const d = new THREE.Object3D(), c = new THREE.Color();
    for (const arr of buckets.values()) {
      const im = new THREE.InstancedMesh(geo, mat, arr.length);
      arr.forEach((p, j) => { d.position.set(p[0], p[1], p[2]); d.rotation.set(0, p[3], 0); d.scale.set(p[4], p[5], p[6]); d.updateMatrix(); im.setMatrixAt(j, d.matrix); im.setColorAt(j, c.set(p[7])); });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
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
