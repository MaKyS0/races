// CarParts: procedural geometry of the single-seater (team independent, shared by every car). +x = left, +y = up, +z = forward.
// All pieces are returned non-indexed with position / normal / (optional) colour only, ready to be merged.
//   detail 0 = low (phones' fallback), 1 = medium, 2 = high - the same car, fewer rings / segments / small parts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR, WX, WY } from '../physics/VehiclePhysics.js';

export const COL = {
  carbon: 0x30333b, carbonLight: 0x42464f, black: 0x0c0d10, rubber: 0x1b1c20, metal: 0xa4a9b1, steel: 0x6d727a,
  visor: 0x07090d, caliper: 0xc9302a, white: 0xeeeeee, light: 0xff2a1a, gold: 0xc8a24a,
};

// ------------------------------------------------------------------ primitives
export function tint(g, color) {
  const n = g.attributes.position.count, c = new THREE.Color(color), arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return g;
}
/** position + normal (+ colour) only, non-indexed: the common denominator mergeGeometries needs */
export function clean(g) {
  const r = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(r.attributes)) if (!['position', 'normal', 'color'].includes(k)) r.deleteAttribute(k);
  return r;
}
export const merge = (list) => mergeGeometries(list.map(clean), false);
export function boxG(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z); return g;
}
export function cylG(r1, r2, h, seg, x, y, z, axis = 'x') {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z); return g;
}
export function tubeG(a, b, r, seg = 6) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  const m = va.clone().add(vb).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z); return g;
}
/** make the triangle winding point outwards (signed volume > 0) */
function fixWinding(g) {
  const p = g.attributes.position.array, ix = g.index.array; let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (v < 0) for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
}
function indexed(pos, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  fixWinding(g); g.computeVertexNormals(); return g;
}

/** lofted body: rings of a super-ellipse (ex = squareness) along z. Sections must be ordered front -> back. */
export function loft(sections, { xOff = 0, n = 14, caps = true } = {}) {
  const pos = [], idx = [];
  for (const s of sections) {
    const ex = s.ex ?? 3, cy = (s.bot + s.top) / 2, hh = (s.top - s.bot) / 2, xc = s.xc ?? 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      pos.push(xOff + xc + Math.sign(c) * Math.pow(Math.abs(c), 2 / ex) * s.w, cy + Math.sign(sn) * Math.pow(Math.abs(sn), 2 / ex) * hh, s.z);
    }
  }
  for (let i = 0; i < sections.length - 1; i++) for (let k = 0; k < n; k++) {
    const a = i * n + k, b = i * n + ((k + 1) % n), c = (i + 1) * n + k, d = (i + 1) * n + ((k + 1) % n);
    idx.push(a, c, b, b, c, d);
  }
  if (caps) {
    const first = sections[0], last = sections[sections.length - 1];
    const cf = pos.length / 3; pos.push(xOff + (first.xc ?? 0), (first.bot + first.top) / 2, first.z);
    for (let k = 0; k < n; k++) idx.push(cf, k, (k + 1) % n);
    const lb = (sections.length - 1) * n, cb = pos.length / 3; pos.push(xOff + (last.xc ?? 0), (last.bot + last.top) / 2, last.z);
    for (let k = 0; k < n; k++) idx.push(cb, lb + ((k + 1) % n), lb + k);
  }
  return indexed(pos, idx);
}
/** height of the top of a section list at z (linear), used to lay livery stripes on the surface */
export function topAt(sections, z) {
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    if (z <= a.z && z >= b.z) { const t = (a.z - z) / (a.z - b.z); return a.top + (b.top - a.top) * t; }
  }
  return sections[sections.length - 1].top;
}
/** thin plate with an arbitrary (z, y) outline, thickness t along x, centred on x */
export function plateX(outline, x, t) {
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 4 });
  g.rotateY(Math.PI / 2); g.translate(x - t / 2, 0, 0); return g;
}
/** aerofoil element swept along x: chord c, thickness ratio th, camber cam (negative = suction side down), pitch p (rad, trailing edge up) */
export function foilProfile(c, th, cam, p, m = 6) {
  const up = [], lo = [];
  for (let i = 0; i <= m; i++) {
    const t = i / m, yt = 5 * th * c * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4), yc = cam * c * 4 * t * (1 - t);
    up.push([c * (0.5 - t), yc + yt]); lo.push([c * (0.5 - t), yc - yt]);
  }
  const pts = up.concat(lo.slice(1, -1).reverse());
  const cp = Math.cos(p), sp = Math.sin(p);
  return pts.map(([z, y]) => [z * cp + y * sp, y * cp - z * sp]);
}
export function sweepX(prof, xa, xb, y0, z0, { sa = 1, sb = 1, m = 6 } = {}) {
  const pos = [], idx = [], n = prof.length;
  for (const [x, s] of [[xa, sa], [xb, sb]]) for (const [z, y] of prof) pos.push(x, y0 + y * s, z0 + z * s);
  for (let k = 0; k < n; k++) { const b = (k + 1) % n; idx.push(k, n + k, b, b, n + k, n + b); }
  let cz = 0, cy = 0; for (const [z, y] of prof) { cz += z; cy += y; } cz /= n; cy /= n;
  const ca = pos.length / 3; pos.push(xa, y0 + cy * sa, z0 + cz * sa); for (let k = 0; k < n; k++) idx.push(ca, (k + 1) % n, k);
  const cb = pos.length / 3; pos.push(xb, y0 + cy * sb, z0 + cz * sb); for (let k = 0; k < n; k++) idx.push(cb, n + k, n + ((k + 1) % n));
  return indexed(pos, idx);
}
const foil = (xa, xb, y0, z0, c, th, cam, p, sc = {}) => sweepX(foilProfile(c, th, cam, p), xa, xb, y0, z0, sc);

// ------------------------------------------------------------------ the car
// monocoque + nose (front -> back)
export const MONO = [
  { z: 2.40, w: 0.030, bot: 0.105, top: 0.150, ex: 2.5 }, { z: 2.22, w: 0.062, bot: 0.100, top: 0.185, ex: 2.8 }, { z: 1.90, w: 0.098, bot: 0.095, top: 0.235 },
  { z: 1.50, w: 0.150, bot: 0.095, top: 0.292 }, { z: 1.10, w: 0.205, bot: 0.095, top: 0.362 }, { z: 0.75, w: 0.242, bot: 0.095, top: 0.445 },
  { z: 0.40, w: 0.265, bot: 0.100, top: 0.522, ex: 3.2 }, { z: 0.10, w: 0.275, bot: 0.105, top: 0.545, ex: 3.6 }, { z: -0.35, w: 0.275, bot: 0.110, top: 0.572, ex: 3.6 },
  { z: -0.85, w: 0.250, bot: 0.120, top: 0.600, ex: 3.2 }, { z: -1.35, w: 0.200, bot: 0.140, top: 0.560 }, { z: -1.90, w: 0.120, bot: 0.180, top: 0.470 },
  { z: -2.30, w: 0.070, bot: 0.240, top: 0.405 },
];
export const COVER = [
  { z: 0.12, w: 0.110, bot: 0.575, top: 0.640 }, { z: -0.04, w: 0.160, bot: 0.560, top: 0.870 }, { z: -0.55, w: 0.150, bot: 0.560, top: 0.905 },
  { z: -1.20, w: 0.112, bot: 0.500, top: 0.750 }, { z: -1.85, w: 0.078, bot: 0.430, top: 0.580 }, { z: -2.36, w: 0.052, bot: 0.370, top: 0.470 },
];
const POD = [
  { z: 0.78, w: 0.125, bot: 0.130, top: 0.300, ex: 2.6 }, { z: 0.45, w: 0.180, bot: 0.100, top: 0.385 }, { z: 0.00, w: 0.215, bot: 0.090, top: 0.452 },
  { z: -0.70, w: 0.200, bot: 0.090, top: 0.420 }, { z: -1.40, w: 0.130, bot: 0.105, top: 0.300 }, { z: -2.00, w: 0.070, bot: 0.125, top: 0.215 },
];
export const POD_X = 0.50;
const FLOOR = [
  { z: 1.50, w: 0.45, bot: 0.040, top: 0.075, ex: 5 }, { z: 0.80, w: 0.82, bot: 0.040, top: 0.075, ex: 5 }, { z: -0.60, w: 0.80, bot: 0.040, top: 0.075, ex: 5 },
  { z: -1.80, w: 0.72, bot: 0.040, top: 0.075, ex: 5 }, { z: -2.15, w: 0.50, bot: 0.070, top: 0.110, ex: 5 },
];

export function buildParts(detail = 1) {
  const D = detail, n = [10, 14, 18][D];
  const P = {};
  // ============ team-coloured bodywork
  P.mono = loft(MONO, { n });
  P.cover = loft(COVER, { n });
  P.podL = loft(POD, { xOff: POD_X, n }); P.podR = loft(POD, { xOff: -POD_X, n });
  P.body = [P.mono, P.cover, P.podL, P.podR];
  // ============ livery stripes (accent colour): laid on the top surface
  const stripeOn = (secs, z0, z1, w, steps) => {
    const s = []; for (let i = 0; i <= steps; i++) { const z = z0 + (z1 - z0) * i / steps; const t = topAt(secs, z); s.push({ z, w, bot: t - 0.012, top: t + 0.006, ex: 6 }); } return loft(s, { n: 8 });
  };
  const acc = [stripeOn(MONO, 2.30, 0.62, 0.05, 8), stripeOn(COVER, -0.05, -2.30, 0.045, 7)];
  P.accent = acc;
  // ============ cockpit, driver area
  const detail_ = [];
  const add = (g, color) => detail_.push(tint(clean(g), color));
  add(boxG(0.30, 0.012, 0.98, 0, 0.552, 0.07, -0.015), COL.black);                      // cockpit opening (dark)
  add(tubeG([0.17, 0.560, 0.62], [0.205, 0.590, -0.48], 0.026, 8), COL.carbonLight);     // coaming
  add(tubeG([-0.17, 0.560, 0.62], [-0.205, 0.590, -0.48], 0.026, 8), COL.carbonLight);
  add(tubeG([0.17, 0.560, 0.62], [-0.17, 0.560, 0.62], 0.024, 8), COL.carbonLight);      // scuttle
  add(boxG(0.25, 0.20, 0.09, 0, 0.69, -0.16, -0.2), COL.carbon);                         // head rest
  add(boxG(0.30, 0.12, 0.20, 0, 0.60, -0.06), COL.carbon);                               // driver's shoulders area (seat)
  add(boxG(0.26, 0.11, 0.03, 0, 0.64, 0.46, -0.55), COL.black);                         // steering wheel
  add(boxG(0.075, 0.04, 0.006, 0, 0.652, 0.45, -0.55), 0x3fd2ff);                        // wheel display
  add(boxG(0.05, 0.10, 0.04, 0, 0.60, 0.50, 0.5), COL.steel);                            // steering column
  // halo (3-point) with its mounting
  const halo = [tubeG([0, 0.64, 0.74], [0, 0.85, 0.50], 0.030, 8), tubeG([0, 0.85, 0.50], [0.21, 0.81, 0.13], 0.026, 8), tubeG([0, 0.85, 0.50], [-0.21, 0.81, 0.13], 0.026, 8),
    tubeG([0.21, 0.81, 0.13], [0.255, 0.60, 0.10], 0.026, 8), tubeG([-0.21, 0.81, 0.13], [-0.255, 0.60, 0.10], 0.026, 8), boxG(0.07, 0.07, 0.07, 0, 0.62, 0.76)];
  for (const g of halo) add(g, COL.carbon);
  // intake of the airbox, radio/camera pods
  add(boxG(0.17, 0.15, 0.03, 0, 0.745, -0.005, -0.55), COL.black);
  add(boxG(0.05, 0.05, 0.07, 0.16, 0.86, -0.3), COL.carbonLight); add(boxG(0.05, 0.05, 0.07, -0.16, 0.86, -0.3), COL.carbonLight);   // camera pods
  // shark fin
  add(plateX([[-0.55, 0.905], [-2.28, 0.70], [-2.34, 0.45], [-1.2, 0.72]], 0, 0.022), COL.carbonLight);
  // sidepod inlets + louvres + undercut shadow
  for (const s of [1, -1]) {
    add(boxG(0.21, 0.13, 0.03, s * POD_X, 0.225, 0.775, 0.1), COL.black);
    add(boxG(0.30, 0.010, 0.30, s * POD_X, 0.095, 0.28), COL.carbon);
    if (D >= 1) for (let i = 0; i < 5; i++) add(boxG(0.14, 0.010, 0.028, s * POD_X, topAt(POD, -0.85 - i * 0.07) + 0.002, -0.85 - i * 0.07, 0.15), COL.black);
  }
  // exhaust, crash structure, rain light
  add(cylG(0.048, 0.040, 0.30, 10, 0, 0.455, -2.44, 'z'), COL.black); add(cylG(0.052, 0.052, 0.02, 10, 0, 0.455, -2.60, 'z'), COL.steel);
  add(loft([{ z: -2.30, w: 0.065, bot: 0.26, top: 0.40 }, { z: -2.70, w: 0.055, bot: 0.30, top: 0.38 }], { n: 8 }), COL.carbon);
  // mirrors: stalk + housing + glass
  for (const s of [1, -1]) {
    add(tubeG([s * 0.28, 0.60, 0.60], [s * 0.455, 0.735, 0.70], 0.012, 6), COL.carbon);
    add(boxG(0.15, 0.075, 0.045, s * 0.50, 0.745, 0.70, 0, s * -0.12), COL.carbonLight);
    add(boxG(0.13, 0.062, 0.006, s * 0.50, 0.745, 0.673, 0, s * -0.12), COL.visor);
  }
  // floor + diffuser + edge wing fences
  add(loft(FLOOR, { n: 8 }), COL.carbon);
  add(boxG(0.92, 0.020, 0.55, 0, 0.125, -2.27, 0.26), COL.carbon);
  const strakes = D === 0 ? 3 : 5;
  for (let i = 0; i < strakes; i++) { const x = (i - (strakes - 1) / 2) * 0.17; add(boxG(0.012, 0.115, 0.52, x, 0.115, -2.25, 0.26), COL.carbonLight); }
  if (D >= 1) {
    for (const s of [1, -1]) {
      for (let i = 0; i < 4; i++) add(boxG(0.012, 0.075, 0.34, s * (0.70 + i * 0.03), 0.105, 0.35 - i * 0.55, 0, s * 0.08), COL.carbonLight);
      add(boxG(0.10, 0.012, 0.70, s * 0.80, 0.12, -1.2, 0, 0, s * -0.12), COL.carbon);   // floor-edge wing
      for (let i = 0; i < 3; i++) add(plateX([[1.35 - i * 0.07, 0.07], [1.30 - i * 0.12, 0.38 - i * 0.04], [1.05 - i * 0.12, 0.40 - i * 0.03], [0.96 - i * 0.10, 0.32], [1.10 - i * 0.08, 0.08]], s * (0.50 - i * 0.09), 0.012), COL.carbon);   // bargeboards
      if (D >= 2) { add(plateX([[0.95, 0.10], [0.85, 0.44], [0.62, 0.46], [0.56, 0.12]], s * 0.62, 0.012), COL.carbonLight); add(boxG(0.10, 0.012, 0.50, s * 0.66, 0.43, 0.25, 0.0, 0.0, s * -0.1), COL.carbon); }   // vortex generators / deflector
    }
  }
  // rear: beam wing, lower element, crash/wing pylon
  add(foil(-0.40, 0.40, 0.50, -2.42, 0.21, 0.07, -0.05, 0.12), COL.carbon);
  add(boxG(0.075, 0.50, 0.11, 0, 0.67, -2.36), COL.carbon);
  add(cylG(0.012, 0.012, 0.74, 6, 0, 0.45, -2.30, 'x'), COL.steel);
  P.detail = merge(detail_);

  // light (emissive): rain light + brake light strip on the wing endplates
  P.lights = merge([tint(clean(boxG(0.08, 0.075, 0.02, 0, 0.60, -2.745)), COL.light), tint(clean(boxG(0.012, 0.03, 0.03, 0.485, 1.02, -2.80)), COL.light), tint(clean(boxG(0.012, 0.03, 0.03, -0.485, 1.02, -2.80)), COL.light)]);

  // ============ front wing (left/right halves so damage can take one off): 4 elements, endplate, footplate, strakes, pylons
  const fw = (s) => {
    const g = [];
    const x0 = s > 0 ? 0.03 : -0.99, x1 = s > 0 ? 0.99 : -0.03;
    g.push(foil(x0, x1, 0.095, 2.66, 0.34, 0.07, -0.04, 0.05));                          // main plane
    g.push(foil(x0 + (s > 0 ? 0.10 : 0), x1 - (s > 0 ? 0 : 0.10), 0.150, 2.62, 0.24, 0.05, -0.08, 0.30));
    g.push(foil(x0 + (s > 0 ? 0.30 : 0), x1 - (s > 0 ? 0 : 0.30), 0.205, 2.585, 0.20, 0.045, -0.08, 0.40));
    if (D >= 1) g.push(foil(x0 + (s > 0 ? 0.36 : 0), x1 - (s > 0 ? 0 : 0.36), 0.250, 2.555, 0.17, 0.04, -0.08, 0.50));
    if (D >= 1) g.push(boxG(0.30, 0.012, 0.28, s * 0.20, 0.060, 2.66));                    // central tray
    g.push(plateX([[2.86, 0.045], [2.88, 0.30], [2.62, 0.33], [2.38, 0.22], [2.40, 0.045]], s * 0.985, 0.014));   // endplate
    if (D >= 1) { g.push(boxG(0.12, 0.010, 0.32, s * 0.935, 0.048, 2.68)); }               // footplate
    if (D >= 2) for (let i = 0; i < 3; i++) g.push(boxG(0.010, 0.06 + i * 0.012, 0.22, s * (0.30 + i * 0.12), 0.128 + i * 0.015, 2.60));   // strakes
    return merge(g.map((x) => tint(clean(x), COL.carbon)));
  };
  P.fwL = fw(1); P.fwR = fw(-1);
  P.fwNose = merge([tint(clean(boxG(0.045, 0.10, 0.50, 0.11, 0.14, 2.42, 0, 0.1)), COL.carbon), tint(clean(boxG(0.045, 0.10, 0.50, -0.11, 0.14, 2.42, 0, -0.1)), COL.carbon)]);

  // ============ rear wing: fixed (main plane, lower plane, endplates) + DRS flap (origin at its pivot)
  const rf = [foil(-0.47, 0.47, 0.91, -2.52, 0.38, 0.075, -0.07, 0.22), foil(-0.47, 0.47, 0.72, -2.55, 0.30, 0.06, -0.06, 0.18)];
  if (D >= 1) rf.push(foil(-0.47, 0.47, 0.60, -2.58, 0.24, 0.05, -0.05, 0.12));
  for (const s of [1, -1]) {
    rf.push(plateX([[-2.22, 0.50], [-2.26, 0.95], [-2.50, 1.10], [-2.80, 1.14], [-2.84, 0.90], [-2.70, 0.55], [-2.52, 0.48]], s * 0.482, 0.014));
    if (D >= 2) for (let i = 0; i < 3; i++) rf.push(boxG(0.016, 0.014, 0.20, s * 0.482, 0.62 + i * 0.12, -2.62, 0, 0, 0));
  }
  P.rwFixed = merge(rf.map((x) => tint(clean(x), COL.carbon)));
  P.rwFlap = tint(clean(foil(-0.465, 0.465, 0, -0.17, 0.30, 0.05, -0.07, 0.10)), COL.carbon);
  P.rwFlap2 = D >= 1 ? tint(clean(foil(-0.465, 0.465, 0.065, -0.40, 0.17, 0.04, -0.06, 0.28)), COL.carbonLight) : null;

  // ============ helmet (vertex coloured per team at build time): shell + visor + stripe
  P.helmetShell = new THREE.SphereGeometry(0.135, D === 0 ? 10 : 16, D === 0 ? 8 : 12); P.helmetShell.scale(1, 1.05, 1.18); P.helmetShell.translate(0, 0.725, 0.08);
  P.visor = new THREE.SphereGeometry(0.139, D === 0 ? 8 : 14, D === 0 ? 4 : 6, -Math.PI * 0.30, Math.PI * 0.60, Math.PI * 0.36, Math.PI * 0.22); P.visor.scale(1, 1.05, 1.18); P.visor.translate(0, 0.725, 0.082);
  // ============ suspension (both axles): wishbones, push/pull rod, tie rod, rocker, damper
  const sus = [];
  for (let i = 0; i < 4; i++) {
    const side = Math.sign(WY[i]), wz = WX[i], xin = WY[i] - side * 0.20, rr = CAR.Rw[i], fr = i < 2;
    const r = D === 0 ? 0.011 : 0.013, sg = D === 0 ? 4 : 6;
    sus.push(
      tubeG([side * 0.24, 0.35, wz + 0.26], [xin, rr + 0.075, wz + 0.02], r, sg), tubeG([side * 0.24, 0.35, wz - 0.26], [xin, rr + 0.075, wz - 0.02], r, sg),    // upper wishbone
      tubeG([side * 0.25, 0.13, wz + 0.30], [xin, rr - 0.070, wz + 0.02], r * 1.1, sg), tubeG([side * 0.25, 0.13, wz - 0.30], [xin, rr - 0.070, wz - 0.02], r * 1.1, sg), // lower wishbone
      tubeG([xin, fr ? rr + 0.075 : rr - 0.07, wz], [side * 0.13, fr ? 0.42 : 0.17, wz + (fr ? -0.05 : 0.02)], r * 0.95, sg),   // push / pull rod
      tubeG([side * 0.16, 0.22, wz - 0.22], [xin, rr + 0.01, wz - 0.07], r * 0.8, sg),   // tie rod
    );
    if (D >= 1) sus.push(boxG(0.06, 0.05, 0.10, side * 0.13, fr ? 0.42 : 0.17, wz - (fr ? 0.05 : 0), 0, 0, side * 0.4), cylG(0.018, 0.018, 0.2, 6, side * 0.10, fr ? 0.36 : 0.20, wz, 'z'));
  }
  P.suspension = merge(sus.map((g) => tint(clean(g), COL.steel)));
  return P;
}

// ------------------------------------------------------------------ wheels (origin = wheel centre, +x = outboard for a left wheel)
function tyreProfile(hw) {
  // (radius fraction, axial) from the inner bead to the outer bead: flat sidewalls, rounded shoulders, flat tread
  return [[0.60, -hw * 0.92], [0.66, -hw], [0.90, -hw], [0.955, -hw * 0.93], [0.992, -hw * 0.72], [1.0, -hw * 0.5], [1.0, hw * 0.5], [0.992, hw * 0.72], [0.955, hw * 0.93], [0.90, hw], [0.66, hw], [0.60, hw * 0.92]]
    .map(([r, a]) => new THREE.Vector2(r, a));
}
/** the rolling part of a wheel (tyre + wheel cover): vertex coloured, scaled to the real radius; mirrored by the caller's flip group */
export function wheelSpinGeo(rear, D = 1) {
  const R = rear ? CAR.Rw[2] : CAR.Rw[0], hw = rear ? 0.235 : 0.205, seg = [14, 22, 30][D];
  const tyre = new THREE.LatheGeometry(tyreProfile(hw), seg); tyre.rotateZ(Math.PI / 2);
  const parts = [tint(clean(tyre), COL.rubber)];
  // tread grooves (3 circumferential) for the close-ups
  if (D >= 2) for (const a of [-0.28, 0, 0.28]) { const gr = new THREE.TorusGeometry(1.0, 0.012, 3, seg); gr.rotateY(Math.PI / 2); gr.translate(a * hw * 1.6, 0, 0); parts.push(tint(clean(gr), 0x0a0a0c)); }
  const F = hw * 0.70 - 0.01;                                                    // outer face of the (recessed) wheel barrel
  const rimSeg = [10, 14, 20][D];
  parts.push(tint(clean(cylG(0.62, 0.62, F + hw * 0.7 + 0.01, rimSeg, F / 2 - hw * 0.35 - 0.005, 0, 0)), COL.black));   // barrel / backing
  const lip = new THREE.TorusGeometry(0.635, 0.03, 5, rimSeg * 2); lip.rotateY(Math.PI / 2); lip.translate(F + 0.02, 0, 0);
  parts.push(tint(clean(lip), COL.metal));                                                                        // outer lip (open ring)
  parts.push(tint(clean(cylG(0.15, 0.17, 0.05, rimSeg, F + 0.03, 0, 0)), COL.steel));                             // hub
  parts.push(tint(clean(cylG(0.075, 0.075, 0.036, 6, F + 0.05, 0, 0)), COL.gold));                                // wheel nut
  const spokes = D === 0 ? 4 : 6;
  for (let i = 0; i < spokes; i++) {                                              // spokes from the hub (r ~0.15) to the lip (r ~0.64)
    const sp = boxG(0.022, 0.49, 0.085, F + 0.02, 0.395, 0); sp.applyMatrix4(new THREE.Matrix4().makeRotationX((i / spokes) * Math.PI * 2));
    parts.push(tint(clean(sp), COL.metal));
  }
  if (D >= 2) for (let i = 0; i < 12; i++) { const bl = boxG(0.012, 0.07, 0.03, F + 0.012, 0.53, 0); bl.applyMatrix4(new THREE.Matrix4().makeRotationX((i / 12) * Math.PI * 2)); parts.push(tint(clean(bl), COL.black)); }
  const g = merge(parts); g.scale(1, R, R); return g;
}
/** the brake disc (separate mesh: it glows with temperature) */
export function discGeo(rear, D = 1) { const R = rear ? CAR.Rw[2] : CAR.Rw[0], hw = rear ? 0.235 : 0.205; const g = cylG(0.52, 0.52, 0.008, [10, 14, 20][D], hw * 0.70 - 0.006, 0, 0); g.scale(1, R, R); return clean(g); }
/** compound marking ring on the sidewall */
export function ringGeo(rear, D = 1) { const R = rear ? CAR.Rw[2] : CAR.Rw[0], hw = rear ? 0.235 : 0.205; const g = new THREE.RingGeometry(0.80, 0.90, [16, 24, 32][D]); g.rotateY(Math.PI / 2); g.translate(hw + 0.003, 0, 0); g.scale(1, R, R); return clean(g); }
/** parts that steer with the wheel but do not spin: upright, axle, brake duct, caliper */
export function wheelStaticGeo(rear, side, D = 1) {
  const R = rear ? CAR.Rw[2] : CAR.Rw[0];
  const parts = [
    cylG(0.035, 0.035, 0.30, 8, -side * 0.10, 0, 0, 'x'), boxG(0.05, 0.30 * R / 0.335 + 0.07, 0.07, -side * 0.18, 0.01, 0.01),
    cylG(R * 0.62, R * 0.55, 0.13, D === 0 ? 8 : 14, -side * 0.15, 0, 0, 'x'),                                  // brake duct drum
    boxG(0.09, 0.075, 0.15, -side * 0.06, R * 0.34, 0), boxG(0.09, 0.075, 0.15, -side * 0.06, -R * 0.34, 0),     // calipers
  ];
  const ducts = [boxG(0.07, 0.04, R * 0.9, -side * 0.18, R * 0.45, R * 0.0)];
  const cal = [parts[3], parts[4]];
  const body = merge([tint(clean(parts[0]), COL.steel), tint(clean(parts[1]), COL.steel), tint(clean(parts[2]), COL.carbon), tint(clean(cal[0]), COL.caliper), tint(clean(cal[1]), COL.caliper), ...(D >= 1 ? ducts.map((d) => tint(clean(d), COL.carbonLight)) : [])]);
  return body;
}

export { WX, WY };
