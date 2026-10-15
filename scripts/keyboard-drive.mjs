// Drivability check with a keyboard-like virtual driver: binary key presses (tapped with duty cycles), 20 Hz decisions, 150 ms
// reaction delay, the REAL Input class (progressive keyboard steering / pedals) and default player assists.
// node scripts/keyboard-drive.mjs [track|all] [carefulness 0.8..1] [laps]
import { getTrack, CIRCUITS } from '../src/track/circuits/index.js';
import { Vehicle, DEFAULT_SETUP } from '../src/physics/VehiclePhysics.js';
import { buildSpeedProfile } from '../src/ai/SpeedProfile.js';
import { CollisionSystem } from '../src/physics/CollisionAndDamage.js';
import { Input } from '../src/core/Input.js';
import { Settings } from '../src/core/Settings.js';
import { clamp, wrapPi } from '../src/core/math.js';

const [which = 'all', carefulS = '0.88', lapsS = '2'] = process.argv.slice(2);
const k = +carefulS, LAPS = +lapsS, DT = 1 / 120;
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
function runTrack(id) {
  const track = getTrack(id), prof = buildSpeedProfile(track);
  const settings = new Settings(); const input = new Input(settings);
  const car = new Vehicle(1); car.setFuel(40); car.fitTyres('medium', 80);
  Object.assign(car.assists, { abs: 0, tc: +(process.env.TC ?? 1), steer: +(process.env.SA ?? 1), autoGear: true });
  car.applySetup(); car.pt.auto = true; car.d = { isPlayer: true };
  const slot = track.gridSlot(0); car.place(track, slot.s, slot.n, 0);
  const cs = new CollisionSystem(); const ENV = { water: 0, tAir: 25, tTrack: 35, wearMult: 1 };
  const delay = []; let t = 0, acc = 0, tapT = 0, duty = 0, steerSign = 0, thrKey = false, brkKey = false;
  let sTarget = 0; let laps = 0, last = car.loc.s, lapStart = 0, lapTimes = [], offT = 0, hits = 0, maxSlip = 0, wallHits = 0;
  while (t < prof.lapTime * (LAPS + 1.6) * 1.35 && laps < LAPS + 1) {
    // sense (delayed)
    delay.push({ r: car.r, x: car.x, z: car.z, psi: car.psi, v: car.speed, s: car.loc.s, n: car.loc.n }); if (delay.length > 18) delay.shift();
    acc += DT;
    if (acc >= 0.05) {
      acc = 0;
      const o = delay[0];   // ~150 ms old
      const i = Math.round(o.s / track.ds) % track.N;
      const look = 14 + 0.55 * o.v, iL = (i + Math.round(look / track.ds)) % track.N;
      const nT = track.line[iL] * 0.9;
      const px = track.x[iL] + Math.cos(track.psi[iL]) * nT, pz = track.z[iL] - Math.sin(track.psi[iL]) * nT;
      const ang = wrapPi(Math.atan2(px - o.x, pz - o.z) - o.psi);   // + = target is to the left
      const Ld = Math.max(8, look);
      const deltaDes = Math.atan((2 * 3.6 * Math.sin(ang)) / Ld);          // pure pursuit steer angle (rad), + = left
      sTarget = clamp(deltaDes / car.steerLock(), -1, 1);
      let vt = 1e9;                                           // brake early enough for every corner within ~170 m (comfortable 14 m/s^2)
      for (let m = 0; m < 85; m += 2) vt = Math.min(vt, Math.sqrt((prof.v[(i + m) % track.N] * k) ** 2 + 2 * 14 * m * track.ds));
      thrKey = o.v < vt - 1.5; brkKey = o.v > vt + 3;
    }
    // the driver watches the wheel (current keyboard-steer value) and holds / releases the key to approach the wanted value
    input.down.clear();
    const kb = input.kbSteer;
    if (sTarget - kb > 0.07) input.down.add('left:Key'); else if (kb - sTarget > 0.07) input.down.add('right:Key');
    if (thrKey && !brkKey) input.down.add('throttle:Key');
    if (brkKey) input.down.add('brake:Key');
    if (Math.floor(t / 0.0166) !== Math.floor((t - DT) / 0.0166)) input.update(0.0166, car.speed);
    const st = input.state;
    if (process.env.ANALOG) { st.steer = sTarget; st.throttle = thrKey && !brkKey ? 1 : 0; st.brake = brkKey ? 1 : 0; }   // idealised analog driver (reference)
    if (process.env.DISC && car.speed < 45) st.throttle = Math.min(st.throttle, clamp(1.25 - 1.6 * Math.abs(st.steer), 0.15, 1));   // a driver that lifts while the wheel is turned
    car.ctrl.steer = st.steer; car.ctrl.throttle = st.throttle; car.ctrl.brake = st.brake;
    car.step(DT, track, ENV); t += DT;
    cs.clearEvents(); cs.update([car], 1, track, DT);
    for (const e of cs.events) if (e.energy > 25000) { if (process.env.HITS) console.log('HIT t=' + t.toFixed(1) + ' s=' + (car.loc.s | 0) + ' n=' + car.loc.n.toFixed(1) + ' v=' + car.speed.toFixed(0) + ' st=' + st.steer.toFixed(2)); hits++; if (e.wall) wallHits++; }
    const slip = Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 1))); if (car.speed > 20) maxSlip = Math.max(maxSlip, slip);
    const edge = car.loc.n >= 0 ? track.wl[car.loc.i] : track.wr[car.loc.i]; if (Math.abs(car.loc.n) - edge > 0.5) offT += DT;
    if (last > track.length * 0.9 && car.loc.s < track.length * 0.1) { if (t - lapStart > 30) { laps++; lapTimes.push(+(t - lapStart).toFixed(1)); } lapStart = t; } last = car.loc.s;
    if (process.env.TRACE && Math.floor(t*10)!==Math.floor((t-DT)*10) && t<(+process.env.TRACE_T||12)) console.log(t.toFixed(2),'s',car.loc.s|0,'n',car.loc.n.toFixed(1),'v',car.speed.toFixed(1),'st',st.steer.toFixed(2),'th',st.throttle.toFixed(2),'br',st.brake.toFixed(2),'gear',car.pt.gear);
    if (car.retired) break;
  }
  console.log(`${id.padEnd(12)} k=${k} laps=${laps} times=[${lapTimes.join(', ')}] aiRef=${prof.lapTime.toFixed(1)} offTrack=${offT.toFixed(1)}s hardHits=${hits} (wall ${wallHits}) maxSlip=${maxSlip.toFixed(2)}${car.retired ? ' RETIRED: ' + car.retireReason : ''}`);
}
for (const c of CIRCUITS) if (which === 'all' || which === c.id) runTrack(c.id);
