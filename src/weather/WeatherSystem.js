// WeatherSystem: rain intensity, standing water on the track (drains/dries), temperatures, cloud/fog look.
import { clamp, makeRng } from '../core/math.js';

export const WEATHER_MODES = ['dry', 'light', 'heavy', 'dynamic'];

export class WeatherSystem {
  constructor(mode = 'dry', seed = 1, bias = 0.3, timeScale = 1) {
    this.rng = makeRng(seed * 31 + 7);
    this.mode = mode;
    this.bias = bias;            // how rain-prone the circuit is (0..1)
    this.timeScale = timeScale;  // accelerates drying/wetting so short sessions can see weather change
    this.rain = 0; this.target = 0;
    this.water = 0;              // standing water on the racing surface, 0..1
    this.cloud = 0.15;
    this.tAir = 24; this.tTrack = 38;
    this.nextChange = 90 + this.rng() * 120;
    this.timer = 0;
    this.forecast = 'dry';
    this.lightning = 0;
    this.init();
  }
  init() {
    switch (this.mode) {
      case 'light': this.target = this.rain = 0.35; this.water = 0.28; this.cloud = 0.7; break;
      case 'heavy': this.target = this.rain = 0.85; this.water = 0.7; this.cloud = 0.95; break;
      case 'dynamic': {
        const r = this.rng();
        if (r < this.bias * 0.5) { this.target = this.rain = 0.3; this.water = 0.18; this.cloud = 0.6; }
        else this.target = this.rain = 0;
        break;
      }
      default: this.target = this.rain = 0; this.cloud = 0.12;
    }
    this.updateTemps();
  }
  get wetness() { return this.water; }

  update(dt) {
    this.timer += dt;
    if (this.mode === 'dynamic' && this.timer >= this.nextChange) {
      this.timer = 0;
      this.nextChange = (80 + this.rng() * 160) / this.timeScale;
      const r = this.rng();
      const pRain = 0.25 + 0.5 * this.bias;
      if (this.target < 0.05) this.target = r < pRain ? (r < pRain * 0.35 ? 0.9 : 0.4 + this.rng() * 0.2) : 0;
      else this.target = r < 0.45 ? 0 : (r < 0.7 ? clamp(this.target + 0.35, 0.1, 1) : clamp(this.target - 0.3, 0, 1));
      this.forecast = this.target > 0.6 ? 'heavy rain' : this.target > 0.05 ? 'light rain' : 'dry';
    }
    // rain intensity follows its target smoothly
    this.rain += clamp(this.target - this.rain, -0.012 * dt * this.timeScale, 0.012 * dt * this.timeScale);
    // water film: fills with rain, drains/evaporates (faster when hot and dry)
    const fill = 0.011 * Math.pow(this.rain, 0.8) * (1 - this.water);
    const dry = 0.0007 + 0.0012 * (1 - this.rain) * (this.tTrack / 40) + 0.0006 * Math.max(0, this.water - 0.6);
    this.water = clamp(this.water + (fill - dry * (this.rain > 0.02 ? 0.35 : 1)) * dt * this.timeScale, 0, 1);
    this.cloud += clamp(clamp(0.15 + this.rain * 0.85, 0, 1) - this.cloud, -0.02 * dt, 0.02 * dt);
    this.updateTemps();
    this.lightning = this.rain > 0.75 && this.rng() < 0.0006 ? 1 : Math.max(0, this.lightning - dt * 3);
  }
  updateTemps() {
    this.tAir = 26 - 7 * this.rain - 3 * this.cloud;
    this.tTrack = 44 - 22 * this.cloud - 16 * this.water;
  }
  env(out) {
    out.water = this.water; out.tAir = this.tAir; out.tTrack = this.tTrack;
    return out;
  }
  /** recommended compound for the current conditions */
  recommendedCompound(dryChoice = 'medium') {
    if (this.water > 0.5) return 'wet';
    if (this.water > 0.14) return 'inter';
    return dryChoice;
  }
}
