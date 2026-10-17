// Renderer3D: owns the WebGL renderer, scene, lights, quality profile application, per-frame sync of all car visuals,
// effects emission, weather visuals and the menu "showroom". Gameplay code never touches three.js directly.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { QUALITY } from '../core/Perf.js';
import { groundTexture, kerbTexture, barrierTexture, blobTexture, fenceTexture } from './Textures.js';
import { TrackMesh } from './TrackMesh.js';
import { Decor } from './Decor.js';
import { CarVisual } from './CarModel.js';
import { Effects, Rain } from './Effects.js';
import { Sky } from './Sky.js';
import { atmosphereFor } from './Atmosphere.js';
import { WX, WY } from '../physics/VehiclePhysics.js';
import { TEAMS } from '../race/Roster.js';
import { SURF } from '../track/TrackSystem.js';
import { PostFX } from './PostFX.js';
import { DrivingLine } from './DrivingLine.js';
import { Horizon } from './Horizon.js';

const _v = new THREE.Vector3();

export class Renderer3D {
  constructor(canvas, settings, perf) {
    this.canvas = canvas; this.settings = settings; this.perf = perf;
    this.qname = perf.qualityName(); this.q = QUALITY[this.qname];
    // MSAA on the canvas only when the post pipeline will not draw the frame: its HDR target is multisampled already (see PostFX 'clean')
    this.canvasAA = this.q.antialias && settings.data.fx === false;
    const gl = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.canvasAA, powerPreference: 'high-performance', alpha: false, stencil: false, preserveDrawingBuffer: !!settings.data.preserveBuffer });
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.12;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.12, 7000);
    this.atmo = atmosphereFor({});
    this.post = new PostFX(gl, this.scene, this.camera); this.sunCol = new THREE.Color(); this.fxRain = 0; this.fxCloud = 0; this.camMode = 'chase';
    this.sky = new Sky(this.qname); this.skyLow = this.qname === 'low'; this.sky.setPalette(this.atmo); this.scene.add(this.sky.mesh);
    this.scene.fog = new THREE.Fog(0xb4cfee, 300, 1500);
    this.hemi = new THREE.HemisphereLight(0xd6e6ff, 0x6b7a4a, 1.05); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffeccc, 2.6);
    this.sunDir = this.atmo.sunDir.clone();
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
    // the governor reacts after a frame has been drawn; resizing the canvas right then would present a cleared (blank) frame,
    // so quality / resolution changes are applied at the start of the next render instead
    perf.on(() => { this.perfDirty = true; });
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
      const sk = new Sky(); sk.setPalette(this.atmo); sk.setWeather(this.lastCloud < 0 ? 0.1 : this.lastCloud, 0); es.add(sk.mesh);
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
    this.post.setSize(this.width, this.height, pr);
    const look = this.qname === 'high' ? 2 : this.qname === 'medium' ? 1 : 0;
    this.post.setLevel(this.settings.data.fx === false || look === 0 ? (this.q.antialias && !this.canvasAA ? 0.5 : 0) : look);
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
      if ((name === 'low') !== this.skyLow) { const w = this.sky.uniforms; this.scene.remove(this.sky.mesh); this.sky.mesh.material.dispose(); this.sky = new Sky(name); this.skyLow = name === 'low'; this.sky.setPalette(this.atmo); this.scene.add(this.sky.mesh); this.sky.setWeather(this.lastCloud < 0 ? 0.1 : this.lastCloud, 0); }
      this.scene.fog.far = this.q.drawDistance * 1.05; this.scene.fog.near = this.q.drawDistance * 0.3;
    }
    this.applyScale();
  }

  // ---------------------------------------------------------------- scene content
  setTrack(track, profile) {
    this.clearRace();
    const q = this.q, cheap = this.qname === 'low';
    const aniso = Math.min(q.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    const th0 = track.def.theme || {};
    const gt = groundTexture(Math.round(512 * q.texScale) || 256, aniso);
    gt.repeat.set(0.5, 0.5);
    const Std = cheap ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
    const mats = {
      ground: new Std({ map: gt, vertexColors: true, ...(cheap ? {} : { roughness: 0.95, metalness: 0.0 }) }),
      kerb: new Std({ map: kerbTexture(aniso, th0.kerb ?? 0xd8161e), side: THREE.DoubleSide, ...(cheap ? {} : { roughness: 0.8 }) }),
      wall: new THREE.MeshLambertMaterial({ map: barrierTexture('tyre', aniso), side: THREE.DoubleSide }),
      wall2: new THREE.MeshLambertMaterial({ map: barrierTexture('concrete', aniso), side: THREE.DoubleSide }),
      far: new THREE.MeshLambertMaterial({ color: th0.grass ?? 0x3f7a35 }),
      fence: cheap ? null : new THREE.MeshLambertMaterial({ map: fenceTexture(aniso), side: THREE.DoubleSide, alphaTest: 0.5, transparent: false }),
    };
    if (!cheap) this.wetShader(mats);
    gt.wrapS = gt.wrapT = THREE.RepeatWrapping;
    this.track = track; this.mats = mats;
    this.trackMesh = new TrackMesh(track, mats, { rowsPerChunk: q.drawDistance < 900 ? 150 : 110 });
    this.trackMesh.buildLine(profile);
    this.raceGroup.add(this.trackMesh.group);
    this.dline = new DrivingLine(track, profile); this.raceGroup.add(this.dline.mesh);
    this.horizon = new Horizon(track); this.raceGroup.add(this.horizon.group);
    this.decor = new Decor(track, q, mats);
    this.raceGroup.add(this.decor.group);
    const th = track.def.theme || {};
    // time of day: one preset drives sun, fill, sky, fog and exposure
    const A = this.atmo = atmosphereFor(th);
    this.sunDir.copy(A.sunDir); this.sun.color.set(A.sunColor); this.hemi.color.set(A.hemiSky);
    this.sky.setPalette(A);
    if (this.q.env) { this.lastCloud = -1; this.setupEnv(); }
    this.sky.setWeather(0.1, 0);
    this.scene.fog.color.copy(this.sky.fogColor);
    if (this.horizon) this.horizon.setColors(this.sky.uniforms.horizon.value);
    this.scene.fog.far = q.drawDistance * 1.05; this.scene.fog.near = q.drawDistance * 0.3;
    this.hemi.groundColor.set(th.grass ?? 0x59693f).lerp(new THREE.Color(0x6a6a66), 0.6);   // bounce light: mostly neutral so undersides do not turn green
    this.lastWet = -1;
  }
  /** Medium/High ground: per-pixel wet look on grey surfaces (asphalt, run-off, pit lane) - darker, glossy, low-frequency
   *  puddles that stay where the noise says, and a fresnel sky sheen that works without image based lighting. */
  wetShader(mats) {
    const U = mats.wetU = { uWet: { value: 0 }, uSkyRefl: { value: new THREE.Color(0x9ba3ad) } };
    const m = mats.ground;
    m.customProgramCacheKey = () => 'ground-wet';
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uWet = U.uWet; sh.uniforms.uSkyRefl = U.uSkyRefl;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vWp; uniform float uWet; uniform vec3 uSkyRefl;
        float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(wh(i), wh(i+vec2(1,0)), f.x), mix(wh(i+vec2(0,1)), wh(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float grey = 1.0 - smoothstep(0.015, 0.06, abs(vColor.r - vColor.b) + abs(vColor.g - vColor.b));
        float pud = smoothstep(0.58, 0.74, wn(vWp.xz * 0.07) * 0.62 + wn(vWp.xz * 0.29) * 0.38) * smoothstep(0.35, 0.9, uWet);
        float wk = uWet * grey;
        roughnessFactor = mix(roughnessFactor, mix(0.3, 0.05, pud), wk);
        diffuseColor.rgb *= mix(1.0, mix(0.66, 0.42, pud), wk);`)
        .replace('#include <opaque_fragment>', `float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 5.0);
        outgoingLight += uSkyRefl * (0.04 + 0.96 * fres) * wk * mix(0.35, 1.0, pud);
        #include <opaque_fragment>`);
    };
  }
  clearRace() {
    for (const v of this.visuals) { this.raceGroup.remove(v.root); v.dispose(); }
    this.visuals = [];
    // track + decor own their materials and canvas textures (nothing is shared with the cars): free them with the geometry
    const freeMat = (m) => { if (!m) return; for (const mm of Array.isArray(m) ? m : [m]) { if (mm.map) mm.map.dispose(); mm.dispose(); } };
    if (this.trackMesh) { this.raceGroup.remove(this.trackMesh.group); this.trackMesh.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) freeMat(o.material); if (o.dispose && o.isInstancedMesh) o.dispose(); }); this.trackMesh = null; }
    if (this.dline) { this.raceGroup.remove(this.dline.mesh); this.dline.dispose(); this.dline = null; }
    if (this.horizon) { this.raceGroup.remove(this.horizon.group); this.horizon.dispose(); this.horizon = null; }
    if (this.decor) { this.raceGroup.remove(this.decor.group); this.decor.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) freeMat(o.material); }); this.decor = null; }
    if (this.mats) { for (const k of ['ground', 'kerb', 'wall', 'wall2', 'far', 'fence']) freeMat(this.mats[k]); this.mats = null; }
    if (this.blobs) { this.raceGroup.remove(this.blobs); this.blobs.geometry.dispose(); this.blobs.material.map.dispose(); this.blobs.material.dispose(); this.blobs.dispose(); this.blobs = null; }
    if (this.scVisual) { this.raceGroup.remove(this.scVisual.root); this.scVisual.dispose(); this.scVisual = null; }
    if (this.ghostVisual) { this.raceGroup.remove(this.ghostVisual.root); this.ghostVisual.dispose(); this.ghostVisual = null; }
  }
  setCars(rm) {
    for (const v of this.visuals) { this.raceGroup.remove(v.root); v.dispose(); }
    this.visuals = rm.cars.map((car) => {
      const v = new CarVisual(car.d.def.team, this.qname, { lod: 1, number: car.d.number });
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
    this.fxRain = w.rain; this.fxCloud = cloud;
    this.sky.setWeather(cloud, w.rain, flash);
    this.scene.fog.color.copy(this.sky.fogColor);
    if (this.mats && this.mats.wetU) this.mats.wetU.uSkyRefl.value.copy(this.sky.uniforms.horizon.value).multiplyScalar(0.55);
    const A = this.atmo;
    const sunI = A.sunI * (0.14 + 0.86 * (1 - cloud * 0.88)) * (1 + flash);
    this.sun.intensity = sunI;
    this.hemi.intensity = A.hemiI * (0.6 + 0.4 * (1 - cloud * 0.6)) + flash * 0.8;
    const fogK = A.fog * (1 - w.rain * 0.55);
    this.scene.fog.far = this.q.drawDistance * 1.05 * fogK; this.scene.fog.near = this.q.drawDistance * 0.3 * fogK;
    if (this.q.env && Math.abs(cloud - this.lastCloud) > 0.3) { this.lastCloud = cloud; this.setupEnv(); }
    this.scene.environmentIntensity = 0.35 + 0.5 * wet;
    this.renderer.toneMappingExposure = A.exposure * (1.0 - 0.1 * cloud);
    // smoke / spray take the light of the moment: a touch of the sun's colour in the clear, duller and greyer under cloud and rain
    this.fxLight = (this.fxLight || new THREE.Color()).setRGB(1, 1, 1).lerp(this.sun.color, 0.25 * (1 - cloud)).multiplyScalar(0.92 - 0.3 * cloud - 0.12 * w.rain + flash * 0.6);
    this.effects.setLight(this.fxLight);
  }

  // ---------------------------------------------------------------- per-frame sync
  sync(rm, alpha, dt, camController) {
    this.time += dt;
    if (camController) this.camMode = camController.mode;
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
    // optimal line: live chevrons (DrivingLine) for the car the camera follows; the old static strip stays hidden
    if (this.trackMesh.line) this.trackMesh.line.visible = false;
    if (this.dline) { const As = this.settings.data.assists; this.dline.update(this.focus, As.drivingLine ?? (As.racingLine ? 'full' : 'off'), dt); }
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
          if (water > 0.25) {   // a spinning or locked tyre on a wet track throws water, not smoke
            while (acc[o] >= 1) { acc[o] -= 1; const sc = this.sky.fogColor; fx.spray.emit(wx, wy, wz, (Math.random() - 0.5) * 1.5 - car.vx * 0.06, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 1.5 - car.vz * 0.06, 1.0, 3.6, 0.7 + Math.random() * 0.5, 0.35 + sc.r * 0.6, 0.36 + sc.g * 0.6, 0.38 + sc.b * 0.6); }
          } else while (acc[o] >= 1) { acc[o] -= 1; fx.smoke.emit(wx, wy, wz, (Math.random() - 0.5) * 1.2 - car.vx * 0.04, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2 - car.vz * 0.04, 0.9, 4.2, 1.1 + Math.random() * 0.8, 0.9, 0.9, 0.92); }
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
          const sc = this.sky.fogColor;   // spray takes the colour of the air around it (a grey-white mist, not white balls)
          while (acc[o + 2] >= 1) { acc[o + 2] -= 1; fx.spray.emit(wx, wy, wz, (Math.random() - 0.5) * 2 - car.vx * 0.12, 1.2 + Math.random() * 2.2, (Math.random() - 0.5) * 2 - car.vz * 0.12, 1.5, 5.4, 0.8 + Math.random() * 0.7, 0.35 + sc.r * 0.6, 0.36 + sc.g * 0.6, 0.38 + sc.b * 0.6); }
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
    const low = this.qname === 'low';
    const Std = low ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
    const root = new THREE.Group();
    // a team garage at night: epoxy floor, turntable with a painted pit box, curved backdrop with light strips
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new Std({ color: 0x26282c, ...(low ? {} : { roughness: 0.62, metalness: 0.0 }) })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.06; root.add(floor);
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(4.3, 4.4, 0.1, 64), new Std({ color: 0x33363b, ...(low ? {} : { roughness: 0.35, metalness: 0.25 }) }));
    plat.position.y = -0.05; root.add(plat);
    const lines = [];
    const strip = (w, d, x, z) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); g.translate(x, 0.004, z); lines.push(g); };
    strip(0.08, 6.4, 1.45, 0); strip(0.08, 6.4, -1.45, 0); strip(2.98, 0.08, 0, -3.2);
    const box = new THREE.Mesh(mergeGeometries(lines), new THREE.MeshBasicMaterial({ color: 0xc9c6bd })); root.add(box);
    const stop = new THREE.Mesh(new THREE.PlaneGeometry(2.98, 0.14).rotateX(-Math.PI / 2).translate(0, 0.005, 3.2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    root.add(stop);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(4.36, 0.02, 6, 96), new THREE.MeshBasicMaterial({ color: 0x9aa3ad })); edge.rotation.x = Math.PI / 2; root.add(edge);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 9, 48, 1, true), new THREE.MeshLambertMaterial({ color: 0x1b1d21, side: THREE.BackSide }));
    wall.position.y = 4.4; root.add(wall);
    const bars = [];
    for (const y of [2.2, 6.3]) { const g = new THREE.CylinderGeometry(14.9, 14.9, 0.07, 64, 1, true); g.translate(0, y, 0); bars.push(g); }
    root.add(new THREE.Mesh(mergeGeometries(bars), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.55, 1.45), side: THREE.BackSide })));
    // one light strip in the team colour between the white ones: the only hue in the garage
    const teamPanel = new THREE.Mesh(new THREE.CylinderGeometry(14.88, 14.88, 0.16, 64, 1, true), new THREE.MeshBasicMaterial({ color: 0xd7141a, side: THREE.BackSide }));
    teamPanel.position.y = 4.25; root.add(teamPanel);
    const rim1 = new THREE.PointLight(0xffffff, 60, 16), rim2 = new THREE.PointLight(0xbcd2ff, 34, 16), top = new THREE.PointLight(0xfff4e6, 5, 10);
    rim1.position.set(-4.5, 2.6, -4); rim2.position.set(5, 2.2, -3.5); top.position.set(0, 5.5, 1.5); root.add(rim1, rim2, top);
    const car = new CarVisual(teamIdx, this.qname, { lod: 0, number: 1 });
    car.root.position.set(0, 0.0, 0); root.add(car.root);
    car.body.updateMatrixWorld(true);
    this.scene.add(root);
    this.showroom = { root, car, t: 0, team: teamIdx, rim1, teamPanel };
    this.tintShowroom(teamIdx);
    this.scene.fog.color.set(0x111215); this.scene.fog.near = 30; this.scene.fog.far = 120;
    this.sky.uniforms.top.value.set(0x0e0f12); this.sky.uniforms.horizon.value.set(0x17181b); this.sky.uniforms.sunPow.value = 0; this.sky.uniforms.glowK.value = 0; this.sky.uniforms.cloud.value = 0; this.sky.uniforms.cloudCol.value.set(0x15161a);
    this.sun.intensity = 2.2; this.sun.color.set(0xfff4e8); this.hemi.intensity = 0.55; this.hemi.color.set(0xc8d2e0); this.hemi.groundColor.set(0x222428);
    this.renderer.toneMappingExposure = 1.05;
    this.sun.position.set(5, 9, 6); this.sun.target.position.set(0, 0, 0);
  }
  tintShowroom(idx) {
    const s = this.showroom; if (!s) return;
    const c = new THREE.Color(TEAMS[idx % TEAMS.length].color);
    s.teamPanel.material.color.copy(c);
    s.rim1.color.copy(c).lerp(new THREE.Color(0xffffff), 0.35);
  }
  setShowroomTeam(idx) { if (this.showroom && this.showroom.team !== idx) { const s = this.showroom; s.root.remove(s.car.root); s.car.dispose(); s.car = new CarVisual(idx, this.qname, { lod: 0, number: 1 }); s.root.add(s.car.root); s.team = idx; this.tintShowroom(idx); } }
  updateShowroom(dt) {
    const s = this.showroom; if (!s) return;
    s.t += dt;
    const a = 0.6 + s.t * 0.22;
    this.camera.position.set(Math.sin(a) * 8.2, 2.1 + Math.sin(s.t * 0.4) * 0.35, Math.cos(a) * 8.2);
    this.camera.up.set(0, 1, 0); this.camera.lookAt(0, 0.55, 0);
    if (this.camera.fov !== 36) { this.camera.fov = 36; this.camera.updateProjectionMatrix(); }
    // the menus sit on the left: on wide screens frame the car right of centre
    const w = this.width || 1, h = this.height || 1;
    if (w / h > 1.3) { const off = Math.round(-w * 0.17); if (!this.camera.view || this.camera.view.offsetX !== off || this.camera.view.fullWidth !== w) this.camera.setViewOffset(w, h, off, 0, w, h); }
    else if (this.camera.view && this.camera.view.enabled) this.camera.clearViewOffset();
    // wheels slowly turning for show
    for (const w2 of s.car.wheels) w2.spin.rotation.x += dt * 1.2;
    s.car.rwFlap.rotation.x = 0.25 + Math.sin(s.t * 1.3) * 0.25;
  }
  exitShowroom() {
    if (!this.showroom) return;
    const sr = this.showroom; this.scene.remove(sr.root); sr.car.dispose();
    sr.root.traverse((o) => { if (o.isMesh && !sr.car.root.getObjectById(o.id)) { o.geometry.dispose(); if (o.material) o.material.dispose(); } });
    this.showroom = null;
    if (this.camera.view && this.camera.view.enabled) this.camera.clearViewOffset();
    this.raceGroup.visible = true; this.effects.group.visible = true;
  }

  render() {
    if (this.perfDirty) { this.perfDirty = false; this.onPerfChange(); }
    if (this.post.enabled) {
      const dt = Math.min(0.1, this.perf.frameMs / 1000 || 0.016), A = this.atmo;
      this.sunCol.set(A.sunColor);
      const sp = this.showroom ? 0 : this.debugSpeed ?? (this.focus ? this.focus.speed : 0);   // (debugSpeed: screenshots only)
      if (this.post.render(dt, { speed: sp, sunDir: this.sky.uniforms.sunDir.value, sunVis: Math.max(0, 1 - this.fxCloud * 1.4) * (this.showroom ? 0 : 1), rain: this.fxRain, sunColor: this.sunCol, time: this.time, focusY: this.camMode === 'chase' ? 0.34 : 0.5, warm: 1 - this.fxCloud * 0.5 })) return;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
