// Seeds + seeded PRNG. All randomness in the app goes through here — never Math.random.

/** Fresh 128-bit seed from crypto.getRandomValues, as 32 lowercase hex chars. */
export function newSeed(): string {
  const words = new Uint32Array(4);
  crypto.getRandomValues(words);
  return Array.from(words, (w) => w.toString(16).padStart(8, "0")).join("");
}

export function isValidSeed(seed: string): boolean {
  return /^[0-9a-f]{32}$/.test(seed);
}

export type Rng = {
  /** Float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
};

/** sfc32 seeded from a 128-bit hex seed. */
export function createRng(seed: string): Rng {
  if (!isValidSeed(seed)) throw new Error(`Invalid seed: ${seed}`);
  let a = parseInt(seed.slice(0, 8), 16) >>> 0;
  let b = parseInt(seed.slice(8, 16), 16) >>> 0;
  let c = parseInt(seed.slice(16, 24), 16) >>> 0;
  let d = parseInt(seed.slice(24, 32), 16) >>> 0;

  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4294967296;
  };

  // Warm up so similar seeds diverge quickly.
  for (let i = 0; i < 15; i++) next();

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}
