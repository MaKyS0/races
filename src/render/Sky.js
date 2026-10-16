// Sky dome (gradient + sun glow + optional cloud layer) whose colours follow the circuit's time of day and the weather,
// plus the scene fog colour. The clear-sky palette comes from Atmosphere.js; weather lerps from it towards grey / storm.
import * as THREE from 'three';

const GREY = { top: new THREE.Color(0x6d7683), hor: new THREE.Color(0x9ba3ad) };
const DARK = { top: new THREE.Color(0x3a3f48), hor: new THREE.Color(0x5f666f) };
const FLASH_T = new THREE.Color(0xdde8ff), FLASH_H = new THREE.Color(0xffffff), CLOUD_GREY = new THREE.Color(0x8b919b);

export class Sky {
  /** quality: 'low' skips the cloud layer (the sky covers the whole screen, so its fragment cost matters on phones) */
  constructor(quality = 'high') {
    this.uniforms = {
      top: { value: new THREE.Color(0x1f5bc4) }, horizon: { value: new THREE.Color(0xb4cfee) }, sunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() },
      sunColor: { value: new THREE.Color(0xfff2cf) }, sunPow: { value: 1.0 }, cloud: { value: 0.1 }, time: { value: 0 }, cloudCol: { value: new THREE.Color(0xffffff) },
      glow: { value: new THREE.Color(0xffe2b0) }, glowK: { value: 0.3 },
    };
    this.base = { top: new THREE.Color(0x1f5bc4), hor: new THREE.Color(0xb4cfee), glow: new THREE.Color(0xffe2b0), glowK: 0.3, cloudBase: 0, cloudTint: new THREE.Color(0xffffff) };
    const clouds = quality !== 'low';
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: true,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunPow; uniform float cloud; uniform float time; uniform vec3 cloudCol; uniform vec3 glow; uniform float glowK; varying vec3 vD;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vD);
          float h = clamp(d.y, -0.2, 1.0);
          float t = pow(max(h, 0.0), 0.45);
          vec3 c = mix(horizon, top, t);
          float s = max(dot(d, sunDir), 0.0);
          // warm air around the sun, strongest near the horizon (time-of-day glow)
          float az = max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-4), normalize(vec3(sunDir.x, 0.0, sunDir.z) + 1e-4)), 0.0);
          c = mix(c, glow, glowK * pow(az, 3.0) * exp(-max(d.y, 0.0) * 5.0) * sunPow);
          c += sunColor * (pow(s, 1100.0) * 4.0 + pow(s, 28.0) * 0.30 + pow(s, 5.0) * 0.07) * sunPow;
          c = mix(c, horizon, exp(-max(d.y, 0.0) * 10.0) * 0.4);                      // thicker air near the horizon
          ${clouds ? `
          if (d.y > 0.015) {
            vec2 uv = d.xz / (d.y + 0.25) * 1.5 + vec2(time * 0.004, time * 0.0015);
            float n = fbm(uv * 1.3);
            float cover = mix(0.62, 0.28, cloud);                                     // more cloud -> lower threshold
            float m = smoothstep(cover, cover + 0.24, n) * smoothstep(0.015, 0.22, d.y);
            float toward = pow(az, 2.0);
            vec3 lit = cloudCol * (0.78 + 0.32 * toward) + sunColor * 0.25 * toward * sunPow;
            vec3 cc = mix(lit, lit * vec3(0.6, 0.64, 0.72), smoothstep(0.5, 0.92, n));   // darker bases
            c = mix(c, cc, m * mix(0.6, 0.96, cloud));
          }` : ''}
          c = mix(c, horizon * 0.78, 1.0 - smoothstep(-0.2, 0.0, d.y));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mat);
    this.mesh.scale.setScalar(9000); this.mesh.frustumCulled = false; this.mesh.renderOrder = -10;
    this.fogColor = new THREE.Color(0xc7dcf2);
  }
  /** clear-sky palette for the circuit's time of day (Atmosphere preset) */
  setPalette(a) {
    this.base.top.set(a.top); this.base.hor.set(a.horizon); this.base.glow.set(a.glow); this.base.glowK = a.glowK; this.base.cloudBase = a.cloudBase || 0;
    this.base.cloudTint.set(a.cloudTint ?? 0xffffff);
    this.uniforms.sunDir.value.copy(a.sunDir); this.uniforms.sunColor.value.set(a.sunColor);
    this.uniforms.glow.value.copy(this.base.glow); this.uniforms.glowK.value = a.glowK;
  }
  /** cloud 0..1, rain 0..1, flash 0..1 */
  setWeather(cloud, rain, flash = 0) {
    const c = Math.min(1, cloud + this.base.cloudBase * (1 - cloud));
    const u = this.uniforms;
    u.top.value.copy(this.base.top).lerp(GREY.top, cloud).lerp(DARK.top, rain * 0.7);
    u.horizon.value.copy(this.base.hor).lerp(GREY.hor, cloud).lerp(DARK.hor, rain * 0.7);
    if (flash > 0) { u.top.value.lerp(FLASH_T, flash * 0.7); u.horizon.value.lerp(FLASH_H, flash * 0.6); }
    u.sunPow.value = Math.max(0, 1 - cloud * 1.3);
    u.cloud.value = Math.min(1, c + rain * 0.5);
    u.cloudCol.value.copy(this.base.cloudTint).lerp(CLOUD_GREY, Math.min(1, cloud * 0.6 + rain * 0.6));
    this.fogColor.copy(u.horizon.value);
  }
  follow(cam, dt = 0) { this.mesh.position.copy(cam.position); this.uniforms.time.value += dt; }
}
