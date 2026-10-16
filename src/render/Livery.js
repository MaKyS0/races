// Livery: team-specific paint patterns evaluated in the car's object space (x = left, y = up, z = forward), so the
// procedural body needs no UVs. The same pattern is used three ways: in the detailed car's paint shader (anti-aliased),
// baked into the vertex colours of the far-LOD cars (coarse), and as the marker replacement for wing endplates / mirrors.
// Patterns and sponsor-like blocks are abstract shapes only (fictional teams, no real marks).
import * as THREE from 'three';
import { TEAMS } from '../race/Roster.js';
import { COL } from './CarParts.js';

/** p = pattern id (GLSL switch), finish = paint response */
export const LIVERY = {
  crimson: { p: 1, finish: 'gloss' },    // forward chevron sweeping down the sidepods
  azure: { p: 2, finish: 'gloss' },      // diagonal split, yellow tail
  silver: { p: 3, finish: 'metal' },     // dark lower body under a silver top
  papaya: { p: 4, finish: 'gloss' },     // black engine cover and nose tip
  emerald: { p: 5, finish: 'gloss' },    // twin pinstripes
  violet: { p: 6, finish: 'gloss' },     // zig-zag band along the flank
  gold: { p: 7, finish: 'gloss' },       // black nose
  ice: { p: 8, finish: 'gloss' },        // navy wedge rising to the nose
  onyx: { p: 9, finish: 'matte' },       // matte black, red spine
  lime: { p: 10, finish: 'gloss' },      // black hoops
};
export const liveryOf = (teamIdx) => { const t = TEAMS[teamIdx % TEAMS.length]; return { team: t, ...(LIVERY[t.id] || { p: 0, finish: 'gloss' }) }; };
const lum = (hex) => ((hex >> 16 & 255) * 0.299 + (hex >> 8 & 255) * 0.587 + (hex & 255) * 0.114) / 255;
/** colour of the sponsor-like blocks: chalk on dark/saturated paint, near-black on light paint */
export const blockColor = (t) => (lum(t.color) > 0.62 ? 0x141518 : 0xf2efe6);

// ---------------------------------------------------------------- GLSL (d < 0 inside; aa() turns a signed distance into coverage)
const GLSL = `
  uniform int uPat; uniform vec3 uAcc; uniform vec3 uBlk;
  varying vec3 vLp;
  float aa(float d){ float w = max(fwidth(d), 1e-4); return 1.0 - smoothstep(-w, w, d); }
  float boxd(vec2 p, vec2 c, vec2 h){ vec2 q = abs(p - c) - h; return max(q.x, q.y); }
  float tri(float x){ return abs(fract(x) - 0.5) * 2.0; }
  float liveryMask(vec3 p){
    float ax = abs(p.x);
    if (uPat == 1) { float d = p.z + ax * 1.7 + 0.15; return aa(abs(d) - 0.16) * step(0.12, p.y); }
    if (uPat == 2) return aa(p.z + 0.35 + (p.y - 0.3) * 1.4);
    if (uPat == 3) return aa(p.y - 0.255);
    if (uPat == 4) return max(aa(0.64 - p.y), aa(2.05 - p.z));
    if (uPat == 5) return aa(abs(ax - 0.115) - 0.016) * step(0.3, p.y);
    if (uPat == 6) return aa(abs(p.y - (0.26 + 0.07 * tri(p.z * 1.6))) - 0.035);
    if (uPat == 7) return aa(1.25 - p.z);
    if (uPat == 8) return aa(p.y - (0.21 + 0.075 * p.z));
    if (uPat == 9) return aa(ax - 0.05) * step(0.3, p.y);
    if (uPat == 10) return aa(abs(fract(p.z * 0.9 + 0.2) - 0.5) - 0.07) * step(-1.9, p.z) * step(p.z, 1.9);
    return 0.0;
  }
  float blockMask(vec3 p){
    float ax = abs(p.x);
    float pod = aa(boxd(vec2(p.z, p.y), vec2(-0.5, 0.26), vec2(0.36, 0.055))) * step(0.63, ax);           // sidepod flank
    float cover = aa(boxd(vec2(p.z, p.y), vec2(-1.05, 0.70), vec2(0.30, 0.05))) * step(0.06, ax) * step(0.52, p.y); // engine cover
    float nose = aa(boxd(vec2(p.x, p.z), vec2(0.0, 1.95), vec2(0.045, 0.16))) * step(0.12, p.y);              // nose top
    return max(max(pod, cover), nose);
  }`;

/** paint shader for the detailed body (MeshPhysical / MeshStandard / MeshLambert) */
export function applyLivery(mat, teamIdx) {
  const L = liveryOf(teamIdx);
  const U = { uPat: { value: L.p }, uAcc: { value: new THREE.Color(L.team.accent) }, uBlk: { value: new THREE.Color(blockColor(L.team)) } };
  mat.customProgramCacheKey = () => 'livery';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLp;').replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLp = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, uAcc, liveryMask(vLp));\n  diffuseColor.rgb = mix(diffuseColor.rgb, uBlk, blockMask(vLp));');
  };
  return mat;
}

/** detail (carbon / metal / rubber...) material: marker colours become team / accent colour; on PBR materials the
 *  vertex colour class also picks the surface response (bright neutral = machined metal, dark = clear-coated carbon). */
export function applyDetail(mat, teamIdx) {
  const t = TEAMS[teamIdx % TEAMS.length];
  const U = { uTeam: { value: new THREE.Color(t.color) }, uAcc2: { value: new THREE.Color(t.accent) } };
  const pbr = mat.isMeshStandardMaterial;
  mat.customProgramCacheKey = () => 'detail' + (pbr ? 'pbr' : '');
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uTeam; uniform vec3 uAcc2;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      float mk = 0.0;
      if (vColor.r > 0.98 && vColor.g < 0.02 && vColor.b > 0.98) { diffuseColor.rgb = uTeam; mk = 1.0; }
      else if (vColor.r < 0.02 && vColor.g > 0.98 && vColor.b > 0.98) { diffuseColor.rgb = uAcc2; mk = 1.0; }
      float vl = dot(vColor.rgb, vec3(0.299, 0.587, 0.114)), vs = max(max(vColor.r, vColor.g), vColor.b) - min(min(vColor.r, vColor.g), vColor.b);`);
    if (pbr) sh.fragmentShader = sh.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
      if (mk > 0.5) { roughnessFactor = 0.3; metalnessFactor = 0.1; }
      else if (vl > 0.12 && vs < 0.06) { metalnessFactor = 0.92; roughnessFactor = 0.26; }
      else if (vl < 0.008) { metalnessFactor = 0.0; roughnessFactor = 0.62; }
      else if (vl < 0.09 && vs < 0.05) { metalnessFactor = 0.18; roughnessFactor = 0.3; }`);
  };
  return mat;
}

// ---------------------------------------------------------------- JS twin for the vertex-colour LODs (hard edges are fine at that distance)
const fract = (x) => x - Math.floor(x);
const tri = (x) => Math.abs(fract(x) - 0.5) * 2;
function maskJS(p, x, y, z) {
  const ax = Math.abs(x);
  switch (p) {
    case 1: return Math.abs(z + ax * 1.7 + 0.15) < 0.16 && y > 0.12;
    case 2: return z + 0.35 + (y - 0.3) * 1.4 < 0;
    case 3: return y < 0.255;
    case 4: return y > 0.64 || z > 2.05;
    case 5: return Math.abs(ax - 0.115) < 0.016 && y > 0.3;
    case 6: return Math.abs(y - (0.26 + 0.07 * tri(z * 1.6))) < 0.035;
    case 7: return z > 1.25;
    case 8: return y < 0.21 + 0.075 * z;
    case 9: return ax < 0.05 && y > 0.3;
    case 10: return Math.abs(fract(z * 0.9 + 0.2) - 0.5) < 0.07 && z > -1.9 && z < 1.9;
    default: return false;
  }
}
/** paint a body geometry's vertex colours with the team pattern */
export function bakeLivery(geo, teamIdx) {
  const L = liveryOf(teamIdx), pos = geo.attributes.position, n = pos.count;
  const base = new THREE.Color(L.team.color), acc = new THREE.Color(L.team.accent);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const c = maskJS(L.p, pos.getX(i), pos.getY(i), pos.getZ(i)) ? acc : base; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); return geo;
}
/** replace the marker colours in a vertex-coloured geometry (baked LODs) */
export function bakeMarkers(geo, teamIdx) {
  const t = TEAMS[teamIdx % TEAMS.length], c = geo.attributes.color; if (!c) return geo;
  const team = new THREE.Color(t.color), acc = new THREE.Color(t.accent), tm = new THREE.Color(COL.teamMark), am = new THREE.Color(COL.accentMark);
  for (let i = 0; i < c.count; i++) {
    const r = c.getX(i), g = c.getY(i), b = c.getZ(i);
    if (Math.abs(r - tm.r) + Math.abs(g - tm.g) + Math.abs(b - tm.b) < 0.03) c.setXYZ(i, team.r, team.g, team.b);
    else if (Math.abs(r - am.r) + Math.abs(g - am.g) + Math.abs(b - am.b) < 0.03) c.setXYZ(i, acc.r, acc.g, acc.b);
  }
  c.needsUpdate = true; return geo;
}
