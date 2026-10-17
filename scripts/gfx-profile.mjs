// Scene-cost profile (headless Chromium, software GL): draw calls / triangles of the main pass and of the shadow pass, broken down by
// scene part, for each quality profile. Post-processing is switched off while measuring so renderer.info describes the scene itself.
//   node scripts/gfx-profile.mjs [baseUrl=http://localhost:4173/] [track=monza] [ai=15] [ff=40]
import { launch } from './browser.mjs';
const [base = 'http://localhost:4173/', track = 'monza', ai = '15', ff = '40'] = process.argv.slice(2);
const b = await launch();
for (const q of ['low', 'medium', 'high']) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto(`${base}?autostart=1&track=${track}&ai=${ai}&quality=${q}&shot=1`);
  await p.waitForFunction(() => window.__game && window.__game.rm && window.__game.state === 'playing', null, { timeout: 120000 });
  await p.evaluate((ff) => { const g = window.__game; g.fastForward(+ff); g.renderer.focus = g.rm.cars[3]; g.renderer.post.enabled = false; }, ff);
  const f0 = await p.evaluate(() => window.__game.perf.frames); await p.waitForFunction((f) => window.__game.perf.frames > f + 10, f0, { timeout: 120000 });
  const r = await p.evaluate(() => {
    const g = window.__game, R = g.renderer, gl = R.renderer, cam = R.camera, THREE_F = cam.constructor;
    // frustum test with the camera's own matrices
    cam.updateMatrixWorld(); const pv = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const fr = new (Object.getPrototypeOf(cam).constructor === undefined ? Object : window.__FRUSTUM || Object)();
    const parts = {}; const add = (k, tris, cast) => { const o = parts[k] || (parts[k] = { meshes: 0, tris: 0, casters: 0 }); o.meshes++; o.tris += tris; if (cast) o.casters++; };
    const label = (o) => { let n = o; while (n && n.parent && n.parent !== R.raceGroup && n.parent !== R.scene) n = n.parent; if (!n) return '?'; if (R.trackMesh && n === R.trackMesh.group) return 'track'; if (R.decor && n === R.decor.group) return 'decor'; if (R.horizon && n === R.horizon.group) return 'horizon'; if (R.dline && n === R.dline.mesh) return 'line'; if (R.visuals.some((v) => v.root === n)) return 'cars'; if (R.effects && n === R.effects.group) return 'effects'; if (n === R.sky.mesh) return 'sky'; return n.type + ':' + (n.name || ''); };
    let vis = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
    R.scene.traverse((o) => { if (!(o.isMesh || o.isPoints || o.isLine) || !vis(o)) return; const gm = o.geometry; let tris = gm.index ? gm.index.count / 3 : (gm.attributes.position ? gm.attributes.position.count / 3 : 0); if (o.isInstancedMesh) tris *= o.count; add(label(o), Math.round(tris), o.castShadow); });
    gl.info.autoReset = false; gl.info.reset(); gl.render(R.scene, cam); const main = { calls: gl.info.render.calls, tris: gl.info.render.triangles }; gl.info.autoReset = true;
    return { main, parts, programs: gl.info.programs.length, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, shadowMap: gl.shadowMap.enabled, renderMs: +g.perf.renderMs.toFixed(1) };
  });
  console.log(q.toUpperCase(), JSON.stringify(r.main), 'programs', r.programs, 'geoms', r.geometries, 'tex', r.textures, 'shadow', r.shadowMap, 'renderMs(swGL)', r.renderMs);
  for (const [k, v] of Object.entries(r.parts).sort((a, b) => b[1].meshes - a[1].meshes)) console.log('   ', k.padEnd(14), `meshes ${String(v.meshes).padStart(4)}  tris ${String(v.tris).padStart(7)}  shadowCasters ${v.casters}`);
  await p.close();
}
await b.close();
