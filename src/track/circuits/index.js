import monza from './monza.js';
import monaco from './monaco.js';
import spa from './spa.js';
import silverstone from './silverstone.js';
import suzuka from './suzuka.js';
import bahrain from './bahrain.js';
import { Track } from '../TrackSystem.js';

export const CIRCUITS = [monaco, monza, spa, silverstone, suzuka, bahrain];
const cache = new Map();
export function getTrack(id) {
  if (!cache.has(id)) {
    const def = CIRCUITS.find((c) => c.id === id) || CIRCUITS[0];
    cache.set(def.id, new Track(def));
  }
  return cache.get(id) || cache.get(CIRCUITS[0].id);
}
