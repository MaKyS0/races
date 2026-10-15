// Sky dome (gradient + sun glow) whose colours follow the weather, plus scene fog colour.
import * as THREE from 'three';

export class Sky {
  /** quality: 'low' skips the cloud layer (the sky covers the whole screen, so its fragment cost matters on phones) */
  constructor(quality = 'high') {
    this.uniforms = {
      top: { value: new THREE.Color(0x1f5bc4) }, horizon: { value: new THREE.Color(0xb4cfee) }, sunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() },
      sunColor: { value: new THREE.Color(0xfff2cf) }, sunPow: { value: 1.0 }, cloud: { value: 0.1 }, time: { value: 0 }, cloudCol: { value: new THREE.Color(0xffffff) },
    };
    const clouds = quality !== 'low';
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: true,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunPow; uniform float cloud; uniform float time; uniform vec3 cloudCol; varying vec3 vD;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vD);
          float h = clamp(d.y, -0.2, 1.0);
          float t = pow(max(h, 0.0), 0.5);
          vec3 c = mix(horizon, top, t);
          // sun: tight disc + soft glow + warm haze around it near the horizon
          float s = max(dot(d, sunDir), 0.0);
          c += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 24.0) * 0.28 + pow(s, 4.0) * 0.06) * sunPow;
          c = mix(c, horizon, exp(-max(d.y, 0.0) * 9.0) * 0.45);                      // thicker air near the horizon
          ${clouds ? `
          if (d.y > 0.02) {
            vec2 uv = d.xz / (d.y + 0.28) * 1.6 + vec2(time * 0.004, time * 0.0015);
            float n = fbm(uv * 1.3);
            float cover = mix(0.62, 0.30, cloud);                                     // more cloud -> lower threshold
            float m = smoothstep(cover, cover + 0.22, n) * smoothstep(0.02, 0.25, d.y);
            float lit = 0.72 + 0.38 * clamp(dot(normalize(vec3(d.xz, 0.0)).xy, sunDir.xz) * 0.5 + 0.5, 0.0, 1.0);
            vec3 cc = cloudCol * lit; cc = mix(cc, cc * vec3(0.62, 0.66, 0.74), smoothstep(0.55, 0.9, n));   // darker bases
            c = mix(c, cc, m * mix(0.55, 0.95, cloud));
          }` : ''}
          c = mix(c, horizon * 0.8, 1.0 - smoothstep(-0.2, 0.0, d.y));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mat);
    this.mesh.scale.setScalar(9000); this.mesh.frustumCulled = false; this.mesh.renderOrder = -10;
    this.fogColor = new THREE.Color(0xc7dcf2);
  }
  /** cloud 0..1, rain 0..1, flash 0..1 */
  setWeather(cloud, rain, flash = 0) {
    const clear = { top: new THREE.Color(0x1f5bc4), hor: new THREE.Color(0xb4cfee) };
    const grey = { top: new THREE.Color(0x6d7683), hor: new THREE.Color(0x9aa2ac) };
    const dark = { top: new THREE.Color(0x3d424b), hor: new THREE.Color(0x646b75) };
    const c = Math.min(1, cloud);
    this.uniforms.top.value.copy(clear.top).lerp(grey.top, c).lerp(dark.top, rain * 0.7);
    this.uniforms.horizon.value.copy(clear.hor).lerp(grey.hor, c).lerp(dark.hor, rain * 0.7);
    if (flash > 0) { this.uniforms.top.value.lerp(new THREE.Color(0xdde8ff), flash * 0.7); this.uniforms.horizon.value.lerp(new THREE.Color(0xffffff), flash * 0.6); }
    this.uniforms.sunPow.value = Math.max(0, 1 - c * 1.3);
    this.uniforms.cloud.value = Math.min(1, c + rain * 0.5);
    this.uniforms.cloudCol.value.setRGB(1, 1, 1).lerp(new THREE.Color(0x8d939d), Math.min(1, c * 0.6 + rain * 0.6));
    this.fogColor.copy(this.uniforms.horizon.value);
  }
  follow(cam, dt = 0) { this.mesh.position.copy(cam.position); this.uniforms.time.value += dt; }
}
