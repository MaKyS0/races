// Atmosphere: time-of-day presets per circuit (theme.time in src/track/circuits/*). One table drives the sun light, the
// hemisphere fill, the sky dome palette, the fog and the exposure, so the light on the cars always matches the sky they sit under.
import * as THREE from 'three';

const deg = Math.PI / 180;
const dir = (elev, az) => new THREE.Vector3(Math.cos(elev * deg) * Math.sin(az * deg), Math.sin(elev * deg), Math.cos(elev * deg) * Math.cos(az * deg)).normalize();

export const ATMOSPHERE = {
  // warm, clear Italian afternoon
  afternoon:        { sunDir: dir(40, 35),  sunColor: 0xfff0d8, sunI: 2.7, hemiSky: 0xcfe0f7, hemiI: 1.0,  top: 0x2a68c8, horizon: 0xc4d9ee, glow: 0xffe7c2, glowK: 0.25, exposure: 1.05, fog: 1.0 },
  // high Mediterranean sun, saturated sky, short shadows
  midday:           { sunDir: dir(58, 150), sunColor: 0xfff6e8, sunI: 2.9, hemiSky: 0xd4e5fa, hemiI: 1.05, top: 0x1d5fcc, horizon: 0xb7d3f0, glow: 0xfff0d6, glowK: 0.15, exposure: 1.02, fog: 1.1 },
  // cool forest morning, low sun and haze in the valleys
  morning:          { sunDir: dir(22, -60), sunColor: 0xffe6c6, sunI: 2.4, hemiSky: 0xc4d4e6, hemiI: 1.0,  top: 0x4a76ad, horizon: 0xcfd8e0, glow: 0xfff0dc, glowK: 0.35, exposure: 1.06, fog: 0.72, cloudBase: 0.25 },
  // bright overcast English summer: soft sun, lots of cloud, cool light
  'bright-overcast': { sunDir: dir(47, 110), sunColor: 0xf6f3ec, sunI: 2.2, hemiSky: 0xd6dee8, hemiI: 1.15, top: 0x5b84b8, horizon: 0xd2dbe3, glow: 0xf6f1e8, glowK: 0.12, exposure: 1.06, fog: 0.9, cloudBase: 0.42 },
  // late-afternoon gold, long shadows
  golden:           { sunDir: dir(17, -25), sunColor: 0xffd29a, sunI: 2.6, hemiSky: 0xc9d4e4, hemiI: 0.95, top: 0x3a66a6, horizon: 0xeed6b4, glow: 0xffc27a, glowK: 0.55, exposure: 1.04, fog: 0.95, cloudTint: 0xfff0dc },
  // desert dusk: low orange sun, violet zenith, warm haze
  dusk:             { sunDir: dir(9, 70),   sunColor: 0xffa865, sunI: 2.3, hemiSky: 0xb8b5cf, hemiI: 0.95, top: 0x34477a, horizon: 0xf0b07c, glow: 0xff9a55, glowK: 0.8, exposure: 1.12, fog: 0.85, cloudTint: 0xffd6c0 },
};

export function atmosphereFor(theme = {}) { return ATMOSPHERE[theme.time] || ATMOSPHERE.afternoon; }
