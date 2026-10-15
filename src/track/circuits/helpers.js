// Turtle helpers: positive angle = left turn, negative = right turn.
export const S = (len) => ['S', len];
export const L = (r, deg, o) => ['C', r, Math.abs(deg), o];
export const R = (r, deg, o) => ['C', r, -Math.abs(deg), o];
