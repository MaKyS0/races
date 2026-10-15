// Renderer3D: owns the WebGL renderer, scene, lights, quality profile application, per-frame sync of all car visuals,
// effects emission, weather visuals and the menu "showroom". Gameplay code never touches three.js directly.
import * as THREE from 'three';
import { QUALITY } from '../core/Perf.js';
import { groundTexture, kerbTexture, barrierTexture, blobTexture } from './Textures.js';
import { TrackMesh } from './TrackMesh.js';
import { Decor } from './Decor.js';
import { CarVisual } from './CarModel.js';
import { Effects, Rain } from './Effects.js';
import { Sky } from './Sky.js';
import { WX, WY } from '../physics/VehiclePhysics.js';
import { TEAMS } from '../race/Roster.js';
import { SURF } from '../track/TrackSystem.js';

const _v = new THREE.Vector3();

export class Renderer3D {
  constructor(canvas, settings, perf) {
    this.canvas = canvas; this.settings = settings; this.perf = perf;
    this.qname = perf.qualityName(); this.q = QUALITY[this.qname];
    const gl = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.q.antialias, powerPreference: 'high-performance', alpha: false, stencil: false, preserveDrawingBuffer: !!settings.data.preserveBuffer });
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.12;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.12, 7000);
    this.sky = new Sky(this.qname); this.skyLow = this.qname === 'low'; this.scene.add(this.sky.mesh);
    this.scene.fog = new THREE.Fog(0xb4cfee, 300, 1500);
    this.hemi = new THREE.HemisphereLight(0xd6e6ff, 0x6b7a4a, 1.05); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffeccc, 2.6);
    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.35).normalize();
    this.scene.add(this.sun, this.sun.target);
    this.raceGroup = new THREE.Group(); this.scene.add(this.raceGroup);
    this.trackMesh = null; this.decor = null; this.visuals = []; this.scVisual = null; this.ghostVisual = null;
    this.effects = new Effects(this.scene, this.q);
    this.rain = new Rain(this.scene, Math.round(2800 * this.q.particles));
    this.focus = null;
    this.accum = new Float32Array(100 * 4);
    this.time = 0;
    this.showroom = null;
    this.setupShadows();
    this.setupEnv();
    this.blobs = null;
    this.applyScale();
    this.lastWet = -1; this.lastCloud = -1;
    this.pendingEvents = [];
    perf.on(() => this.onPerfChange());
  }

  // ---------------------------------------------------------------- quality / sizing
  setupShadows() {
    const q = this.q;
    const gl = this.renderer;
    gl.shadowMap.enabled = q.shadows > 0;
    gl.shadowMap.type = q.shadows > 1 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = q.shadows > 0;
    if (q.shadows > 0) {
      const s = this.sun.shadow; s.mapSize.set(q.shadowSize, q.shadowSize);
      const r = q.shadows > 1 ? 70 : 48;
      Object.assign(s.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 260 }); s.camera.updateProjectionMatrix();
      s.bias = -0.0004; s.normalBias = 0.06;
      if (s.map) { s.map.dispose(); s.map = null; }
    }
  }
  setupEnv() {
    if (!this.q.env || this.envBroken) { this.scene.environment = null; return; }
    try {
      const pm = new THREE.PMREMGenerator(this.renderer);
      const es = new THREE.Scene();
      const sk = new Sky(); sk.setWeather(this.lastCloud < 0 ? 0.1 : this.lastCloud, 0); es.add(sk.mesh);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a4d52 })); floor.position.y = -2; es.add(floor);
      if (this.envTex) this.envTex.dispose();
      this.envTex = pm.fromScene(es, 0.02).texture;
      pm.dispose();
      this.scene.environment = this.envTex; this.scene.environmentIntensity = 0.55;
      if (!this.probeEnv()) { this.envBroken = true; this.scene.environment = null; }
    } catch (e) { this.scene.environment = null; this.envBroken = true; }
  }
  /** Some GPUs/drivers (and software GL) produce a black/NaN IBL texture. Render a probe sphere and read it back; if it
   *  comes out black we simply run without image based lighting (direct lights only). */
  probeEnv() {
    try {
      const rt = new THREE.WebGLRenderTarget(8, 8);
      const sc = new THREE.Scene(); sc.environment = this.envTex; sc.environmentIntensity = 1;
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.4 }));
      sc.add(m);
      const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 10); cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0);
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(rt); this.renderer.render(sc, cam);
      const px = new Uint8Array(8 * 8 * 4); this.renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, px);
      this.renderer.setRenderTarget(prev); rt.dispose(); m.geometry.dispose(); m.material.dispose();
      let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      return sum > 30;
    } catch (e) { return false; }
  }
  applyScale() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const pr = Math.max(0.5, Math.min(dpr, this.q.pixelRatio) * this.perf.scale);
    this.renderer.setPixelRatio(pr);
    this.resize();
    if (this.effects) this.effects.setScale(0.55 * (this.canvas.height || 720));
  }
  resize() {
    const c = this.canvas;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h); this.camera.updateProjectionMatrix();
    this.width = w; this.height = h;
  }
  onPerfChange() {
    const name = this.perf.qualityName();
    if (name !== this.qname) {
      this.qname = name; this.q = QUALITY[name];
      this.setupShadows();
      this.effects.setQuality(this.q);
      if ((name === 'low') !== this.skyLow) { const w = this.sky.uniforms; this.scene.remove(this.sky.mesh); this.sky.mesh.material.dispose(); this.sky = new Sky(name); this.skyLow = name === 'low'; this.scene.add(this.sky.mesh); this.sky.setWeather(this.lastCloud < 0 ? 0.1 : this.lastCloud, 0); }
      this.scene.fog.far = this.q.drawDistance * 1.05; this.scene.fog.near = this.q.drawDistance * 0.3;
    }
    this.applyScale();
  }

  // ---------------------------------------------------------------- scene content
  setTrack(track, profile) {
    this.clearRace();
    const q = this.q, cheap = this.qname === 'low';
    const aniso = Math.min(q.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    const gt = groundTexture(Math.round(512 * q.texScale) || 256, aniso);
    gt.repeat.set(0.5, 0.5);
    const Std = cheap ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
    const mats = {
      ground: new Std({ map: gt, vertexColors: true, ...(cheap ? {} : { roughness: 0.95, metalness: 0.0 }) }),
      kerb: new Std({ map: kerbTexture(aniso), side: THREE.DoubleSide, ...(cheap ? {} : { roughness: 0.8 }) }),
      wall: new THREE.MeshLambertMaterial({ map: barrierTexture('tyre', aniso), side: THREE.DoubleSide }),
      wall2: new THREE.MeshLambertMaterial({ map: barrierTexture('concrete', aniso), side: THREE.DoubleSide }),
      far: new THREE.MeshLambertMaterial({ color: track.def.theme?.grass ?? 0x3f7a35 }),
    };
    gt.wrapS = gt.wrapT = THREE.RepeatWrapping;
    this.track = track; this.mats = mats;
    this.trackMesh = new TrackMesh(track, mats, { rowsPerChunk: q.drawDistance < 900 ? 150 : 110 });
    this.trackMesh.buildLine(profile);
    this.raceGroup.add(this.trackMesh.group);
    this.decor = new Decor(track, q, mats);
    this.raceGroup.add(this.decor.group);
    const th = track.def.theme || {};
    this.sky.setWeather(0.1, 0);
    this.scene.fog.color.copy(this.sky.fogColor);
    this.scene.fog.far = q.drawDistance * 1.05; this.scene.fog.near = q.drawDistance * 0.3;
    this.hemi.groundColor.set(th.grass ?? 0x59693f);
    this.lastWet = -1;
  }
  clearRace() {
    for (const v of this.visuals) this.raceGroup.remove(v.root);
    this.visuals = [];
    if (this.trackMesh) { this.raceGroup.remove(this.trackMesh.group); this.trackMesh.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.trackMesh = null; }
    if (this.decor) { this.raceGroup.remove(this.decor.group); this.decor.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.decor = null; }
    if (this.blobs) { this.raceGroup.remove(this.blobs); this.blobs = null; }
    if (this.scVisual) { this.raceGroup.remove(this.scVisual.root); this.scVisual = null; }
    if (this.ghostVisual) { this.raceGroup.remove(this.ghostVisual.root); this.ghostVisual = null; }
  }
  setCars(rm) {
    for (const v of this.visuals) this.raceGroup.remove(v.root);
    this.visuals = rm.cars.map((car) => {
      const v = new CarVisual(car.d.def.team, this.qname === 'low' ? 'low' : 'std', { lod: 1 });
      this.raceGroup.add(v.root); return v;
    });
    // contact shadows
    const geo = new THREE.PlaneGeometry(2.8, 6.4); geo.rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), rm.cars.length + 2);
    this.blobs.frustumCulled = false; this.blobs.renderOrder = 1;
    this.raceGroup.add(this.blobs);
    if (rm.cfg.mode === 'timetrial') {
      this.ghostVisual = new CarVisual(7, 'low', { ghost: true, lod: 1 }); this.ghostVisual.root.visible = false; this.raceGroup.add(this.ghostVisual.root);
    }
    this.focus = rm.player ? rm.player.car : rm.cars[0];
  }
  ensureSC() {
    if (!this.scVisual) { this.scVisual = new CarVisual(3, 'low', { lod: 1 }); this.raceGroup.add(this.scVisual.root); }
    return this.scVisual;
  }

  // ---------------------------------------------------------------- weather
  setWeather(w, dt) {
    const wet = w.water, cloud = w.cloud;
    if (Math.abs(wet - this.lastWet) > 0.015 && this.trackMesh) { this.trackMesh.setWet(wet); this.lastWet = wet; }
    const flash = w.lightning || 0;
    this.sky.setWeather(cloud, w.rain, flash);
    this.scene.fog.color.copy(this.sky.fogColor);
    const sunI = (0.35 + 1.9 * (1 - cloud * 0.88)) * (1 + flash);
    this.sun.intensity = sunI;
    this.hemi.intensity = 0.55 + 0.45 * (1 - cloud * 0.7) + flash * 0.8;
    const fogK = 1 - w.rain * 0.55;
    this.scene.fog.far = this.q.drawDistance * 1.05 * fogK; this.scene.fog.near = this.q.drawDistance * 0.3 * fogK;
    if (this.q.env && Math.abs(cloud - this.lastCloud) > 0.3) { this.lastCloud = cloud; this.setupEnv(); }
    this.scene.environmentIntensity = 0.35 + 0.5 * wet;
    this.renderer.toneMappingExposure = 1.0 - 0.12 * cloud;
  }

  // ---------------------------------------------------------------- per-frame sync
  sync(rm, alpha, dt, camController) {
    this.time += dt;
    const cam = this.camera.position;
    const track = rm.track;
    const q = this.q;
    const L0 = q.carLod === 2 ? [60, 190] : q.carLod === 1 ? [38, 120] : [20, 70];
    const cars = rm.cars;
    const d = new THREE.Object3D();
    let bi = 0;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i], v = this.visuals[i];
      if (!v) continue;
      if (car.removed) { v.root.visible = false; continue; }
      const dx = car.x - cam.x, dz = car.z - cam.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const vis = dist < q.drawDistance * 1.05;
      v.root.visible = vis;
      if (!vis) continue;
      const isFocus = car === this.focus;
      v.setLod(isFocus || dist < L0[0] ? 0 : dist < L0[1] ? 1 : 2);
      v.update(car, alpha, track, 3.5);
      // contact shadow
      const pv = car.prev;
      d.position.set(pv[0] + (car.x - pv[0]) * alpha, pv[2] + (car.y - pv[2]) * alpha + 0.03, pv[1] + (car.z - pv[1]) * alpha);
      d.rotation.set(0, car.psi, 0); d.updateMatrix(); this.blobs.setMatrixAt(bi++, d.matrix);
    }
    this.blobs.count = bi; this.blobs.instanceMatrix.needsUpdate = true;
    // safety car
    if (rm.sc) {
      const sc = this.ensureSC(); sc.root.visible = true;
      const p = track.pointAt(rm.sc.s, rm.sc.n, { x: 0, y: 0, z: 0, psi: 0 });
      sc.setPose(p.x, p.y, p.z, p.psi); sc.setLod(1);
    } else if (this.scVisual) this.scVisual.root.visible = false;
    // sun shadows follow the focus car
    if (this.focus) {
      const f = this.focus;
      this.sun.position.set(f.x + this.sunDir.x * 90, f.y + this.sunDir.y * 90, f.z + this.sunDir.z * 90);
      this.sun.target.position.set(f.x, f.y, f.z);
      this.sun.target.updateMatrixWorld();
    }
    // world culling / chunks
    this.trackMesh.update(cam.x, cam.z, q.drawDistance);
    this.decor.update(cam.x, cam.z, q);
    this.sky.follow(this.camera, dt);
    this.emitEffects(rm, dt, alpha);
    this.effects.update(dt);
    this.effects.updateDebris(dt);
    const f = this.focus;
    this.rain.update(this.time, this.camera.position, rm.weather.rain, f ? _v.set(f.vx, 0, f.vz) : null, Math.min(1, q.particles + 0.2));
    if (this.trackMesh.line) this.trackMesh.line.visible = !!this.settings.data.assists.racingLine;
    if (this.decor) this.decor.setLights(rm.phase === 'lights' ? rm.lights : 0);
  }

  emitEffects(rm, dt, alpha) {
    const fx = this.effects, cam = this.camera.position, water = rm.env.water;
    const k = this.q.particles;
    const acc = this.accum;
    for (let i = 0; i < rm.cars.length; i++) {
      const car = rm.cars[i];
      if (car.removed) continue;
      const dx = car.x - cam.x, dz = car.z - cam.z;
      const dist2 = dx * dx + dz * dz;
      if (dist2 > 240 * 240) continue;
      const near = dist2 < 90 * 90;
      const sn = Math.sin(car.psi), cs = Math.cos(car.psi);
      for (let w = 0; w < 4; w++) {
        const bx = WX[w], by = WY[w];
        const wx = car.x + sn * bx + cs * by, wz = car.z + cs * bx - sn * by, wy = car.y + 0.08;
        const surf = car.surf[w];
        const grass = surf === SURF.GRASS, gravel = surf === SURF.GRAVEL || surf === SURF.SAND;
        const sk = car.skid[w];
        const slot = i * 4 + w, o = slot * 4;
        // tyre smoke (and rubber marks on tarmac)
        if (sk > 0.12 && !grass && !gravel && car.speed > 4) {
          acc[o] += dt * 38 * Math.min(1.6, sk) * k * (near ? 1 : 0.5);
          while (acc[o] >= 1) { acc[o] -= 1; fx.smoke.emit(wx, wy, wz, (Math.random() - 0.5) * 1.2 - car.vx * 0.04, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2 - car.vz * 0.04, 0.9, 4.2, 1.1 + Math.random() * 0.8, 0.9, 0.9, 0.92); }
          if (near && water < 0.2 && sk > 0.3) fx.addSkid(slot, wx, wy, wz, car.vx, car.vz, sk);
        }
        // dust / gravel
        if ((grass || gravel) && car.speed > 5) {
          acc[o + 1] += dt * Math.min(60, car.speed * (gravel ? 1.6 : 1.0)) * k * (near ? 1 : 0.4);
          const c = gravel ? [0.72, 0.64, 0.47] : [0.36, 0.46, 0.22];
          while (acc[o + 1] >= 1) { acc[o + 1] -= 1; fx.dust.emit(wx, wy, wz, (Math.random() - 0.5) * 3, 1 + Math.random() * 2.2, (Math.random() - 0.5) * 3, 1.0, 4.5, 0.9 + Math.random() * 0.8, c[0], c[1], c[2]); }
        }
        // spray in the wet from the rear wheels
        if (water > 0.12 && car.speed > 22 && w >= 2 && car.fz[w] > 300) {
          acc[o + 2] += dt * Math.min(80, car.speed * water * 1.4) * k * (near ? 1 : 0.35);
          while (acc[o + 2] >= 1) { acc[o + 2] -= 1; fx.spray.emit(wx, wy, wz, (Math.random() - 0.5) * 2 - car.vx * 0.12, 1.2 + Math.random() * 2.2, (Math.random() - 0.5) * 2 - car.vz * 0.12, 1.3, 4.6, 0.8 + Math.random() * 0.7, 0.82, 0.86, 0.9); }
        }
        // a wheel-less corner throws sparks
        if (car.damage.wheelOff[w] && car.speed > 8) {
          acc[o + 3] += dt * 70 * k;
          while (acc[o + 3] >= 1) { acc[o + 3] -= 1; fx.spark.emit(wx, wy, wz, (Math.random() - 0.5) * 5 - car.vx * 0.2, 0.5 + Math.random() * 3, (Math.random() - 0.5) * 5 - car.vz * 0.2, 0.3, 0.04, 0.35 + Math.random() * 0.4, 1, 0.7, 0.25); }
        }
      }
      // floor scraping sparks (plank)
      if (car.sparks > 0.15 && near) {
        const n = Math.round(car.sparks * 4 * k);
        for (let s = 0; s < n; s++) fx.spark.emit(car.x - sn * 1.6 + cs * (Math.random() - 0.5) * 0.7, car.y + 0.05, car.z - cs * 1.6 - sn * (Math.random() - 0.5) * 0.7, -car.vx * 0.1 + (Math.random() - 0.5) * 3, 0.5 + Math.random() * 2, -car.vz * 0.1 + (Math.random() - 0.5) * 3, 0.28, 0.04, 0.3 + Math.random() * 0.4, 1, 0.75, 0.3);
      }
    }
  }

  /** impact / part-lost events coming from the simulation */
  onEvent(e, rm) {
    const fx = this.effects;
    if (e.type === 'impact') {
      const y = (e.a ? e.a.y : 0) + 0.3;
      fx.burst('spark', e.x, y, e.z, Math.min(60, 8 + e.speed * 2.5), 8, null);
      if (e.speed > 4) fx.burst('dust', e.x, y, e.z, Math.min(30, 4 + e.speed), 3, [0.7, 0.7, 0.7]);
      if (e.energy > 20000) fx.burst('smoke', e.x, y, e.z, 12, 3, null);
    } else if (e.type === 'partLost') {
      const c = e.car;
      const wheel = /wheel/i.test(e.part);
      fx.spawnDebris(wheel, c.x, c.y, c.z, c.vx, c.vz);
      if (!wheel) { fx.spawnDebris(false, c.x, c.y, c.z, c.vx, c.vz); }
    }
  }

  // ---------------------------------------------------------------- menu showroom
  enterShowroom(teamIdx) {
    this.exitShowroom();
    this.raceGroup.visible = false; this.effects.group.visible = false; this.rain.lines.visible = false;
    const root = new THREE.Group();
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.25, 48), new THREE.MeshStandardMaterial({ color: 0x1b1d22, metalness: 0.6, roughness: 0.35 }));
    plat.position.y = -0.13; root.add(plat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.06, 8, 64), new THREE.MeshBasicMaterial({ color: 0xff2a2a })); ring.rotation.x = Math.PI / 2; ring.position.y = 0.0; root.add(ring);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshStandardMaterial({ color: 0x1d2027, roughness: 0.85 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.3; root.add(floor);
    const rim1 = new THREE.PointLight(0xff3b30, 40, 14), rim2 = new THREE.PointLight(0x3b8bff, 34, 14);
    rim1.position.set(-5, 2.5, -3); rim2.position.set(5, 2, -4); root.add(rim1, rim2);
    const car = new CarVisual(teamIdx, this.qname === 'low' ? 'low' : 'std', { lod: 0 });
    car.root.position.set(0, 0.0, 0); root.add(car.root);
    car.body.updateMatrixWorld(true);
    // static wheel colours for the preview
    this.scene.add(root);
    this.showroom = { root, car, t: 0, team: teamIdx };
    this.scene.fog.color.set(0x0b0c10); this.scene.fog.near = 40; this.scene.fog.far = 200;
    this.sky.uniforms.top.value.set(0x0d0f14); this.sky.uniforms.horizon.value.set(0x1a1d26); this.sky.uniforms.sunPow.value = 0;
    this.sun.intensity = 2.0; this.hemi.intensity = 0.6;
    this.sun.position.set(6, 10, 4); this.sun.target.position.set(0, 0, 0);
  }
  setShowroomTeam(idx) { if (this.showroom && this.showroom.team !== idx) { const s = this.showroom; s.root.remove(s.car.root); s.car = new CarVisual(idx, this.qname === 'low' ? 'low' : 'std', { lod: 0 }); s.root.add(s.car.root); s.team = idx; } }
  updateShowroom(dt) {
    const s = this.showroom; if (!s) return;
    s.t += dt;
    const a = s.t * 0.35;
    this.camera.position.set(Math.sin(a) * 8.4, 2.4 + Math.sin(s.t * 0.5) * 0.4, Math.cos(a) * 8.4);
    this.camera.up.set(0, 1, 0); this.camera.lookAt(0, 0.6, 0);
    if (this.camera.fov !== 38) { this.camera.fov = 38; this.camera.updateProjectionMatrix(); }
    // wheels slowly turning for show
    for (const w of s.car.wheels) w.spin.rotation.x += dt * 1.2;
    s.car.rwFlap.rotation.x = 0.25 + Math.sin(s.t * 1.3) * 0.25;
  }
  exitShowroom() {
    if (!this.showroom) return;
    this.scene.remove(this.showroom.root); this.showroom = null;
    this.raceGroup.visible = true; this.effects.group.visible = true;
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
