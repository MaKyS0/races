// Can the car still be upset by bad driving? (it must not be unspinnable)
import { runScenario } from './corner-test.mjs';
const cases = [
  { name: 'standstill, full lock + full gas, TC off', R: 1e9, v0: 2, T: 4, thr: () => 1, steerFn: () => 1, opts: { tc: 0 } },
  { name: 'standstill, full lock + full gas, TC mid', R: 1e9, v0: 2, T: 4, thr: () => 1, steerFn: () => 1, opts: { tc: 1 } },
  { name: '30 m/s, 80 % lock slam + full gas, TC off', R: 1e9, v0: 30, T: 4, thr: (t) => (t > 0.5 ? 1 : 0.3), steerFn: (t) => (t > 0.5 ? 0.8 : 0), opts: { tc: 0 } },
  { name: '45 m/s sine steering 2 Hz full lock, gas 70 %', R: 1e9, v0: 45, T: 4, thr: () => 0.7, steerFn: (t) => Math.sin(t * 12.5), opts: { tc: 1 } },
  { name: '70 m/s full lock slam + brake', R: 1e9, v0: 70, T: 4, thr: () => 0, brk: (t) => (t > 0.5 ? 1 : 0), steerFn: (t) => (t > 0.5 ? 1 : 0), opts: { tc: 1 } },
  { name: '55 m/s lift + full lock (lift-off oversteer test)', R: 1e9, v0: 55, T: 4, thr: (t) => (t < 0.5 ? 1 : 0), steerFn: (t) => (t > 0.6 ? 0.7 : 0), opts: { tc: 1 } },
];
for (const c of cases.concat(cases.slice(2).map((c) => ({ ...c, name: c.name + ' [steer assist OFF]', opts: { ...c.opts, steerAssist: 0 } })))) {
  const r = runScenario(c, c.opts);
  console.log(`${c.name.padEnd(52)} βmax=${r.maxBetaDeg.toFixed(0)}° rearSlip=${r.maxRearSlipDeg.toFixed(0)}° κmax=${r.maxKappa.toFixed(2)} spin>29°=${r.spinS.toFixed(2)}s vEnd=${r.vEnd.toFixed(0)}`);
}
