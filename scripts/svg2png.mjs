import { chromium } from 'playwright';
import fs from 'node:fs';
const files = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }).catch(async () => chromium.launch({ args: ['--no-sandbox'] }));
const p = await b.newPage({ viewport: { width: 900, height: 900 } });
for (const f of files) { await p.setContent('<body style="margin:0">' + fs.readFileSync(f, 'utf8') + '</body>'); await p.screenshot({ path: f.replace('.svg', '.png') }); }
await b.close();
