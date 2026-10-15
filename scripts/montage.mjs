import { launch } from './browser.mjs';
import fs from 'node:fs';
const ids = ['monza','monaco','spa','silverstone','suzuka','bahrain'];
const html = '<body style="margin:0;display:grid;grid-template-columns:repeat(3,480px)">' + ids.map((i) => `<div style="position:relative"><b style="position:absolute;left:8px;top:4px;font:14px sans-serif">${i}</b><div style="width:480px;height:480px;overflow:hidden"><div style="transform:scale(.533);transform-origin:0 0">${fs.readFileSync(`build-output/${i}.svg`, 'utf8')}</div></div></div>`).join('') + '</body>';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1440, height: 960 } });
await p.setContent(html); await p.screenshot({ path: 'build-output/montage.png' }); await b.close();
