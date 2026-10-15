// Sky dome (gradient + sun glow) whose colours follow the weather, plus scene fog colour.
import * as THREE from 'three';

export class Sky {
  constructor() {
    this.uniforms = { top: { value: new THREE.Color(0x4a86d6) }, horizon: { value: new THREE.Color(0xbcd6f0) }, sunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() }, sunColor: { value: new THREE.Color(0xfff2cf) }, sunPow: { value: 1.0 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunPow; varying vec3 vD;
        void main(){ float h = clamp(vD.y, -0.2, 1.0); float t = pow(max(h, 0.0), 0.55); vec3 c = mix(horizon, top, t);
          float s = max(dot(normalize(vD), sunDir), 0.0); c += sunColor * (pow(s, 600.0) * 2.5 + pow(s, 12.0) * 0.18) * sunPow;
          c = mix(c, horizon * 0.8, 1.0 - smoothstep(-0.2, 0.0, vD.y)); gl_FragColor = vec4(c, 1.0); }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
    this.mesh.scale.setScalar(9000); this.mesh.frustumCulled = false; this.mesh.renderOrder = -10;
    this.fogColor = new THREE.Color(0xbcd6f0);
  }
  /** cloud 0..1, rain 0..1, flash 0..1 */
  setWeather(cloud, rain, flash = 0) {
    const clear = { top: new THREE.Color(0x3f7fd8), hor: new THREE.Color(0xc2d9f0) };
    const grey = { top: new THREE.Color(0x6d7683), hor: new THREE.Color(0x9aa2ac) };
    const dark = { top: new THREE.Color(0x3d424b), hor: new THREE.Color(0x646b75) };
    const c = Math.min(1, cloud);
    this.uniforms.top.value.copy(clear.top).lerp(grey.top, c).lerp(dark.top, rain * 0.7);
    this.uniforms.horizon.value.copy(clear.hor).lerp(grey.hor, c).lerp(dark.hor, rain * 0.7);
    if (flash > 0) { this.uniforms.top.value.lerp(new THREE.Color(0xdde8ff), flash * 0.7); this.uniforms.horizon.value.lerp(new THREE.Color(0xffffff), flash * 0.6); }
    this.uniforms.sunPow.value = Math.max(0, 1 - c * 1.3);
    this.fogColor.copy(this.uniforms.horizon.value);
  }
  follow(cam) { this.mesh.position.copy(cam.position); }
}
