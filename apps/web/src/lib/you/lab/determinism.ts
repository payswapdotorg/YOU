// ═══════════════════════════════════════════════════════════════════════════
// Deterministic primitives for the Lab (Worker C lane).
// Lab worlds, genomes, benchmarks and the SVG renderer must be reproducible:
// same seed (and same inputs) → byte-identical outputs. No Math.random, no
// Date.now inside any deterministic path.
// ═══════════════════════════════════════════════════════════════════════════

/** mulberry32 — small, fast, well-distributed seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeededRandom {
  /** float in [0, 1) */
  next(): number;
  /** integer in [minInclusive, maxInclusive] */
  int(min: number, max: number): number;
  /** float in [min, max) */
  float(min: number, max: number): number;
  /** true with probability p */
  chance(p: number): boolean;
  /** pick one element */
  pick<T>(items: readonly T[]): T;
  /** deterministic key derived from the current PRNG state */
  snapshot(): number;
}

export function makeRng(seed: number): SeededRandom {
  const base = mulberry32(seed);
  return {
    next: base,
    int: (min, max) => Math.floor(base() * (max - min + 1)) + min,
    float: (min, max) => base() * (max - min) + min,
    chance: (p) => base() < p,
    pick: (items) => items[Math.floor(base() * items.length)],
    snapshot: () => base() * 2 ** 31,
  };
}

/** FNV-1a 32-bit string hash — stable across processes/versions. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable JSON: keys sorted recursively, so object key order never breaks determinism. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
