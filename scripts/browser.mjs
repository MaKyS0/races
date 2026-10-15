// Launch the pre-installed Chromium (works offline in this sandbox) with software GL for WebGL tests.
import { chromium } from 'playwright';
import fs from 'node:fs';
export async function launch(extraArgs = []) {
  const cands = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'];
  const executablePath = cands.find((p) => fs.existsSync(p));
  return chromium.launch({ executablePath, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs] });
}
