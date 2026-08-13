/**
 * Small seeded PRNG + distribution helpers used by the demo data generator.
 *
 * Deliberately not Math.random(): a mulberry32 generator seeded from a
 * single integer produces the exact same sequence of numbers every time
 * it's constructed with the same seed, which is what lets
 * `npm run seed:demo` be deterministic (same seed -> same generated
 * dataset, on any machine, on any day).
 */

export type Rng = () => number;

/** mulberry32: fast, tiny, good-enough-for-synthetic-data seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max], inclusive on both ends. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Random float in [min, max). */
export function randomFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Pick a uniformly random element from a non-empty array. */
export function choice<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("choice() called with an empty array");
  return arr[randomInt(rng, 0, arr.length - 1)];
}

/** Pick an index according to relative weights (weights need not sum to 1). */
export function weightedIndex(rng: Rng, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

/** Fisher-Yates shuffle using the given RNG; returns a new array. */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Random Date between start (inclusive) and end (inclusive), clamped so end >= start. */
export function randomDateBetween(rng: Rng, start: Date, end: Date): Date {
  const s = start.getTime();
  const e = end.getTime();
  if (e <= s) return new Date(s);
  return new Date(s + Math.floor(rng() * (e - s)));
}
