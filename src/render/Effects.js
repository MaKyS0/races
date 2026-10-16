// Effects: pooled particle systems (smoke / dust / sparks / spray), skid marks (instanced ring buffer), flying debris,
// and GPU-animated rain. All buffers are preallocated; emission is budgeted so FPS does not depend on how wrecked the race is.
import * as THREE from 'three';
import { smokeTexture, skidTexture, sparkTexture } from './Textures.js';
import { makeRng } from '../core/math.js';

const VERT = `
attribute float aSize; attribute vec4 aColor; varying vec4 vColor; uniform float uScale; uniform vec2 uNear;
void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vColor = aColor; vColor.a *= smoothstep(uNear.x, uNear.y, -mv.z); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aSize * uScale / max(0.1,-mv.z), 0.0, 220.0); }`;
const FRAG = `
uniform sampler2D map; varying vec4 vColor;
void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vColor.rgb, vColor.a * t.a); if (gl_FragColor.a < 0.01) discard; }`;

class Pool {
  constructor(n, tex, { additive = false, gravity = 0, drag = 0 } = {}) {
    this.n = n; this.i = 0; this.gravity = gravity; this.drag = drag;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n);
    this.col = new Float32Array(n * 3); this.size = new Float32Array(n); this.rgba = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.rgba, 4).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { map: { value: tex }, uScale: { value: 600 }, uNear: { value: new THREE.Vector2(1.2, 6.0) } }, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false; this.points.renderOrder = 5;
    this.geo = g; this.alive = 0; this.scaleAlpha = 1;
  }
  emit(x, y, z, vx, vy, vz, s0, s1, life, r, g, b) {
    const i = this.i; this.i = (this.i + 1) % this.n;
    const p = i * 3;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z; this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz;
    this.life[i] = life; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.col[p] = r; this.col[p + 1] = g; this.col[p + 2] = b;
  }
  update(dt) {
    const n = this.n, drag = Math.exp(-this.drag * dt);
    let alive = 0;
    for (let i = 0; i < n; i++) {
      const l = this.life[i];
      const p = i * 3, q = i * 4;
      if (l <= 0) { this.size[i] = 0; this.rgba[q + 3] = 0; continue; }
      this.life[i] = l - dt; alive++;
      this.vel[p + 1] += this.gravity * dt;
      this.vel[p] *= drag; this.vel[p + 1] *= drag; this.vel[p + 2] *= drag;
      this.pos[p] += this.vel[p] * dt; this.pos[p + 1] += this.vel[p + 1] * dt; this.pos[p + 2] += this.vel[p + 2] * dt;
      const t = 1 - this.life[i] / this.max[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.rgba[q] = this.col[p]; this.rgba[q + 1] = this.col[p + 1]; this.rgba[q + 2] = this.col[p + 2];
      this.rgba[q + 3] = (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85) * this.scaleAlpha;
    }
    this.alive = alive;
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true; this.geo.attributes.aColor.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, quality) {
    this.scene = scene; this.group = new THREE.Group(); scene.add(this.group);
    this.setQuality(quality);
    this.rnd = makeRng(77);
    this.debris = [];
  }
  setQuality(q) {
    this.q = q;
    const k = q.particles;
    if (this.smoke) { this.group.remove(this.smoke.points, this.dust.points, this.spark.points, this.spray.points); }
    const tex = this.puffTex || (this.puffTex = smokeTexture()), stex = this.sparkTex || (this.sparkTex = sparkTexture());
    this.smoke = new Pool(Math.max(40, Math.round(500 * k)), tex, { gravity: 0.6, drag: 1.2 });
    this.dust = new Pool(Math.max(30, Math.round(300 * k)), tex, { gravity: -0.3, drag: 1.6 });
    this.spark = new Pool(Math.max(30, Math.round(300 * k)), stex, { additive: true, gravity: -9, drag: 0.4 });
    this.spray = new Pool(Math.max(30, Math.round(400 * k)), tex, { gravity: -3, drag: 1.4 });
    this.spray.scaleAlpha = 0.5; this.smoke.scaleAlpha = 0.8;
    this.spray.points.material.uniforms.uNear.value.set(3.5, 16);   // spray is a mist further away, never a white blob on the lens
    this.smoke.points.material.uniforms.uNear.value.set(2.0, 9.0);
    this.group.add(this.smoke.points, this.dust.points, this.spark.points, this.spray.points);
    // skid marks
    if (this.skidMesh) { this.group.remove(this.skidMesh); this.skidMesh.dispose(); }
    const n = q.skid;
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    this.skidMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: skidTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true }), n);
    this.skidMesh.frustumCulled = false; this.skidMesh.renderOrder = 2; this.skidMesh.count = 0;
    this.skidCap = n; this.skidHead = 0; this.skidCount = 0;
    this.group.add(this.skidMesh);
    this.skidLast = new Float32Array(100 * 4); // per tracked wheel last mark position
    this.dummy = new THREE.Object3D();
    // debris pool
    if (!this.debrisPool) {
      this.debrisPool = [];
      const wingGeo = new THREE.BoxGeometry(0.8, 0.05, 0.35), wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.4, 14);
      wheelGeo.rotateZ(Math.PI / 2);
      for (let i = 0; i < 28; i++) {
        const isWheel = i < 8;
        const m = new THREE.Mesh(isWheel ? wheelGeo : wingGeo, new THREE.MeshLambertMaterial({ color: isWheel ? 0x141416 : 0x25262b }));
        m.visible = false; m.castShadow = false;
        this.group.add(m);
        this.debrisPool.push({ mesh: m, active: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, t: 0, isWheel });
      }
    }
  }

  setScale(px) { for (const p of [this.smoke, this.dust, this.spark, this.spray]) p.points.material.uniforms.uScale.value = px; }

  addSkid(slot, x, y, z, vx, vz, intensity) {
    const o = slot * 4;
    const dx = x - this.skidLast[o], dz = z - this.skidLast[o + 1];
    const d = Math.hypot(dx, dz);
    if (d < 0.5 || d > 6) { this.skidLast[o] = x; this.skidLast[o + 1] = z; return; }
    const d0 = this.dummy;
    d0.position.set((x + this.skidLast[o]) / 2, y + 0.02, (z + this.skidLast[o + 1]) / 2);
    d0.rotation.set(0, Math.atan2(dx, dz), 0); d0.scale.set(0.32, 1, d * 1.15); d0.updateMatrix();
    this.skidMesh.setMatrixAt(this.skidHead, d0.matrix);
    this.skidHead = (this.skidHead + 1) % this.skidCap; if (this.skidCount < this.skidCap) this.skidCount++;
    this.skidMesh.count = this.skidCount; this.skidMesh.instanceMatrix.needsUpdate = true;
    this.skidLast[o] = x; this.skidLast[o + 1] = z;
  }

  burst(kind, x, y, z, n, speed, color) {
    const k = this.q.particles; n = Math.round(n * k);
    for (let i = 0; i < n; i++) {
      const a = this.rnd() * 6.283, e = this.rnd() * 0.9 + 0.1, s = speed * (0.3 + this.rnd());
      if (kind === 'spark') this.spark.emit(x, y, z, Math.cos(a) * s, e * s * 0.9, Math.sin(a) * s, 0.35, 0.05, 0.4 + this.rnd() * 0.5, 1, 0.65 + this.rnd() * 0.3, 0.2);
      else if (kind === 'dust') this.dust.emit(x, y, z, Math.cos(a) * s * 0.5, e * s * 0.4, Math.sin(a) * s * 0.5, 1.4, 5.5, 1.2 + this.rnd(), color[0], color[1], color[2]);
      else this.smoke.emit(x, y, z, Math.cos(a) * s * 0.4, e * s * 0.3, Math.sin(a) * s * 0.4, 1.2, 5, 1 + this.rnd(), 0.85, 0.85, 0.85);
    }
  }

  spawnDebris(wheel, x, y, z, vx, vz, rng = Math.random) {
    for (const d of this.debrisPool) {
      if (d.active || d.isWheel !== wheel) continue;
      d.active = true; d.t = 0; d.mesh.visible = true; d.mesh.scale.setScalar(1); d.gy = y;
      d.mesh.position.set(x, y + 0.4, z);
      d.vx = vx * 0.6 + (rng() - 0.5) * 8; d.vz = vz * 0.6 + (rng() - 0.5) * 8; d.vy = 3 + rng() * 6;
      d.wx = (rng() - 0.5) * 14; d.wy = (rng() - 0.5) * 14; d.wz = (rng() - 0.5) * 14;
      return;
    }
  }
  updateDebris(dt) {
    for (const d of this.debrisPool) {
      if (!d.active) continue;
      d.t += dt;
      d.vy -= 9.81 * dt;
      const m = d.mesh;
      m.position.x += d.vx * dt; m.position.y += d.vy * dt; m.position.z += d.vz * dt;
      m.rotation.x += d.wx * dt; m.rotation.y += d.wy * dt; m.rotation.z += d.wz * dt;
      const g = d.gy + (d.isWheel ? 0.33 : 0.05);
      if (m.position.y < g) {
        m.position.y = g; d.vy = -d.vy * 0.35; d.vx *= 0.82; d.vz *= 0.82; d.wx *= 0.7; d.wy *= 0.7; d.wz *= 0.7;
        if (Math.abs(d.vy) < 0.6) d.vy = 0;
      }
      if (d.t > 14) { m.scale.multiplyScalar(0.95); if (d.t > 17) { d.active = false; m.visible = false; } }
    }
  }
  update(dt) {
    this.smoke.update(dt); this.dust.update(dt); this.spark.update(dt); this.spray.update(dt);
  }
}

export class Rain {
  constructor(scene, count = 2500) {
    this.count = count;
    const pos = new Float32Array(count * 2 * 3), seed = new Float32Array(count * 2 * 3), end = new Float32Array(count * 2);
    const rnd = makeRng(3);
    for (let i = 0; i < count; i++) {
      const s = [rnd(), rnd(), rnd()];
      for (let k = 0; k < 2; k++) { const o = (i * 2 + k) * 3; seed[o] = s[0]; seed[o + 1] = s[1]; seed[o + 2] = s[2]; end[i * 2 + k] = k; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uAlpha: { value: 0 }, uVel: { value: new THREE.Vector3(0, 0, 0) }, uColor: { value: new THREE.Color(0xd2dce6) } },
      vertexShader: `attribute vec3 aSeed; attribute float aEnd; uniform vec3 uCam; uniform float uTime; uniform vec3 uVel; varying float vA;
        void main(){ vec3 box = vec3(36.0, 22.0, 36.0);
          float y = mod(aSeed.y * box.y - uTime * 22.0, box.y);
          vec3 p = vec3((aSeed.x - 0.5) * box.x, y - 4.0, (aSeed.z - 0.5) * box.z);
          p += uCam; p -= uVel * 0.02 * aEnd; p.y += aEnd * 0.8; p.x += aEnd * 0.05;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vA = (0.25 + 0.45 * aSeed.x) * mix(0.35, 1.0, aEnd) * smoothstep(0.8, 3.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uAlpha; uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * uAlpha); }`,
      transparent: true, depthWrite: false,
    });
    this.lines = new THREE.LineSegments(g, this.mat); this.lines.frustumCulled = false; this.lines.visible = false; this.lines.renderOrder = 6;
    scene.add(this.lines);
    this.geo = g;
  }
  update(t, camPos, intensity, carVel, qualityK = 1) {
    this.lines.visible = intensity > 0.02;
    this.mat.uniforms.uCam.value.copy(camPos); this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uAlpha.value = Math.min(1, intensity * 1.4);
    if (carVel) this.mat.uniforms.uVel.value.copy(carVel);
    this.geo.setDrawRange(0, Math.floor(this.count * 2 * Math.min(1, intensity * 1.2) * qualityK));
  }
}
