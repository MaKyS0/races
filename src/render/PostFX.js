// PostFX: the "cinematic" look (colour, glow, speed), in the spirit of arcade open-world racers' photographic grading - a general look,
// not a copy of any particular game. Built for phones' tile GPUs, where every full-resolution pass costs bandwidth:
//   scene -> HDR target (half float, MSAA)                                       [1 full-res render, the scene itself]
//   High only: bright-pass + 4x downsample -> separable blur x2   (quarter resolution: 1/16 of the pixels each)
//   ONE full-resolution pass to the screen: speed blur + bloom + light shafts + glare + ACES tone map + sRGB + grade + grain
// (the first version used EffectComposer + UnrealBloom + 3 full-screen passes and cost more than the scene itself).
//   * bloom (High): the sun disc, brake lights, hot discs and wet highlights glow
//   * light shafts (High): the bright sky seen along the line to the sun, from the blurred quarter-res buffer (cheap taps)
//   * speed: radial blur away from the focus car (the centre stays sharp), only above ~160 km/h
//   * grade: S-curve contrast, vibrance, cool shadows / warm highlights, grain (High), muted colours in the rain
// Quality: Low = off; Medium = the single final pass (no bloom / shafts); High = everything.
// 'Clean' (level 0.5): the look switched off on Medium / High. The canvas is created without MSAA whenever this pipeline can draw the
// frame (its own HDR target is multisampled, a multisampled canvas under it would only cost memory and a resolve), so with the look
// off the scene still goes through the MSAA target and the final pass only tone maps - the same ACES + sRGB as three's direct path.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;
  float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main(){
    // 4 bilinear taps = a 4x4 box: the downsample and the bright-pass in one go
    vec3 c = 0.25 * (texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tDiffuse, vUv + uTexel * vec2(1.0, -1.0)).rgb
                   + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tDiffuse, vUv + uTexel * vec2(1.0, 1.0)).rgb);
    float l = lum(c);
    vec3 bloom = c * max(0.0, l - uThreshold) / max(l, 1e-4);
    float shaft = clamp(l - 0.9, 0.0, 4.0);                     // the source of the light shafts: bright sky / sun (lower threshold)
    gl_FragColor = vec4(bloom, shaft);
  }`;
const BLUR_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
  void main(){
    vec4 s = texture2D(tDiffuse, vUv) * 0.227027;
    s += (texture2D(tDiffuse, vUv + uDir * 1.384615) + texture2D(tDiffuse, vUv - uDir * 1.384615)) * 0.316216;
    s += (texture2D(tDiffuse, vUv + uDir * 3.230769) + texture2D(tDiffuse, vUv - uDir * 3.230769)) * 0.070270;
    gl_FragColor = s;
  }`;
const FINAL_FRAG = `
  uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uBloom; uniform float uRays;
  uniform float uSpeed; uniform vec2 uCenter; uniform float uAspect; uniform vec2 uSun; uniform float uSunVis; uniform vec3 uSunColor;
  uniform float uExposure; uniform float uTime; uniform float uDesat; uniform float uGrain; uniform float uWarm; uniform float uTaps; uniform float uGrade;
  varying vec2 vUv;
  vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
  vec3 aces(vec3 c){   // same fit as three.js' ACESFilmicToneMapping
    const mat3 i = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 o = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    c *= uExposure / 0.6; c = i * c; c = RRTAndODTFit(c); c = o * c; return clamp(c, 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
  void main(){
    vec2 uv = vUv, dir = uv - uCenter;
    if (uGrade < 0.5) { gl_FragColor = vec4(toSRGB(aces(texture2D(tScene, uv).rgb)), 1.0); return; }
    float r = length(dir * vec2(uAspect, 1.0));
    vec3 col;
    if (uSpeed > 0.02) {
      float k = uSpeed * 0.05 * smoothstep(0.16, 0.85, r);
      vec3 acc = vec3(0.0); float ws = 0.0;
      for (int i = 0; i < 8; i++) { if (float(i) >= uTaps) break; float t = float(i) / (uTaps - 1.0); float w = 1.0 - t * 0.55; acc += texture2D(tScene, uv - dir * k * t).rgb * w; ws += w; }
      col = acc / ws;
    } else col = texture2D(tScene, uv).rgb;
    if (uBloom > 0.0) col += texture2D(tBloom, uv).rgb * uBloom;
    if (uSunVis > 0.01) {
      vec2 toSun = uSun - uv;
      float d = length(toSun * vec2(uAspect, 1.0));
      if (uRays > 0.5) {
        float shaft = 0.0, decay = 1.0;
        for (int i = 0; i < 12; i++) { float t = (float(i) + 0.5) / 12.0; shaft += texture2D(tBloom, uv + toSun * t * 0.85).a * decay; decay *= 0.92; }
        col += uSunColor * shaft * 0.05 * uSunVis * smoothstep(1.4, 0.15, d);
      }
      float halo = exp(-d * 4.5) * 0.10 + exp(-d * 14.0) * 0.14;
      float streak = exp(-abs(uv.y - uSun.y) * 55.0) * exp(-abs(uv.x - uSun.x) * 2.2) * 0.07;
      col += uSunColor * (halo + streak) * uSunVis;
    }
    vec3 c = toSRGB(aces(col));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(l), c, 1.0 + (0.18 + (1.0 - sat) * 0.42) * (1.0 - uDesat) - uDesat * 0.35);
    c = clamp(c, 0.0, 1.0);
    c = mix(c, c * c * (3.0 - 2.0 * c), 0.42);
    float sh = 1.0 - smoothstep(0.0, 0.45, l), hi = smoothstep(0.45, 1.0, l);
    c += vec3(-0.012, 0.004, 0.022) * sh;
    c *= mix(vec3(1.0), vec3(1.045, 1.0, 0.93), hi * uWarm);
    c += (hash(uv * 1500.0) - 0.5) * 0.028 * uGrain;
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;

const mat = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.enabled = false; this.level = 0; this.failed = false;
    this.size = { w: 1, h: 1, pr: 1 };
    this.sunNdc = new THREE.Vector3(); this.sunWorld = new THREE.Vector3();
    this.quad = new FullScreenQuad(null);
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); this.black.needsUpdate = true;
    this.final = mat(FINAL_FRAG, {
      tScene: { value: null }, tBloom: { value: this.black }, uBloom: { value: 0 }, uRays: { value: 0 }, uSpeed: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.46) },
      uAspect: { value: 1.7 }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uSunVis: { value: 0 }, uSunColor: { value: new THREE.Color(1, 0.85, 0.6) }, uExposure: { value: 1 },
      uTime: { value: 0 }, uDesat: { value: 0 }, uGrain: { value: 0 }, uWarm: { value: 1 }, uTaps: { value: 8 }, uGrade: { value: 1 },
    });
    this.bright = mat(BRIGHT_FRAG, { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.6 } });
    this.blur = mat(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.rtScene = null; this.rtA = null; this.rtB = null;
  }
  supported() {
    const gl = this.renderer;
    return !this.failed && gl.capabilities.isWebGL2 && (gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float'));
  }
  /** level: 0 = off, 0.5 = clean (MSAA + tone map only), 1 = final pass only (medium), 2 = + bloom and light shafts (high) */
  setLevel(level) {
    if (level > 0 && !this.supported()) level = 0;
    if (level !== this.level) { this.level = level; this.disposeTargets(); }
    this.enabled = level > 0;
    if (this.enabled && !this.rtScene) { try { this.makeTargets(); } catch (e) { this.failed = true; this.enabled = false; this.level = 0; this.disposeTargets(); } }
  }
  makeTargets() {
    const W = Math.max(1, Math.round(this.size.w * this.size.pr)), H = Math.max(1, Math.round(this.size.h * this.size.pr));
    this.rtScene = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: this.level === 1 ? 2 : 4 });
    if (this.level > 1) {
      const o = { type: THREE.HalfFloatType, depthBuffer: false };
      this.rtA = new THREE.WebGLRenderTarget(Math.max(1, W >> 2), Math.max(1, H >> 2), o); this.rtB = this.rtA.clone();
    }
    this.final.uniforms.uTaps.value = this.level > 1 ? 8 : 6;
    this.final.uniforms.uGrain.value = this.level > 1 ? 1 : 0;
    this.final.uniforms.uGrade.value = this.level >= 1 ? 1 : 0;
  }
  disposeTargets() { for (const k of ['rtScene', 'rtA', 'rtB']) if (this[k]) { this[k].dispose(); this[k] = null; } }
  setSize(w, h, pr) {
    const changed = w !== this.size.w || h !== this.size.h || pr !== this.size.pr;
    this.size.w = w; this.size.h = h; this.size.pr = pr;
    if (changed && this.rtScene) { this.disposeTargets(); this.makeTargets(); }
  }
  dispose() { this.disposeTargets(); this.final.dispose(); this.bright.dispose(); this.blur.dispose(); this.quad.dispose(); this.black.dispose(); }
  pass(material, target) { this.quad.material = material; this.renderer.setRenderTarget(target); this.quad.render(this.renderer); }
  /** state: { speed (m/s), sunDir, sunVis 0..1, rain 0..1, sunColor, time, focusY, warm }; returns true when it drew the frame */
  render(dt, st) {
    if (!this.enabled || !this.rtScene) return false;
    const gl = this.renderer, u = this.final.uniforms;
    gl.setRenderTarget(this.rtScene); gl.render(this.scene, this.camera);
    if (this.level > 1) {
      const A = this.rtA, B = this.rtB;
      this.bright.uniforms.tDiffuse.value = this.rtScene.texture; this.bright.uniforms.uTexel.value.set(1 / this.rtScene.width, 1 / this.rtScene.height);
      this.pass(this.bright, A);
      const bu = this.blur.uniforms;
      bu.tDiffuse.value = A.texture; bu.uDir.value.set(1 / A.width, 0); this.pass(this.blur, B);
      bu.tDiffuse.value = B.texture; bu.uDir.value.set(0, 1 / A.height); this.pass(this.blur, A);
      bu.tDiffuse.value = A.texture; bu.uDir.value.set(2.5 / A.width, 0); this.pass(this.blur, B);
      bu.tDiffuse.value = B.texture; bu.uDir.value.set(0, 2.5 / A.height); this.pass(this.blur, A);
      u.tBloom.value = A.texture; u.uBloom.value = 0.55 + 0.25 * (st.bloomBoost || 0); u.uRays.value = 1;
    } else { u.tBloom.value = this.black; u.uBloom.value = 0; u.uRays.value = 0; }
    // speed effect: nothing below ~45 m/s, full at ~95 m/s
    const sp = Math.max(0, Math.min(1, ((st.speed || 0) - 45) / 50));
    u.uSpeed.value += (sp - u.uSpeed.value) * (1 - Math.exp(-4 * dt));
    u.uAspect.value = this.size.w / Math.max(1, this.size.h);
    u.uCenter.value.set(0.5, st.focusY ?? 0.46);
    this.sunWorld.copy(this.camera.position).addScaledVector(st.sunDir, 1000);
    this.sunNdc.copy(this.sunWorld).project(this.camera);
    const onScreen = this.sunNdc.z < 1 && Math.abs(this.sunNdc.x) < 1.35 && Math.abs(this.sunNdc.y) < 1.35;
    const edge = 1 - Math.max(0, Math.max(Math.abs(this.sunNdc.x), Math.abs(this.sunNdc.y)) - 1) / 0.35;
    const vis = onScreen ? Math.max(0, edge) * (st.sunVis ?? 1) : 0;
    u.uSunVis.value += (vis - u.uSunVis.value) * (1 - Math.exp(-6 * dt));
    u.uSun.value.set(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
    if (st.sunColor) u.uSunColor.value.copy(st.sunColor);
    u.uExposure.value = gl.toneMappingExposure;
    u.uTime.value = (st.time || 0) % 100; u.uDesat.value += ((st.rain || 0) * 0.5 - u.uDesat.value) * (1 - Math.exp(-2 * dt));
    u.uWarm.value = st.warm ?? 1;
    u.tScene.value = this.rtScene.texture;
    this.pass(this.final, null);
    return true;
  }
}
