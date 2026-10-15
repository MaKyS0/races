// TrackMesh: turns a Track into chunked, frustum-cullable meshes (ground ribbon with vertex colours, kerbs, barriers),
// with two levels of detail per chunk, terrain skirts that follow the elevation, pit lane, and an optional racing-line overlay.
import * as THREE from 'three';
import { clamp, lerp } from '../core/math.js';
import { SURF } from '../track/TrackSystem.js';

const _c = new THREE.Color();
const col = (hex) => { _c.setHex(hex); return [_c.r, _c.g, _c.b]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class GeoBuilder {
  constructor() { this.pos = []; this.col = []; this.uv = []; this.idx = []; this.n = 0; }
  v(x, y, z, c, u, vv) { this.pos.push(x, y, z); this.col.push(c[0], c[1], c[2]); this.uv.push(u, vv); return this.n++; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  build() {
    if (this.n === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export class TrackMesh {
  constructor(track, mats, opts = {}) {
    this.track = track;
    this.mats = mats;
    this.group = new THREE.Group();
    this.chunks = [];
    this.opts = opts;
    this.theme = track.def.theme || {};
    const th = this.theme;
    this.pal = {
      asphalt: col(0x38393c), asphaltDark: col(0x2a2b2e), runoff: col(0x4b4d52), pit: col(0x3d3f44), white: col(0xe9e9e6), yellow: col(0xe8c21a),
      gravel: col(th.desert ? 0xcbb283 : 0xb7a37c), sand: col(0xd6bd86),
      grass: col(th.grass ?? 0x3f7a35), grass2: mix(col(th.grass ?? 0x3f7a35), col(0x24401f), 0.4), grass3: mix(col(th.grass ?? 0x3f7a35), col(0x6e8f54), 0.35),
      kerbBase: col(0x555557), wallTop: col(0xcfcfcf),
    };
    this.minY = Math.min(...track.y);
    this.groundY = this.minY - 7;
    this.build();
  }

  // ---------------------------------------------------------------- cross-section generation
  sideVerts(i, left) {
    // returns the list of [n (signed), yRel, colour, kind] for one side, outward from the asphalt edge
    const t = this.track, P = this.pal;
    const edge = left ? t.wl[i] : t.wr[i];
    const sg = left ? 1 : -1;
    const kerb = left ? t.kerbL[i] : t.kerbR[i];
    const ro = left ? t.roL : t.roR;
    const roW = ro.w[i], roG = ro.g[i], roT = ro.t[i];
    const out = [];
    const pitHere = (left ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0;
    const asph = P.asphalt;
    out.push([sg * (edge - 0.22), 0, asph]);
    out.push([sg * (edge - 0.22), 0.004, P.white]);
    out.push([sg * edge, 0.004, P.white]);
    let eEff = edge, kerbW = kerb, roWw = roW, roC;
    const roColor = roT === SURF.GRAVEL ? P.gravel : roT === SURF.SAND ? P.sand : roT === SURF.RUNOFF ? P.runoff : P.grass;
    let wallN = edge + kerb + roW + roG + 0.6;
    if (pitHere) {
      eEff = t.pitOuter[i]; kerbW = 0; roWw = 3.0; wallN = t.pitOuter[i] + 3.4;
      out.push([sg * edge, 0, P.pit]);
      out.push([sg * eEff, 0, P.pit]);
      out.push([sg * eEff, 0, P.runoff]);
      out.push([sg * (eEff + roWw), -0.01, P.runoff]);
      out.push([sg * (eEff + roWw), -0.02, P.grass]);
    } else {
      out.push([sg * edge, 0, P.kerbBase]);
      out.push([sg * (edge + kerbW), 0, P.kerbBase]);
      out.push([sg * (edge + kerbW), -0.01, roColor]);
      out.push([sg * (edge + kerbW + roWw), -0.02, roColor]);
      out.push([sg * (edge + kerbW + roWw), -0.03, roT === SURF.RUNOFF || roT === SURF.GRAVEL || roT === SURF.SAND ? P.grass : roColor]);
    }
    const wallBase = Math.max(wallN, eEff + roWw + 0.4);
    out.push([sg * wallBase, -0.05, P.grass]);
    // terrain skirts (heights are relative offsets here; the absolute 'ground' target is applied in row())
    out.push([sg * (wallBase + 22), -1.4, P.grass2, 'skirt1']);
    out.push([sg * (wallBase + 90), 0, P.grass3, 'skirt2']);
    out.push([sg * (wallBase + 380), 0, P.grass3, 'skirt3']);
    out.wallN = wallBase;
    return out;
  }

  rowPoints(i) {
    const t = this.track;
    const L = this.sideVerts(i, true), R = this.sideVerts(i, false);
    const pts = [];
    // right outer -> centre -> left outer ; asphalt body subdivided for the rubbered racing line
    for (let k = R.length - 1; k >= 0; k--) pts.push(R[k]);
    const wl = t.wl[i], wr = t.wr[i], line = t.line[i];
    const K = 8;
    for (let k = 1; k < K; k++) {
      const n = -wr + 0.22 + ((wl + wr - 0.44) * k) / K;
      const d = (n - line) / 1.4;
      pts.push([n, 0, mix(this.pal.asphalt, this.pal.asphaltDark, Math.exp(-d * d) * 0.85)]);
    }
    for (let k = 0; k < L.length; k++) pts.push(L[k]);
    pts.wallL = L.wallN; pts.wallR = R.wallN;
    return pts;
  }

  // ---------------------------------------------------------------- chunk construction
  build() {
    const t = this.track, N = t.N;
    const rowsPerChunk = this.opts.rowsPerChunk || 110;
    const nChunks = Math.ceil(N / rowsPerChunk);
    this.kerbMat = this.mats.kerb; this.groundMat = this.mats.ground; this.wallMat = this.mats.wall; this.wallMat2 = this.mats.wall2;
    const city = !!this.theme.city;
    for (let c = 0; c < nChunks; c++) {
      const i0 = c * rowsPerChunk, i1 = Math.min(N, i0 + rowsPerChunk);
      const chunk = { i0, i1, hi: new THREE.Group(), lo: new THREE.Group() };
      for (const [grp, stride] of [[chunk.hi, 1], [chunk.lo, 4]]) {
        const G = new GeoBuilder(), K = new GeoBuilder(), W = new GeoBuilder(), W2 = new GeoBuilder();
        this.buildRange(i0, i1, stride, G, K, W, W2, city);
        const geoG = G.build(), geoK = K.build(), geoW = W.build(), geoW2 = W2.build();
        if (geoG) { const m = new THREE.Mesh(geoG, this.groundMat); m.receiveShadow = true; grp.add(m); }
        if (geoK) { const m = new THREE.Mesh(geoK, this.kerbMat); m.receiveShadow = true; m.renderOrder = 1; grp.add(m); }
        if (geoW) { const m = new THREE.Mesh(geoW, this.wallMat); grp.add(m); }
        if (geoW2) { const m = new THREE.Mesh(geoW2, this.wallMat2); grp.add(m); }
        grp.visible = false;
        this.group.add(grp);
      }
      const mid = Math.floor((i0 + i1) / 2) % N;
      chunk.cx = t.x[mid]; chunk.cz = t.z[mid];
      let r = 0;
      for (let i = i0; i < i1; i += 8) r = Math.max(r, Math.hypot(t.x[i % N] - chunk.cx, t.z[i % N] - chunk.cz));
      chunk.radius = r + 420; // terrain skirts extend far on both sides
      this.chunks.push(chunk);
    }
    // big ground disc behind everything
    const g = new THREE.PlaneGeometry(40000, 40000); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, this.mats.far);
    m.position.set((t.bounds.minX + t.bounds.maxX) / 2, this.groundY - 0.3, (t.bounds.minZ + t.bounds.maxZ) / 2);
    this.far = m; m.receiveShadow = false;
    this.group.add(m);
  }

  rowY(i, n, rel, kind) {
    const t = this.track;
    let y = t.y[i % t.N];
    if (kind === 'skirt1') return y - 1.4 + (rel || 0) * 0;
    if (kind === 'skirt2') return lerp(y, this.groundY, 0.35);
    if (kind === 'skirt3') return this.groundY;
    const wedge = Math.max(-0.045, Math.min(0.045, t.cross[i % t.N])) * Math.min(Math.abs(n), 12) * Math.sign(n);
    return y + wedge + rel;
  }

  buildRange(i0, i1, stride, G, K, W, W2, city) {
    const t = this.track, N = t.N, ds = t.ds;
    const idxs = [];
    for (let i = i0; i < i1; i += stride) idxs.push(i);
    idxs.push(i1);
    const st = { G: null, K: {}, W: {}, W2: {} };
    for (let r = 0; r < idxs.length; r++) {
      const iu = idxs[r], i = iu % N, sG = iu * ds;
      const psi = t.psi[i];
      const lx = Math.cos(psi), lz = -Math.sin(psi);
      const cx = t.x[i], cz = t.z[i];
      const pts = this.rowPoints(i);
      // ---- ground
      const row = [];
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], n = p[0];
        const x = cx + lx * n, z = cz + lz * n;
        row.push(G.v(x, this.rowY(i, n, p[1], p[3]), z, p[2], x * 0.5, z * 0.5));
      }
      if (st.G) {
        const pr = st.G;
        for (let k = 0; k < row.length - 1; k++) {
          const a = pr[k], b = row[k], c2 = pr[k + 1], d = row[k + 1];
          if (G.pos[a * 3] === G.pos[c2 * 3] && G.pos[a * 3 + 2] === G.pos[c2 * 3 + 2] && G.pos[b * 3] === G.pos[d * 3] && G.pos[b * 3 + 2] === G.pos[d * 3 + 2]) continue; // collapsed band
          G.tri(a, b, c2); G.tri(c2, b, d);
        }
      }
      st.G = row;
      // ---- kerbs
      for (const left of [true, false]) {
        const key = left ? 'L' : 'R';
        const sg = left ? 1 : -1;
        const pitHere = (left ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0;
        const kw = pitHere ? 0 : (left ? t.kerbL[i] : t.kerbR[i]);
        const edge = left ? t.wl[i] : t.wr[i];
        const nA = sg * edge, nB = sg * (edge + Math.max(kw, 0.001));
        const y = t.y[i] + Math.max(-0.045, Math.min(0.045, t.cross[i])) * Math.min(Math.abs(nA), 12) * Math.sign(nA) + 0.014;
        const a = K.v(cx + lx * nA, y, cz + lz * nA, [1, 1, 1], 0, sG / 2.0);
        const b = K.v(cx + lx * nB, y + (kw > 0 ? 0.02 : 0), cz + lz * nB, [1, 1, 1], 1, sG / 2.0);
        const pk = st.K[key];
        if (pk && kw > 0 && pk[2] > 0) { K.tri(pk[0], a, pk[1]); K.tri(pk[1], a, b); }
        st.K[key] = [a, b, kw];
      }
      // ---- barriers (+ inner pit wall)
      for (const left of [true, false]) {
        const key = left ? 'L' : 'R', sg = left ? 1 : -1;
        const pitHere = (left ? 1 : -1) === t.pitSide && t.pitOuter[i] > 0;
        const wallN = (left ? pts.wallL : pts.wallR) - 0.2;
        const B = city || pitHere ? W2 : W, S = city || pitHere ? st.W2 : st.W;
        const h = city ? 1.5 : pitHere ? 1.7 : 1.15;
        const y0 = t.y[i] + Math.max(-0.045, Math.min(0.045, t.cross[i])) * Math.min(wallN, 12) * sg - 0.05;
        const x = cx + lx * sg * wallN, z = cz + lz * sg * wallN;
        const a = B.v(x, y0, z, [1, 1, 1], sG / 8, 1), b = B.v(x, y0 + h, z, [1, 1, 1], sG / 8, 0);
        if (S[key]) { const p = S[key]; B.tri(p[0], a, p[1]); B.tri(p[1], a, b); }
        S[key] = [a, b];
        if ((left ? 1 : -1) === t.pitSide && t.pitWallD[i] > 0) {
          const nIn = t.pitWallD[i];
          const xi = cx + lx * sg * nIn, zi = cz + lz * sg * nIn, yi = t.y[i] - 0.03;
          const aa = W2.v(xi, yi, zi, [1, 1, 1], sG / 8, 1), bb = W2.v(xi, yi + 1.0, zi, [1, 1, 1], sG / 8, 0);
          if (st.W2[key + 'in']) { const p = st.W2[key + 'in']; W2.tri(p[0], aa, p[1]); W2.tri(p[1], aa, bb); }
          st.W2[key + 'in'] = [aa, bb];
        } else st.W2[key + 'in'] = null;
      }
    }
  }

  // ---------------------------------------------------------------- per-frame visibility
  update(camX, camZ, drawDistance) {
    for (const c of this.chunks) {
      const d = Math.hypot(camX - c.cx, camZ - c.cz) - c.radius + 420; // radius includes skirts; distance to the road itself
      const show = d < drawDistance;
      const near = d < 380;
      c.hi.visible = show && near; c.lo.visible = show && !near;
    }
  }
  setWet(w) {
    // one shared ground material: wetter = darker, glossier
    const m = this.mats;
    m.ground.roughness = lerp(0.95, 0.35, w);
    m.ground.color.setScalar(lerp(1, 0.62, w));
    if (m.groundEnvIntensity !== undefined) m.ground.envMapIntensity = lerp(0.25, 1.1, w);
    m.kerb.roughness = lerp(0.8, 0.4, w);
  }

  /** racing-line overlay coloured by the speed profile (green = accelerate, red = brake) */
  buildLine(profile) {
    const t = this.track, N = t.N;
    const g = new GeoBuilder();
    const rows = [];
    for (let i = 0; i < N; i += 2) {
      const j = (i + 6) % N;
      const dv = profile.v[j] - profile.v[i];
      let c;
      if (dv < -1.2) c = [1, 0.15 + Math.min(0.4, -dv * 0.01), 0.1];
      else if (dv > 1.2) c = [0.2, 1, 0.3];
      else c = [1, 0.95, 0.35];
      const x = t.lineX[i], z = t.lineZ[i];
      const psi = t.psi[i], lx = Math.cos(psi), lz = -Math.sin(psi);
      const y = t.y[i] + 0.03 + Math.max(-0.045, Math.min(0.045, t.cross[i])) * t.line[i];
      const a = g.v(x - lx * 0.3, y, z - lz * 0.3, c, 0, 0), b = g.v(x + lx * 0.3, y, z + lz * 0.3, c, 1, 0);
      if (rows.length) { const p = rows[rows.length - 1]; g.tri(p[0], a, p[1]); g.tri(p[1], a, b); }
      rows.push([a, b]);
    }
    const geo = g.build();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
    this.line = new THREE.Mesh(geo, mat);
    this.line.renderOrder = 2; this.line.visible = false; this.line.frustumCulled = false;
    this.group.add(this.line);
  }
}
