/** Small seeded PRNG (mulberry32). Deterministic across reloads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of an integer pair to [0, 1). Used for per-column decisions. */
export function hash2i(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRAD3: readonly (readonly [number, number, number])[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Classic Perlin noise over a seeded permutation table.
 * Returns roughly [-1, 1].
 */
export class Noise {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private grad(hash: number, x: number, y: number, z: number): number {
    const g = GRAD3[hash % 12];
    return g[0] * x + g[1] * y + g[2] * z;
  }

  noise3(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const fz = z - Math.floor(z);
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const p = this.perm;

    const A = p[X] + Y;
    const B = p[X + 1] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;

    return lerp(
      lerp(
        lerp(this.grad(p[AA], fx, fy, fz), this.grad(p[BA], fx - 1, fy, fz), u),
        lerp(this.grad(p[AB], fx, fy - 1, fz), this.grad(p[BB], fx - 1, fy - 1, fz), u),
        v,
      ),
      lerp(
        lerp(this.grad(p[AA + 1], fx, fy, fz - 1), this.grad(p[BA + 1], fx - 1, fy, fz - 1), u),
        lerp(this.grad(p[AB + 1], fx, fy - 1, fz - 1), this.grad(p[BB + 1], fx - 1, fy - 1, fz - 1), u),
        v,
      ),
      w,
    );
  }

  noise2(x: number, z: number): number {
    return this.noise3(x, 0.137, z);
  }

  /** Fractal Brownian motion over noise2. Result stays in about [-1, 1]. */
  fbm2(x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2(x * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged variant, good for mountain spines. Returns [0, 1]. */
  ridged2(x: number, z: number, octaves = 4): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise2(x * freq, z * freq));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
