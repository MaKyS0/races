// Procedural textures (no image assets needed -> nothing to compress/ship). Resolution scales with the quality profile.
import * as THREE from 'three';
import { makeRng } from '../core/math.js';

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && false) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function tex(c, { repeat = true, srgb = true, aniso = 4, mip = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = mip; t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  return t;
}

/** grey noise tile: multiplied by vertex colours (asphalt, grass, gravel...) */
export function groundTexture(size = 512, aniso = 4) {
  const c = canvas(size, size), g = c.getContext('2d');
  const rnd = makeRng(11);
  g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 205 + (rnd() - 0.5) * 70 + (rnd() < 0.04 ? -45 : 0) + (rnd() < 0.03 ? 25 : 0);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.max(0, Math.min(255, v)); d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // large soft blotches break up tiling
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},0.025)`; g.beginPath(); g.arc(rnd() * size, rnd() * size, 20 + rnd() * 60, 0, 6.3); g.fill(); }
  return tex(c, { aniso });
}
export function kerbTexture(aniso = 4) {
  const c = canvas(64, 64), g = c.getContext('2d');
  g.fillStyle = '#d4181f'; g.fillRect(0, 0, 64, 32); g.fillStyle = '#f2f2f2'; g.fillRect(0, 32, 64, 32);
  const rnd = makeRng(5);
  for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`; g.fillRect(rnd() * 64, rnd() * 64, 2, 2); }
  return tex(c, { aniso });
}
export function barrierTexture(kind = 'tyre', aniso = 4) {
  const c = canvas(256, 64), g = c.getContext('2d');
  if (kind === 'tyre') {
    g.fillStyle = '#16171a'; g.fillRect(0, 0, 256, 64);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#e8e8ea' : '#c4161c'; g.fillRect(x * 32 + 2, y * 32 + 3, 28, 26); g.fillStyle = '#0c0c0e'; g.beginPath(); g.arc(x * 32 + 16, y * 32 + 16, 8, 0, 6.3); g.fill(); }
  } else {
    g.fillStyle = '#9fa3a8'; g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#c4161c'; g.fillRect(0, 22, 256, 10); g.fillStyle = '#f4f4f4'; g.fillRect(0, 32, 256, 10);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; for (let x = 0; x < 256; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
  }
  return tex(c, { aniso });
}
export function crowdTexture(aniso = 2) {
  const c = canvas(256, 128), g = c.getContext('2d');
  g.fillStyle = '#3d4350'; g.fillRect(0, 0, 256, 128);
  // stepped seating rows with tiny coloured spectators
  for (let y = 0; y < 128; y += 16) { g.fillStyle = y % 32 ? '#363b46' : '#444a57'; g.fillRect(0, y, 256, 16); }
  const rnd = makeRng(9);
  const cols = ['#e4572e', '#17bebb', '#ffc914', '#f5f5f5', '#8ac926', '#ff595e', '#6a4c93', '#1982c4', '#222'];
  for (let i = 0; i < 2600; i++) { g.fillStyle = cols[Math.floor(rnd() * cols.length)]; g.fillRect(Math.floor(rnd() * 128) * 2, Math.floor(rnd() * 64) * 2, 2, 2); }
  return tex(c, { aniso });
}
export function windowTexture(aniso = 2) {
  const c = canvas(64, 128), g = c.getContext('2d');
  g.fillStyle = '#c9c1b4'; g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 124; y += 16) for (let x = 4; x < 60; x += 14) { g.fillStyle = (x * y) % 3 ? '#38485c' : '#e8d9a0'; g.fillRect(x, y, 8, 10); }
  return tex(c, { aniso });
}
export function carbonTexture(aniso = 4) {
  const c = canvas(64, 64), g = c.getContext('2d');
  g.fillStyle = '#101113'; g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 8) for (let x = 0; x < 64; x += 8) { g.fillStyle = ((x + y) / 8) % 2 ? '#1b1c20' : '#0b0b0d'; g.fillRect(x, y, 8, 4); g.fillStyle = ((x + y) / 8) % 2 ? '#0b0b0d' : '#1b1c20'; g.fillRect(x, y + 4, 8, 4); }
  return tex(c, { aniso });
}
export function blobTexture() {
  const c = canvas(64, 64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return tex(c, { repeat: false, mip: false });
}
export function smokeTexture() {
  const c = canvas(64, 64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return tex(c, { repeat: false, mip: false });
}
export function skidTexture() {
  const c = canvas(32, 64), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 32, 0);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.2, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 64);
  return tex(c, { repeat: false, mip: false });
}
export function numberBoardTexture(txt) {
  const c = canvas(128, 128), g = c.getContext('2d');
  g.fillStyle = '#f5f5f5'; g.fillRect(0, 0, 128, 128); g.strokeStyle = '#c4161c'; g.lineWidth = 10; g.strokeRect(5, 5, 118, 118);
  g.fillStyle = '#111'; g.font = 'bold 70px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, 64, 68);
  return tex(c, { repeat: false, aniso: 4 });
}
export function logoTexture(text, fg = '#fff', bg = '#c4161c') {
  const c = canvas(256, 64), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 256, 64); g.fillStyle = fg; g.font = 'italic 800 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 34);
  return tex(c, { repeat: false });
}
