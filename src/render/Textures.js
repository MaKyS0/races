// Procedural textures (no image assets needed -> nothing to compress/ship). Resolution scales with the quality profile.
// Text on trackside boards uses the UI face (Barlow Condensed, bundled) so the 3D signage and the HUD share one typography;
// it falls back to a system condensed face if the font has not loaded yet. All brand names are fictional.
import * as THREE from 'three';
import { makeRng } from '../core/math.js';

const FONT = (w, px) => `${w} ${px}px "Barlow Condensed", "Roboto Condensed", "Arial Narrow", sans-serif`;
export const INK = { chalk: '#f2efe6', board: '#141518', asphalt: '#2b2e33', alu: '#9aa3ad' };

function canvas(w, h) {
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
/** tileable value noise in [0,1] on an n x n lattice */
function noiseField(size, cells, rnd) {
  const lat = new Float32Array(cells * cells); for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cells, fy = (y / size) * cells, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = lat[(iy % cells) * cells + (ix % cells)], b = lat[(iy % cells) * cells + ((ix + 1) % cells)], c = lat[((iy + 1) % cells) * cells + (ix % cells)], d = lat[((iy + 1) % cells) * cells + ((ix + 1) % cells)];
    out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
  return out;
}

/** grey aggregate tile, multiplied by the vertex colours (asphalt, grass, gravel...). Fine stones + mid blotches + broad patches. */
export function groundTexture(size = 512, aniso = 4) {
  const c = canvas(size, size), g = c.getContext('2d');
  const rnd = makeRng(11);
  const img = g.createImageData(size, size), d = img.data;
  const n1 = noiseField(size, 6, rnd), n2 = noiseField(size, 24, rnd), n3 = noiseField(size, 64, rnd);
  for (let i = 0; i < size * size; i++) {
    let v = 212 + (n1[i] - 0.5) * 22 + (n2[i] - 0.5) * 18 + (n3[i] - 0.5) * 16 + (rnd() - 0.5) * 34;
    const r = rnd();
    if (r < 0.035) v -= 40 + rnd() * 30;          // pits between the stones
    else if (r < 0.06) v += 22 + rnd() * 18;      // light aggregate
    const t = Math.max(0, Math.min(255, v));
    d[i * 4] = t; d[i * 4 + 1] = t * 0.995; d[i * 4 + 2] = t * 0.985; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(c, { aniso });
}
/** kerb: painted stripe (v = along the track, one colour per metre) with a lighter raised inner edge and a dirty outer edge */
export function kerbTexture(aniso = 4, stripe = 0xd8161e) {
  const W = 64, H = 128, c = canvas(W, H), g = c.getContext('2d');
  const col = '#' + stripe.toString(16).padStart(6, '0');
  g.fillStyle = col; g.fillRect(0, 0, W, H / 2); g.fillStyle = '#efede6'; g.fillRect(0, H / 2, W, H / 2);
  const sh = g.createLinearGradient(0, 0, W, 0);       // u: 0 = track edge, 1 = outer edge
  sh.addColorStop(0, 'rgba(255,255,255,0.18)'); sh.addColorStop(0.12, 'rgba(255,255,255,0)'); sh.addColorStop(0.75, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.32)');
  g.fillStyle = sh; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, W, 2); g.fillRect(0, H / 2, W, 2);    // joints
  const rnd = makeRng(5);
  for (let i = 0; i < 420; i++) { g.fillStyle = `rgba(20,20,20,${rnd() * 0.16})`; g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2); }
  for (let i = 0; i < 26; i++) { g.fillStyle = 'rgba(15,15,15,0.22)'; g.fillRect(rnd() * W * 0.5, rnd() * H, 4 + rnd() * 10, 1.2); }   // rubber
  return tex(c, { aniso });
}

// ---------------------------------------------------------------- fictional sponsors (shapes + invented names)
export const SPONSORS = [
  { name: 'APEX GP', bg: INK.board, fg: INK.chalk, mark: 'apex' },
  { name: 'KERBLINE', bg: '#ffc233', fg: INK.board, mark: 'stripes' },
  { name: 'NORTHWIND', bg: '#1f4fd0', fg: INK.chalk, mark: 'chevron' },
  { name: 'VOLTA CELLS', bg: '#11865a', fg: INK.chalk, mark: 'bolt' },
  { name: 'ORBITAL', bg: INK.chalk, fg: '#c4161c', mark: 'ring' },
];
function drawMark(g, kind, x, y, s, fg, bg) {
  g.save(); g.translate(x, y); g.fillStyle = fg; g.strokeStyle = fg;
  if (kind === 'apex') { g.lineWidth = s * 0.14; g.lineCap = 'round'; g.beginPath(); g.moveTo(-s * 0.45, s * 0.5); g.bezierCurveTo(-s * 0.45, -s * 0.05, -s * 0.3, -s * 0.3, 0, -s * 0.33); g.bezierCurveTo(s * 0.25, -s * 0.36, s * 0.4, -s * 0.3, s * 0.55, -s * 0.22); g.stroke(); g.fillStyle = '#e8002d'; g.beginPath(); g.arc(-s * 0.05, -s * 0.32, s * 0.13, 0, 6.3); g.fill(); }
  else if (kind === 'stripes') { for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-s * 0.5 + i * s * 0.32, s * 0.45); g.lineTo(-s * 0.3 + i * s * 0.32, -s * 0.45); g.lineTo(-s * 0.14 + i * s * 0.32, -s * 0.45); g.lineTo(-s * 0.34 + i * s * 0.32, s * 0.45); g.fill(); } }
  else if (kind === 'chevron') { g.lineWidth = s * 0.16; g.lineJoin = 'miter'; for (let i = 0; i < 2; i++) { g.beginPath(); g.moveTo(-s * 0.45 + i * s * 0.35, -s * 0.4); g.lineTo(-s * 0.1 + i * s * 0.35, 0); g.lineTo(-s * 0.45 + i * s * 0.35, s * 0.4); g.stroke(); } }
  else if (kind === 'bolt') { g.beginPath(); g.moveTo(s * 0.1, -s * 0.5); g.lineTo(-s * 0.3, s * 0.08); g.lineTo(0, s * 0.08); g.lineTo(-s * 0.12, s * 0.5); g.lineTo(s * 0.32, -s * 0.1); g.lineTo(s * 0.02, -s * 0.1); g.closePath(); g.fill(); }
  else if (kind === 'ring') { g.lineWidth = s * 0.15; g.beginPath(); g.arc(0, 0, s * 0.36, 0, 6.3); g.stroke(); g.fillStyle = bg; g.fillRect(s * 0.1, -s * 0.5, s * 0.5, s * 0.3); }
  g.restore();
}
/** one sponsor panel w x h on the given context */
function sponsorPanel(g, sp, x, y, w, h) {
  g.fillStyle = sp.bg; g.fillRect(x, y, w, h);
  const m = h * 0.62;
  drawMark(g, sp.mark, x + h * 0.55, y + h / 2, m, sp.fg, sp.bg);
  g.fillStyle = sp.fg; g.font = FONT(700, Math.round(h * 0.6)); g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(sp.name, x + h * 1.05, y + h * 0.54, w - h * 1.25);
}
/** hoarding / banner: sponsor panel (256x64) */
export function logoTexture(text, fg = INK.chalk, bg = '#c4161c', mark = null) {
  const c = canvas(512, 96), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 512, 96);
  if (mark) drawMark(g, mark, 60, 48, 64, fg, bg);
  g.fillStyle = fg; g.font = FONT(700, 62); g.textAlign = mark ? 'left' : 'center'; g.textBaseline = 'middle'; g.fillText(text, mark ? 110 : 256, 52, 480);
  return tex(c, { repeat: false });
}
export function sponsorTexture(i) { const c = canvas(512, 96), g = c.getContext('2d'); sponsorPanel(g, SPONSORS[i % SPONSORS.length], 0, 0, 512, 96); return tex(c, { repeat: false, aniso: 4 }); }

/** barriers. u runs along the track (one texture = 16 m), v from the top (0) to the ground (1). */
export function barrierTexture(kind = 'tyre', aniso = 4) {
  const W = 1024, H = 128, c = canvas(W, H), g = c.getContext('2d');
  const rnd = makeRng(kind === 'tyre' ? 21 : 22);
  if (kind === 'tyre') {
    // belted tyre wall: dark rubber belt with sponsor panels, the tyre stack shows below the belt
    g.fillStyle = '#17181b'; g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 32) { g.fillStyle = '#0d0d0f'; g.beginPath(); g.arc(x + 16, H - 14, 13, 0, 6.3); g.fill(); g.fillStyle = '#232428'; g.beginPath(); g.arc(x + 16, H - 14, 6, 0, 6.3); g.fill(); }
    g.fillStyle = '#26282c'; g.fillRect(0, 6, W, H - 36);
    for (let k = 0; k < 4; k++) { const sp = SPONSORS[(k + 1) % SPONSORS.length]; sponsorPanel(g, sp, k * 256 + 10, 14, 236, H - 52); }
    g.fillStyle = 'rgba(0,0,0,0.5)'; for (let x = 0; x < W; x += 256) g.fillRect(x, 6, 4, H - 36);
    g.fillStyle = '#d4d6d9'; g.fillRect(0, 0, W, 6);     // top rail
  } else {
    // concrete wall: light grey cast panels, painted red/white top band, water stains
    g.fillStyle = '#b9bcbf'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(60,62,66,${rnd() * 0.08})`; g.fillRect(rnd() * W, 20 + rnd() * 60, 2 + rnd() * 6, 10 + rnd() * 50); }
    for (let x = 0; x < W; x += 64) { g.fillStyle = (x / 64) % 2 ? '#c4161c' : '#f2efe6'; g.fillRect(x, 0, 64, 16); }
    for (let k = 0; k < 2; k++) sponsorPanel(g, SPONSORS[(k * 2 + 2) % SPONSORS.length], k * 512 + 96, 34, 320, 54);
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 2; for (let x = 0; x < W; x += 128) { g.beginPath(); g.moveTo(x, 16); g.lineTo(x, H); g.stroke(); }
    const sh = g.createLinearGradient(0, 0, 0, H); sh.addColorStop(0.7, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(30,30,30,0.35)'); g.fillStyle = sh; g.fillRect(0, 0, W, H);
  }
  return tex(c, { aniso });
}
/** catch fence: wire diamond mesh (alpha) with posts every texture repeat */
export function fenceTexture(aniso = 4) {
  const W = 256, H = 128, c = canvas(W, H), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(190,196,202,0.85)'; g.lineWidth = 1.2;
  for (let x = -H; x < W + H; x += 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H, H); g.stroke(); g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
  g.fillStyle = '#5d6268'; g.fillRect(0, 0, 6, H); g.fillRect(0, 0, W, 4); g.fillRect(0, H - 3, W, 3);
  const t = tex(c, { aniso }); t.premultiplyAlpha = false; return t;
}
/** grandstand: stepped rows of team-coloured seats with spectators, darker under the roof */
export function crowdTexture(aniso = 2) {
  const c = canvas(512, 256), g = c.getContext('2d');
  const rnd = makeRng(9);
  const seats = ['#2b4f9c', '#c4161c', '#2b4f9c', '#d6d7d2', '#127a52', '#2b4f9c'];
  for (let r = 0; r < 16; r++) {
    const y = r * 16;
    g.fillStyle = r % 2 ? '#474b52' : '#3d4148'; g.fillRect(0, y, 512, 16);
    for (let x = 0; x < 512; x += 64) { g.fillStyle = seats[((x / 64) + (r >> 2)) % seats.length]; g.fillRect(x, y + 5, 64, 9); }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, y + 14, 512, 2);
  }
  const cols = ['#f2efe6', '#e4572e', '#ffc233', '#3d8bff', '#c4161c', '#1b1c1f', '#e8d6b0', '#8a5a3c', '#2fae66', '#f26ca7'];
  for (let i = 0; i < 6200; i++) {
    const row = Math.floor(rnd() * 16); if (rnd() < row / 40) continue;              // fuller towards the front
    const x = Math.floor(rnd() * 170) * 3, y = row * 16 + 2 + Math.floor(rnd() * 3);
    g.fillStyle = cols[Math.floor(rnd() * cols.length)]; g.fillRect(x, y + 3, 3, 4);
    g.fillStyle = '#d8b08c'; g.fillRect(x, y, 3, 3);                                    // heads
  }
  const sh = g.createLinearGradient(0, 0, 0, 256); sh.addColorStop(0, 'rgba(0,0,0,0.45)'); sh.addColorStop(0.35, 'rgba(0,0,0,0)'); g.fillStyle = sh; g.fillRect(0, 0, 512, 256);
  return tex(c, { aniso });
}
/** pit building / city facade: glazed bands between concrete floors */
export function windowTexture(aniso = 2, city = false) {
  const c = canvas(128, 256), g = c.getContext('2d');
  const rnd = makeRng(city ? 31 : 32);
  if (city) {
    // plastered Riviera facade: tall shuttered windows, balcony ledges every floor (the instance colour adds the pastel)
    g.fillStyle = '#eee8dc'; g.fillRect(0, 0, 128, 256);
    for (let y = 0; y < 256; y += 42) {
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, y + 36, 128, 4);
      g.fillStyle = '#f7f4ee'; g.fillRect(0, y + 33, 128, 3);
      for (let x = 10; x < 128; x += 30) {
        const open = rnd() < 0.55;
        g.fillStyle = '#2e3844'; g.fillRect(x, y + 6, 14, 26);
        g.fillStyle = open ? '#8f9f7e' : '#7b8b6c'; g.fillRect(x - 5, y + 6, 5, 26); g.fillRect(x + 14, y + 6, 5, 26);   // green shutters
        if (!open) { g.fillStyle = '#86977a'; g.fillRect(x, y + 6, 14, 26); }
      }
    }
  } else {
    // pit building: glazed hospitality floors
    g.fillStyle = '#d6d8da'; g.fillRect(0, 0, 128, 256);
    for (let y = 0; y < 256; y += 32) {
      for (let x = 6; x < 122; x += 29) {
        const lit = rnd() < 0.15;
        const gr = g.createLinearGradient(0, y + 6, 0, y + 26); gr.addColorStop(0, lit ? '#f2dca0' : '#7d93ad'); gr.addColorStop(1, lit ? '#d6b56c' : '#2d3a4b');
        g.fillStyle = gr; g.fillRect(x, y + 7, 25, 19);
      }
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y + 27, 128, 3);
    }
  }
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
  gr.addColorStop(0, 'rgba(0,0,0,0.8)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return tex(c, { repeat: false, mip: false });
}
/** soft, lumpy puff (several offset blobs) so smoke and spray do not read as perfect discs */
export function smokeTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const rnd = makeRng(4);
  // a few big soft lobes for the body, then many small ones around the rim: a billowing outline instead of a disc
  const blob = (x, y, rad, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  };
  for (let i = 0; i < 7; i++) { const a = rnd() * 6.28, r = rnd() * S * 0.12; blob(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, S * (0.2 + rnd() * 0.12), 0.3); }
  for (let i = 0; i < 26; i++) { const a = rnd() * 6.28, r = S * (0.16 + rnd() * 0.16); blob(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, S * (0.05 + rnd() * 0.07), 0.22); }
  const fall = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S / 2);   // never a hard edge
  fall.addColorStop(0, 'rgba(0,0,0,0)'); fall.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = fall; g.fillRect(0, 0, S, S);
  return tex(c, { repeat: false, mip: false });
}
/** small hot spark: bright core, quick falloff */
export function sparkTexture() {
  const c = canvas(32, 32), g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return tex(c, { repeat: false, mip: false });
}
export function skidTexture() {
  const c = canvas(32, 64), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 32, 0);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.2, 'rgba(0,0,0,0.5)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 64);
  const rnd = makeRng(8); g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(0,0,0,${0.2 + rnd() * 0.3})`; g.fillRect(rnd() * 32, rnd() * 64, 1, 3 + rnd() * 6); }    // tread streaks
  return tex(c, { repeat: false, mip: false });
}
/** braking-distance board in the identity: chalk board, asphalt numerals, team-neutral */
export function numberBoardTexture(txt) {
  const c = canvas(128, 128), g = c.getContext('2d');
  g.fillStyle = INK.chalk; g.fillRect(0, 0, 128, 128);
  g.fillStyle = INK.board; g.fillRect(0, 0, 128, 10); g.fillRect(0, 118, 128, 10);
  g.fillStyle = INK.board; g.font = FONT(700, 88); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, 64, 68, 120);
  return tex(c, { repeat: false, aniso: 4 });
}
/** grid slot numbers painted on the asphalt: 1..20 in a 5x4 atlas */
export function gridNumberAtlas() {
  const c = canvas(640, 512), g = c.getContext('2d');
  g.clearRect(0, 0, 640, 512);
  g.fillStyle = 'rgba(242,239,230,0.92)'; g.font = FONT(700, 112); g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < 20; i++) g.fillText(String(i + 1), (i % 5) * 128 + 64, Math.floor(i / 5) * 128 + 70, 120);
  return tex(c, { repeat: false, aniso: 4 });
}
