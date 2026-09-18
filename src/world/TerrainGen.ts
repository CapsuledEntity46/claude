import { Block } from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from './Chunk';
import { Noise, hash2i } from './noise';
import { DungeonGenerator } from './Dungeon';

export const SEA_LEVEL = 27;

export const enum Biome {
  Plains,
  Forest,
  Desert,
  Tundra,
  Mountains,
}

/**
 * Procedural terrain: layered noise for elevation, a temperature field for
 * biomes, intersecting 3D noise for cave tunnels, plus ores and trees.
 *
 * Everything is a pure function of (seed, world coords), so a save only needs to
 * store the seed and the player's block edits.
 */
export class TerrainGen {
  readonly seed: number;
  private readonly elevation: Noise;
  private readonly detail: Noise;
  private readonly mountain: Noise;
  private readonly temperature: Noise;
  private readonly caveA: Noise;
  private readonly caveB: Noise;
  private readonly oreNoise: Noise;

  /** Column height cache — the mesher and tree pass query the same columns a lot. */
  private heightCache = new Map<number, number>();

  /** Underground structures, carved after the natural terrain is laid down. */
  readonly dungeons: DungeonGenerator;

  constructor(seed: number) {
    this.seed = seed | 0;
    this.elevation = new Noise(seed + 1);
    this.detail = new Noise(seed + 2);
    this.mountain = new Noise(seed + 3);
    this.temperature = new Noise(seed + 4);
    this.caveA = new Noise(seed + 5);
    this.caveB = new Noise(seed + 6);
    this.oreNoise = new Noise(seed + 7);
    this.dungeons = new DungeonGenerator(seed);
  }

  /** Highest terrain block (pre-cave, pre-tree) for a world column. */
  surfaceHeight(wx: number, wz: number): number {
    // Pack coords into one key; world is bounded well inside +/-32k.
    const key = ((wx + 32768) << 16) | (wz + 32768);
    const cached = this.heightCache.get(key);
    if (cached !== undefined) return cached;

    // Biased above sea level: centring the continent noise on the waterline makes
    // roughly half the world beach, which reads as a flat, sandy nothing. Sitting
    // it higher keeps lakes and coasts as features rather than the default.
    const continents = this.elevation.fbm2(wx * 0.0055, wz * 0.0055, 4);
    let h = 34 + continents * 12;

    // Rolling hills.
    h += this.detail.fbm2(wx * 0.021, wz * 0.021, 3) * 6;

    // Mountains only where the mask is high, so ranges are localised.
    const mask = this.mountain.fbm2(wx * 0.0032, wz * 0.0032, 2);
    if (mask > 0.1) {
      const strength = Math.min(1, (mask - 0.1) / 0.38);
      h += this.mountain.ridged2(wx * 0.011, wz * 0.011, 4) * 24 * strength;
    }

    const result = Math.max(4, Math.min(CHUNK_SY - 9, Math.round(h)));
    if (this.heightCache.size > 400_000) this.heightCache.clear();
    this.heightCache.set(key, result);
    return result;
  }

  biomeAt(wx: number, wz: number): Biome {
    const h = this.surfaceHeight(wx, wz);
    if (h > 52) return Biome.Mountains;
    const temp = this.temperature.fbm2(wx * 0.0042, wz * 0.0042, 3);
    if (temp > 0.34) return Biome.Desert;
    if (temp < -0.34) return Biome.Tundra;
    const forest = this.temperature.noise2(wx * 0.014 + 100, wz * 0.014 - 60);
    return forest > 0.06 ? Biome.Forest : Biome.Plains;
  }

  /** True where a cave tunnel hollows out the rock. */
  private isCave(wx: number, y: number, wz: number): boolean {
    if (y < 3 || y > 56) return false;
    // Two independent noise fields near zero: their intersection forms worm-like
    // tunnels rather than the swiss-cheese look of a single threshold.
    const a = this.caveA.noise3(wx * 0.028, y * 0.05, wz * 0.028);
    const b = this.caveB.noise3(wx * 0.028, y * 0.05, wz * 0.028);
    return a * a + b * b < 0.0034;
  }

  private oreAt(wx: number, y: number, wz: number): Block | null {
    if (y > 38) return null;
    const n = this.oreNoise.noise3(wx * 0.14, y * 0.14, wz * 0.14);
    if (y < 20 && n > 0.74) return Block.GoldOre;
    if (n > 0.62) return Block.IronOre;
    return null;
  }

  /** Fills a chunk's voxel array, then re-applies any saved player edits. */
  generate(chunk: Chunk): void {
    const vox = chunk.voxels;
    vox.fill(Block.Air);
    const baseX = chunk.cx * CHUNK_SX;
    const baseZ = chunk.cz * CHUNK_SZ;

    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const h = this.surfaceHeight(wx, wz);
        const biome = this.biomeAt(wx, wz);

        const surface = surfaceBlock(biome, h);
        const subsurface = biome === Biome.Desert ? Block.Sand : Block.Dirt;
        const soilDepth = biome === Biome.Desert ? 4 : 3;

        for (let y = 0; y <= Math.max(h, SEA_LEVEL); y++) {
          let id: number;

          if (y === 0) {
            id = Block.Bedrock;
          } else if (y > h) {
            // Above ground but below sea level: fill with water.
            id = y <= SEA_LEVEL ? Block.Water : Block.Air;
          } else if (y === h) {
            id = h <= SEA_LEVEL + 1 ? Block.Sand : surface;
          } else if (y >= h - soilDepth) {
            id = h <= SEA_LEVEL + 1 ? Block.Sand : subsurface;
          } else {
            id = this.oreAt(wx, y, wz) ?? Block.Stone;
          }

          // Carve caves, but never breach the seabed (avoids draining oceans).
          if (id !== Block.Air && id !== Block.Water && id !== Block.Bedrock && this.isCave(wx, y, wz)) {
            if (!(h <= SEA_LEVEL + 1 && y > h - 4)) id = Block.Air;
          }

          if (id !== Block.Air) vox[voxelIndex(lx, y, lz)] = id;
        }
      }
    }

    this.placeTrees(chunk);

    // Dungeons are cut into the finished terrain, then player edits go on top so
    // anything you have built or mined always wins.
    this.dungeons.carve(chunk);

    chunk.applyEdits();
    chunk.recomputeHeightMap();
  }

  /**
   * Trees are generated for a margin of columns *outside* the chunk as well, and
   * only the voxels landing inside get written. That way a trunk near a border
   * still grows its canopy across the seam without inter-chunk messaging.
   */
  private placeTrees(chunk: Chunk): void {
    const margin = 3;
    const baseX = chunk.cx * CHUNK_SX;
    const baseZ = chunk.cz * CHUNK_SZ;
    const vox = chunk.voxels;

    const put = (wx: number, y: number, wz: number, id: Block, overwrite: boolean) => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 0 || y >= CHUNK_SY) return;
      const i = voxelIndex(lx, y, lz);
      if (!overwrite && vox[i] !== Block.Air) return;
      vox[i] = id;
    };

    for (let wz = baseZ - margin; wz < baseZ + CHUNK_SZ + margin; wz++) {
      for (let wx = baseX - margin; wx < baseX + CHUNK_SX + margin; wx++) {
        const biome = this.biomeAt(wx, wz);
        const density = biome === Biome.Forest ? 0.055 : biome === Biome.Plains ? 0.008 : 0;
        if (density === 0) continue;
        if (hash2i(wx, wz, this.seed ^ 0x5eed) >= density) continue;

        const h = this.surfaceHeight(wx, wz);
        if (h <= SEA_LEVEL + 1 || h > 50) continue;

        const trunk = 4 + Math.floor(hash2i(wx, wz, this.seed ^ 0xa11) * 3);
        const topY = h + trunk;

        // Canopy: a squashed sphere with a deterministic ragged edge.
        for (let dy = -2; dy <= 2; dy++) {
          const radius = dy === 2 ? 1 : dy === -2 ? 2 : 2.6;
          for (let dz = -3; dz <= 3; dz++) {
            for (let dx = -3; dx <= 3; dx++) {
              const d = Math.sqrt(dx * dx + dz * dz + dy * dy * 1.6);
              if (d > radius) continue;
              if (d > radius - 0.9 && hash2i(wx + dx * 7, wz + dz * 13 + dy * 31, this.seed) < 0.35) continue;
              put(wx + dx, topY + dy, wz + dz, Block.Leaves, false);
            }
          }
        }
        for (let y = h; y <= topY; y++) put(wx, y, wz, Block.Wood, true);
      }
    }
  }
}

function surfaceBlock(biome: Biome, h: number): Block {
  switch (biome) {
    case Biome.Desert:
      return Block.Sand;
    case Biome.Tundra:
      return Block.Snow;
    case Biome.Mountains:
      return h > 58 ? Block.Snow : Block.Stone;
    default:
      return Block.Grass;
  }
}
