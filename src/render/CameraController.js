// CameraController: chase, cockpit, T-cam, top, nose and TV (replay) cameras with smoothing, speed FOV and shake.
import * as THREE from 'three';
import { wrapPi } from '../core/math.js';

export const CAMERA_MODES = ['chase', 'cockpit', 'tcam', 'top', 'nose'];
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _v2 = new THREE.Vector3();

export class CameraController {
  constructor(camera) {
    this.cam = camera;
    this.mode = 'chase';
    this.yaw = 0; this.pos = new THREE.Vector3(); this.initialised = false;
    this.shake = 0; this.shakeT = 0;
    this.fov = 62; this.lookBack = false;
    this.tv = { s: -1, pos: new THREE.Vector3(), mode: 0, until: 0 };
    this.blend = 1;
    this.lastMode = 'chase';
  }
  setMode(m) { if (m !== this.mode) { this.mode = m; this.blend = 0; } }
  cycle() { const i = CAMERA_MODES.indexOf(this.mode); this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]); return this.mode; }
  addShake(a) { this.shake = Math.min(1.2, this.shake + a); }

  /** car: Vehicle; vis: CarVisual (already updated this frame). tv: use TV camera. */
  update(dt, car, vis, track, opts = {}) {
    const cam = this.cam;
    const speed = car.speed;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.shakeT += dt;
    const kerb = Math.min(1, car.kerbShake * 40);
    const sh = (this.shake * 0.18 + kerb * 0.02 + Math.min(0.012, speed * 0.00004)) * (this.mode === 'cockpit' ? 0.6 : 1);
    if (opts.tv) { this.updateTV(dt, car, track, sh); return; }
    vis.helmetMesh.visible = this.mode !== 'cockpit';
    const target = this.target = this.target || { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    let fovT = 62;
    if (this.mode === 'chase') {
      const course = speed > 8 ? Math.atan2(car.vx, car.vz) : car.psi;
      const want = car.psi + wrapPi(course - car.psi) * 0.35 + (this.lookBack ? Math.PI : 0);
      if (!this.initialised) { this.yaw = want; this.initialised = true; }
      this.yaw += wrapPi(want - this.yaw) * (1 - Math.exp(-5.5 * dt));
      const dist = 7.4 + speed * 0.012, h = 2.35 + speed * 0.004;
      const px = car.x - Math.sin(this.yaw) * dist, pz = car.z - Math.cos(this.yaw) * dist;
      const py = car.y + h;
      target.pos.set(px, py, pz);
      cam.position.lerp(target.pos, this.blend < 1 ? 1 - Math.exp(-3 * dt) : 1 - Math.exp(-14 * dt));
      cam.position.y = Math.max(cam.position.y, car.y + 1.1);
      // a little roll into the corner with the cornering load (smoothed, at most ~1.7 degrees)
      const yawRate = this.prevPsi === undefined || dt <= 0 ? 0 : wrapPi(car.psi - this.prevPsi) / dt; this.prevPsi = car.psi;
      const rollT = Math.max(-0.03, Math.min(0.03, -yawRate * speed * 0.0016));
      this.roll = (this.roll || 0) + (rollT - (this.roll || 0)) * (1 - Math.exp(-3 * dt));
      cam.up.set(Math.cos(this.yaw) * Math.sin(this.roll), Math.cos(this.roll), -Math.sin(this.yaw) * Math.sin(this.roll));
      cam.lookAt(car.x + Math.sin(this.yaw) * 9, car.y + 0.9, car.z + Math.cos(this.yaw) * 9);
      fovT = 58 + Math.min(24, speed * 0.1);
    } else if (this.mode === 'top') {
      const yaw = car.psi;
      target.pos.set(car.x - Math.sin(yaw) * 5, car.y + 30, car.z - Math.cos(yaw) * 5);
      cam.position.lerp(target.pos, 1 - Math.exp(-6 * dt));
      cam.up.set(Math.sin(yaw), 0, Math.cos(yaw));
      cam.lookAt(car.x + Math.sin(yaw) * 4, car.y, car.z + Math.cos(yaw) * 4);
      fovT = 55;
    } else {
      const a = vis.anchors[this.mode === 'cockpit' ? 'cockpit' : this.mode === 'tcam' ? 'tcam' : 'nose'];
      a.getWorldPosition(_v); a.getWorldQuaternion(_q);
      cam.position.copy(_v);
      // look along the car (with a touch of look-ahead into the corner)
      _v2.set(0, 0, 1).applyQuaternion(_q);
      cam.up.set(0, 1, 0).applyQuaternion(_q.setFromAxisAngle(_v2, 0));
      cam.lookAt(_v.x + _v2.x * 20 - Math.cos(car.psi) * car.steer * 6 * 0, _v.y + _v2.y * 20 - 0.5, _v.z + _v2.z * 20);
      if (this.lookBack) { cam.lookAt(_v.x - _v2.x * 20, _v.y, _v.z - _v2.z * 20); }
      fovT = this.mode === 'cockpit' ? 82 : this.mode === 'tcam' ? 78 : 88;
    }
    this.blend = Math.min(1, this.blend + dt * 2.5);
    if (sh > 0.0005) {
      cam.position.x += (Math.sin(this.shakeT * 53) + Math.sin(this.shakeT * 91 + 1.7)) * sh * 0.5;
      cam.position.y += (Math.sin(this.shakeT * 67 + 0.3) + Math.sin(this.shakeT * 113)) * sh * 0.5;
    }
    this.fov += (fovT - this.fov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(cam.fov - this.fov) > 0.05) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  updateTV(dt, car, track, sh) {
    const cam = this.cam;
    const tv = this.tv;
    const L = track.length;
    // choose a trackside post every ~260 m ahead of the car; switch when the car has passed it
    const post = (s) => Math.round(s / 260) * 260;
    const ahead = track.delta(car.loc.s, tv.s);
    if (tv.s < 0 || ahead < -60 || ahead > 420) {
      let s = post(car.loc.s + 200);
      tv.s = (s % L + L) % L;
      const i = Math.round(tv.s / track.ds) % track.N;
      const side = tv.mode++ % 2 ? 1 : -1;
      const n = side * (side > 0 ? track.wallL[i] : track.wallR[i]) - side * 2.2;
      const p = track.pointAt(tv.s, n, { x: 0, y: 0, z: 0, psi: 0 });
      tv.pos.set(p.x, p.y + 2.2 + (tv.mode % 3) * 1.6, p.z);
      this.tvInit = false;
    }
    cam.position.lerp(tv.pos, this.tvInit ? 1 : 1 - Math.exp(-3 * dt)); this.tvInit = true;
    cam.up.set(0, 1, 0);
    cam.lookAt(car.x, car.y + 0.7, car.z);
    const d = Math.hypot(car.x - cam.position.x, car.z - cam.position.z);
    const fovT = Math.max(9, Math.min(60, 2 * Math.atan(5.5 / Math.max(10, d)) * 57.3));
    this.fov += (fovT - this.fov) * (1 - Math.exp(-5 * dt));
    cam.fov = this.fov; cam.updateProjectionMatrix();
    if (sh > 0.001) cam.position.y += Math.sin(this.shakeT * 70) * sh * 0.2;
  }
}
