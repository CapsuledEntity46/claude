/** Deterministic, seedable randomness — world generation must be reproducible. */

/** Hash a string into a 32-bit seed. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mix three integers into a well-distributed 32-bit value. */
export function hash3(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic float in [0,1) from a 2D coordinate. */
export const valueNoise2 = (x: number, y: number, seed: number) => hash3(x, y, seed) / 4294967296;

/** Mulberry32 — tiny, fast, good enough PRNG. */
export class RNG {
  private s: number;

  constructor(seed: number | string = Date.now()) {
    this.s = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  }

  /** Raw float in [0,1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min = 0, max = 1): number { return min + this.next() * (max - min); }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number { return Math.floor(this.float(min, max + 1)); }

  bool(chance = 0.5): boolean { return this.next() < chance; }

  sign(): number { return this.next() < 0.5 ? -1 : 1; }

  angle(): number { return this.next() * Math.PI * 2; }

  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }

  /** Weighted pick. `weight` extracts a non-negative weight from each entry. */
  weighted<T>(arr: readonly T[], weight: (t: T) => number): T {
    let total = 0;
    for (const a of arr) total += Math.max(0, weight(a));
    let r = this.next() * total;
    for (const a of arr) {
      r -= Math.max(0, weight(a));
      if (r <= 0) return a;
    }
    return arr[arr.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Approximate normal distribution (Irwin–Hall), mean 0, sd ~1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() + this.next() + this.next() - 3) / 0.7071;
  }

  /** Uniform point inside a circle. */
  inCircle(radius: number): { x: number; y: number } {
    const a = this.angle();
    const r = Math.sqrt(this.next()) * radius;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  /** Branch off an independent stream — keeps generators from desynchronising. */
  fork(tag: string): RNG { return new RNG((this.s ^ hashString(tag)) >>> 0); }
}

/** Smooth 2D value noise with fractal octaves. Deterministic per seed. */
export function fbm(x: number, y: number, seed: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let total = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    total += amp * smoothNoise(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return total / norm;
}

/** Bilinearly interpolated value noise in [0,1). */
export function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = valueNoise2(xi, yi, seed);
  const b = valueNoise2(xi + 1, yi, seed);
  const c = valueNoise2(xi, yi + 1, seed);
  const d = valueNoise2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Ridged noise — good for mountain ridges and river networks. */
export function ridged(x: number, y: number, seed: number, octaves = 4): number {
  let total = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(smoothNoise(x * freq, y * freq, seed + o * 7919) * 2 - 1);
    total += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / norm;
}
