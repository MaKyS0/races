// Fictional teams/drivers (no real-world names or marks).
export const TEAMS = [
  { id: 'crimson', name: 'Crimson Arrow', color: 0xd7141a, accent: 0xffffff },
  { id: 'azure', name: 'Azure Dynamics', color: 0x1f5bff, accent: 0xffd23b },
  { id: 'silver', name: 'Silverline GP', color: 0xb9c2cc, accent: 0x111111 },
  { id: 'papaya', name: 'Papaya Racing', color: 0xff8a1f, accent: 0x111111 },
  { id: 'emerald', name: 'Emerald Works', color: 0x0b8f6a, accent: 0xe8f5ef },
  { id: 'violet', name: 'Violet Storm', color: 0x6a2cc9, accent: 0xff4fd8 },
  { id: 'gold', name: 'Gold Standard', color: 0xe8b800, accent: 0x111111 },
  { id: 'ice', name: 'Ice Blue Motorsport', color: 0x57c7e8, accent: 0x0b2a5b },
  { id: 'onyx', name: 'Onyx Racing', color: 0x1a1a1f, accent: 0xff2a2a },
  { id: 'lime', name: 'Lime Velocity', color: 0xa6e12b, accent: 0x111111 },
];
const FIRST = ['Luca', 'Mika', 'Aiden', 'Tomas', 'Yuki', 'Rafael', 'Oskar', 'Daniel', 'Felix', 'Kenji', 'Marco', 'Sven', 'Andre', 'Pablo', 'Niklas', 'Hugo', 'Elias', 'Theo', 'Jonas', 'Mateo'];
const LAST = ['Varga', 'Lindqvist', 'Okada', 'Moreau', 'Haas', 'Costa', 'Novak', 'Ruiz', 'Berg', 'Tanaka', 'Rossi', 'Keller', 'Dufour', 'Silva', 'Petrov', 'Jensen', 'Santos', 'Weber', 'Aoki', 'Larsen'];
export const DRIVERS = Array.from({ length: 20 }, (_, i) => ({
  name: `${FIRST[i]} ${LAST[(i * 7 + 3) % 20]}`,
  short: LAST[(i * 7 + 3) % 20].slice(0, 3).toUpperCase(),
  number: [1, 4, 7, 11, 14, 16, 18, 20, 22, 23, 24, 27, 31, 33, 44, 55, 63, 77, 81, 99][i],
  team: i >> 1,
  // inherent pace spread (0 = fastest) - scaled by the difficulty setting
  talent: [0.1, 0.2, 0.25, 0.35, 0.45, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.82, 0.88, 0.92, 0.95, 0.97, 1, 1][i],
}));
export const DIFFICULTY = {
  rookie:  { name: 'Rookie',  skill: [0.80, 0.88], errors: 2.2, aggr: 0.35, quali: 0.9 },
  amateur: { name: 'Amateur', skill: [0.87, 0.935], errors: 1.5, aggr: 0.45, quali: 0.94 },
  pro:     { name: 'Professional', skill: [0.925, 0.975], errors: 1.0, aggr: 0.6, quali: 0.975 },
  legend:  { name: 'Legend',  skill: [0.955, 1.0], errors: 0.65, aggr: 0.75, quali: 1.0 },
};
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
