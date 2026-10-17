// Horizon: three rings of distant hills / mountains around the circuit, so the world does not end in a flat fog line. Each ring is a
// single strip mesh (~360 triangles) with a noise silhouette; colour = the sky's horizon colour mixed with the land tint, less of the
// land the further away the ring is (aerial perspective), so the rings follow the time of day and the weather. Cheap enough for Low.
import * as THREE from 'three';
import { makeRng } from '../core/math.js';

const RIDGES = [{ r: 1500, h: [40, 150], mix: 0.62, f: 3.0 }, { r: 2600, h: [90, 300], mix: 0.42, f: 2.2 }, { r: 3800, h: [160, 520], mix: 0.24, f: 1.6 }];

export class Horizon {
  constructor(track) {
    const th = track.def.theme || {};
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
    for (let i = 0; i < track.N; i++) { minX = Math.min(minX, track.lineX[i]); maxX = Math.max(maxX, track.lineX[i]); minZ = Math.min(minZ, track.lineZ[i]); maxZ = Math.max(maxZ, track.lineZ[i]); minY = Math.min(minY, track.y[i]); }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, ext = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    const hills = th.hills ?? (th.desert ? 0.35 : th.city ? 1.35 : th.forest ? 1.1 : 0.7);
    this.tint = new THREE.Color(th.desert ? 0xa88e66 : th.city ? 0x5a6656 : th.forest ? 0x2f4a33 : 0x3f5a3c);
    this.group = new THREE.Group(); this.mats = [];
    const rnd = makeRng(track.N * 7 + 13);
    RIDGES.forEach((R, ri) => {
      const seg = 180, pos = [], col = [], idx = [];
      const phase = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
      const rad = ext + R.r;
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        // silhouette: a few octaves of smooth periodic noise (periodic in a, so the ring closes)
        const n = 0.5 + 0.30 * Math.sin(a * R.f + phase[0]) + 0.16 * Math.sin(a * R.f * 2.7 + phase[1]) + 0.08 * Math.sin(a * R.f * 6.1 + phase[2]);
        const h = (R.h[0] + (R.h[1] - R.h[0]) * Math.max(0, n)) * hills;
        const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad, y0 = minY - 40;
        pos.push(x, y0, z, x, y0 + h + 30, z);
        col.push(1, 1, 1, 0.82, 0.86, 0.9);                        // tops a bit darker / cooler than the hazy foot
        if (k < seg) { const b = k * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: true });
      m.userData.mix = R.mix;
      const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 10 + ri; mesh.frustumCulled = false;   // after the track (which hides most of them), before the sky
      this.mats.push(m); this.group.add(mesh);
    });
  }
  /** horizon: the sky's current horizon colour (weather included) */
  setColors(horizon) {
    for (const m of this.mats) m.color.copy(horizon).lerp(this.tint, m.userData.mix);
  }
  dispose() { this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
}
