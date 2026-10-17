// DrivingLine: the optimal ("racing") line drawn on the track as chevrons that point the way, coloured LIVE from the car's own speed:
//   blue   - you can go flat out here
//   yellow - lift / ease off: the speed you carry needs some braking before this point
//   red    - brake now: the deceleration needed to get down to the corner speed is close to what the car can do
// The target speeds come from the same speed profile the AI uses (racing line + friction circle), so the line never asks for more than
// the car can do. Modes: 'full' (whole line ahead), 'braking' (only the yellow / red part, like a braking-assist), 'off'.
// Only a window ahead of the car is visible; only that part of the colour buffer is rewritten each frame.
import * as THREE from 'three';

const SEG = 2;            // one chevron every SEG samples of the track (track.ds = 2 m -> every 4 m)
const WINDOW = 105;       // chevrons drawn ahead of the car (~420 m)
const BLUE = [0.22, 0.62, 1.0], YELLOW = [1.0, 0.82, 0.18], RED = [1.0, 0.14, 0.08];

export class DrivingLine {
  constructor(track, profile) {
    this.track = track; this.profile = profile;
    const N = track.N, M = this.M = Math.floor(N / SEG);
    const pos = new Float32Array(M * 6 * 3), col = new Float32Array(M * 6 * 4), idx = [];
    for (let s = 0; s < M; s++) {
      const i = s * SEG, j = (i + 1) % N;
      const cx = track.lineX[i], cz = track.lineZ[i];
      let fx = track.lineX[j] - cx, fz = track.lineZ[j] - cz; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      const lx = fz, lz = -fx;                                   // left of the direction of travel
      const y = track.y[i] + 0.035 + Math.max(-0.045, Math.min(0.045, track.cross[i])) * track.line[i];
      const P = (f, l) => [cx + fx * f + lx * l, y, cz + fz * f + lz * l];
      // chevron: tip, front-left, back-left, notch, back-right, front-right
      const v = [P(1.25, 0), P(0.55, 0.6), P(-1.25, 0.6), P(-0.55, 0), P(-1.25, -0.6), P(0.55, -0.6)];
      for (let k = 0; k < 6; k++) pos.set(v[k], (s * 6 + k) * 3);
      const b = s * 6;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 3, b + 4, b, b + 4, b + 5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.colAttr = new THREE.BufferAttribute(col, 4); this.colAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', this.colAttr);
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, toneMapped: false });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = 3; this.mesh.frustumCulled = false; this.mesh.visible = false;
    this.prev = -1; this.t = 0;
  }
  /** write colour+alpha of chevron s */
  set(s, r, gg, b, a) {
    const c = this.colAttr.array; let o = s * 24;
    for (let k = 0; k < 6; k++) { c[o++] = r; c[o++] = gg; c[o++] = b; c[o++] = a; }
  }
  clearWindow(start) {
    if (start < 0) return;
    for (let k = -3; k <= WINDOW; k++) { const s = ((start + k) % this.M + this.M) % this.M; this.set(s, 0, 0, 0, 0); }
  }
  /** car: the focus Vehicle; mode: 'full' | 'braking' | 'off' */
  update(car, mode, dt) {
    if (!car || mode === 'off' || !car.loc) { if (this.mesh.visible) { this.clearWindow(this.prev); this.markAll(); this.prev = -1; } this.mesh.visible = false; return; }
    this.mesh.visible = true; this.t += dt;
    const M = this.M, V = this.profile.v, N = this.track.N, ds = this.track.ds;
    const start = Math.floor(car.loc.i / SEG);
    if (start !== this.prev) this.clearWindow(this.prev);
    const v = Math.max(0, car.speed), v2 = v * v;
    const aMax = 9.81 * 1.45 + 0.0042 * v2;                       // what the car can brake with at this speed (grip + downforce)
    const pulse = 0.82 + 0.18 * Math.sin(this.t * 9);
    let braking = false;
    for (let k = 1; k <= WINDOW; k++) {                          // starts just ahead of the car: the camera sits behind it
      const s = ((start + k) % M + M) % M;
      const d = Math.max(2, k * SEG * ds);
      const vt = V[(s * SEG) % N] * 0.97;
      const need = v > vt ? (v2 - vt * vt) / (2 * d) : -1;       // deceleration needed to reach the corner speed there
      let c, glow = 1;
      if (need > 0.68 * aMax) { c = RED; glow = 1.7 * pulse; braking = true; }
      else if (need > 0.22 * aMax) { const f = (need / aMax - 0.22) / 0.46; c = [YELLOW[0], YELLOW[1] * (1 - f * 0.55), YELLOW[2] * (1 - f)]; glow = 1.15; }
      else c = BLUE;
      let a = 0.66;
      if (k < 3) a *= 0.35 + 0.2 * k;                              // fades in just ahead of the car
      if (k > WINDOW * 0.7) a *= Math.max(0, (WINDOW - k) / (WINDOW * 0.3));
      if (mode === 'braking' && c === BLUE) a = 0;
      this.set(s, c[0] * glow, c[1] * glow, c[2] * glow, a);
    }
    this.braking = braking;
    // upload only the touched part of the buffer (the window may wrap around the start/finish line); a jump (reset, replay) uploads all
    const A = this.colAttr; A.clearUpdateRanges();
    const jump = this.prev < 0 ? 0 : Math.abs(start - this.prev);
    if (jump > 24 && jump < M - 24) A.addUpdateRange(0, M * 24);
    else {
      const lo = Math.min(start, this.prev < 0 ? start : (jump > M / 2 ? start : this.prev)) - 3, n = WINDOW + 6 + Math.min(jump, 24);
      const a0 = ((lo % M) + M) % M;
      if (a0 + n <= M) A.addUpdateRange(a0 * 24, n * 24);
      else { A.addUpdateRange(a0 * 24, (M - a0) * 24); A.addUpdateRange(0, (a0 + n - M) * 24); }
    }
    A.needsUpdate = true;
    this.prev = start;
  }
  markAll() { const A = this.colAttr; A.clearUpdateRanges(); A.addUpdateRange(0, this.M * 24); A.needsUpdate = true; }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
