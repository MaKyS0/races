// How does the car behave as the corner speed rises past the limit?  (R=40 m fixed radius, throttle held at 60 % / 100 %)
import { runScenario } from './corner-test.mjs';
const tc = +(process.argv[2] ?? 1);
for (const thr of [0.6, 1.0]) for (const v of [20, 24, 28, 32, 36, 40]) {
  const r = runScenario({ name: 'sweep', R: 40, v0: v, T: 4, fixedR: true, thr: (t) => (t < 0.8 ? 0.3 : thr) }, { tc });
  console.log(`tc${tc} gas ${thr} v0=${v}: β=${r.maxBetaDeg.toFixed(1)}° rearSlip=${r.maxRearSlipDeg.toFixed(1)}° steerSat=${r.steerSatS.toFixed(2)}s yawErr=${r.yawErr.toFixed(2)} vEnd=${r.vEnd.toFixed(1)}`);
}
