// PostFX: the "cinematic" look (colour, glow, speed), in the spirit of arcade open-world racers' photographic grading - this is a general
// look, not a copy of any particular game. HDR scene -> [bloom] -> speed / sun pass (linear) -> tone map + sRGB -> grade pass (display):
//   * bloom (High): the sun disc, brake lights, hot discs and wet highlights glow (the scene is rendered in half-float so they exceed 1.0)
//   * sun pass: screen-space light shafts through trees / buildings, a soft glare + anamorphic streak when the sun is in view
//   * speed: radial blur away from the focus car (the centre stays sharp)
//   * grade: S-curve contrast, warm highlights / cool shadows, vibrance, film grain (High), gentle desaturation in rain
// Quality: Low = off (the cost of a full-screen pass matters on phones); Medium = one combined pass, no bloom; High = everything.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const FX_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, uSpeed: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.46) }, uAspect: { value: 1.7 },
    uSun: { value: new THREE.Vector2(0.5, 0.5) }, uSunVis: { value: 0 }, uSunColor: { value: new THREE.Color(1.0, 0.85, 0.6) }, uRays: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSpeed; uniform vec2 uCenter; uniform float uAspect; uniform vec2 uSun; uniform float uSunVis; uniform vec3 uSunColor; uniform float uRays;
    varying vec2 vUv;
    float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main(){
      vec2 uv = vUv;
      vec2 dir = uv - uCenter;
      float r = length(dir * vec2(uAspect, 1.0));
      vec3 col;
      if (uSpeed > 0.02) {
        // radial blur: nothing near the focus car, growing towards the edges
        float k = uSpeed * 0.055 * smoothstep(0.16, 0.85, r);
        vec3 acc = vec3(0.0); float wsum = 0.0;
        for (int i = 0; i < 8; i++) { float t = float(i) / 7.0; float w = 1.0 - t * 0.55; acc += texture2D(tDiffuse, uv - dir * k * t).rgb * w; wsum += w; }
        col = acc / wsum;
      } else col = texture2D(tDiffuse, uv).rgb;
      if (uSunVis > 0.01) {
        vec2 toSun = uSun - uv;
        float d = length(toSun * vec2(uAspect, 1.0));
        // light shafts: the bright sky (and sun) seen along the line to the sun; trees and buildings in front of it cut the shafts
        if (uRays > 0.5) {
          float shaft = 0.0, decay = 1.0;
          for (int i = 0; i < 14; i++) { float t = (float(i) + 0.5) / 14.0; vec3 s = texture2D(tDiffuse, uv + toSun * t * 0.85).rgb; shaft += max(0.0, lum(s) - 1.1) * decay; decay *= 0.93; }
          col += uSunColor * shaft * 0.040 * uSunVis * smoothstep(1.4, 0.15, d);
        }
        // glare: soft halo + a horizontal anamorphic streak
        float halo = exp(-d * 4.5) * 0.10 + exp(-d * 14.0) * 0.14;
        float streak = exp(-abs(uv.y - uSun.y) * 55.0) * exp(-abs(uv.x - uSun.x) * 2.2) * 0.07;
        col += uSunColor * (halo + streak) * uSunVis;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uDesat: { value: 0 }, uGrain: { value: 0 }, uWarm: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uDesat; uniform float uGrain; uniform float uWarm; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // vibrance: lift the less saturated colours more than the already vivid ones
      float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
      float sat = mx - mn;
      c = mix(vec3(l), c, 1.0 + (0.18 + (1.0 - sat) * 0.42) * (1.0 - uDesat) - uDesat * 0.35);
      // S-curve contrast
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.42);
      // split toning: cool, slightly teal shadows and warm highlights
      float sh = 1.0 - smoothstep(0.0, 0.45, l), hi = smoothstep(0.45, 1.0, l);
      c += vec3(-0.012, 0.004, 0.022) * sh;
      c *= mix(vec3(1.0), vec3(1.045, 1.0, 0.93), hi * uWarm);
      // a touch of grain keeps the gradients from banding
      c += (hash(vUv * 1500.0) - 0.5) * 0.028 * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.composer = null; this.enabled = false; this.level = 0;   // 0 off, 1 medium, 2 high
    this.sunNdc = new THREE.Vector3(); this.sunWorld = new THREE.Vector3();
    this.size = { w: 1, h: 1, pr: 1 };
    this.failed = false;
  }
  /** HDR targets need EXT_color_buffer_float / half_float (WebGL2: widely available, but not guaranteed on every phone) */
  supported() {
    const gl = this.renderer;
    return !this.failed && gl.capabilities.isWebGL2 && (gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float'));
  }
  /** level: 0 = off, 1 = single pass (medium), 2 = + bloom, light shafts, grain (high) */
  setLevel(level) {
    if (level > 0 && !this.supported()) level = 0;
    if (level === this.level && (level === 0 || this.composer)) { this.enabled = level > 0; return; }
    this.level = level; this.enabled = level > 0;
    this.dispose();
    if (!level) return;
    try { this.build(level); } catch (e) { this.failed = true; this.enabled = false; this.level = 0; this.dispose(); }
  }
  build(level) {
    const rt = new THREE.WebGLRenderTarget(this.size.w, this.size.h, { type: THREE.HalfFloatType, samples: level > 1 ? 4 : 2 });
    const comp = this.composer = new EffectComposer(this.renderer, rt);
    comp.setPixelRatio(this.size.pr); comp.setSize(this.size.w, this.size.h);
    comp.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = null;
    if (level > 1) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this.size.w * this.size.pr, this.size.h * this.size.pr), 0.30, 0.55, 1.6);
      comp.addPass(this.bloom);
    }
    this.fx = new ShaderPass(FX_SHADER); this.fx.uniforms.uRays.value = level > 1 ? 1 : 0; comp.addPass(this.fx);
    comp.addPass(new OutputPass());
    this.grade = new ShaderPass(GRADE_SHADER); this.grade.uniforms.uGrain.value = level > 1 ? 1 : 0; comp.addPass(this.grade);
  }
  setSize(w, h, pr) {
    this.size.w = w; this.size.h = h; this.size.pr = pr;
    if (this.composer) { this.composer.setPixelRatio(pr); this.composer.setSize(w, h); }
  }
  dispose() {
    if (this.composer) { try { for (const p of this.composer.passes) if (p.dispose) p.dispose(); this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose(); } catch (e) { /* ignore */ } }
    this.composer = null; this.bloom = null; this.fx = null; this.grade = null;
  }
  /**
   * state: { speed (m/s), sunDir (unit vector to the sun), sunVis 0..1 (clear sky), rain 0..1, exposureBloom, time, focusY (screen y of the car 0..1) }
   * Returns true when it drew the frame (the caller falls back to a plain render otherwise).
   */
  render(dt, st) {
    if (!this.enabled || !this.composer) return false;
    const fx = this.fx.uniforms, gr = this.grade.uniforms;
    // speed effect: nothing below ~45 m/s, full at ~95 m/s
    const sp = Math.max(0, Math.min(1, ((st.speed || 0) - 45) / 50));
    fx.uSpeed.value += (sp - fx.uSpeed.value) * (1 - Math.exp(-4 * dt));
    fx.uAspect.value = this.size.w / Math.max(1, this.size.h);
    fx.uCenter.value.set(0.5, st.focusY ?? 0.46);
    // sun on screen?
    this.sunWorld.copy(this.camera.position).addScaledVector(st.sunDir, 1000);
    this.sunNdc.copy(this.sunWorld).project(this.camera);
    const onScreen = this.sunNdc.z < 1 && Math.abs(this.sunNdc.x) < 1.35 && Math.abs(this.sunNdc.y) < 1.35;
    const edge = 1 - Math.max(0, Math.max(Math.abs(this.sunNdc.x), Math.abs(this.sunNdc.y)) - 1) / 0.35;
    const vis = onScreen ? Math.max(0, edge) * (st.sunVis ?? 1) : 0;
    fx.uSunVis.value += (vis - fx.uSunVis.value) * (1 - Math.exp(-6 * dt));
    fx.uSun.value.set(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
    if (st.sunColor) fx.uSunColor.value.copy(st.sunColor);
    gr.uTime.value = (st.time || 0) % 100; gr.uDesat.value += ((st.rain || 0) * 0.5 - gr.uDesat.value) * (1 - Math.exp(-2 * dt));
    gr.uWarm.value = st.warm ?? 1;
    if (this.bloom) this.bloom.strength = 0.26 + 0.12 * (st.bloomBoost || 0);
    this.composer.render(dt);
    return true;
  }
}
