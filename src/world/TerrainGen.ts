import { Block } from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from './Chunk';
import { Noise, hash2i, mulberry32 } from './noise';

/**
 * The waterline.
 *
 * High in a 160-block world on purpose: it leaves roughly 60 blocks of water
 * column below and 95 above, so oceans are deep enough to dive into and
 * mountains have somewhere to go. The old 27-in-72 left neither.
 */
export const SEA_LEVEL = 62;

/** Hard floor and ceiling for any generated column. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = CHUNK_SY - 8;

/** Terrain above this is bare rock and then snow, whatever the biome says. */
const TREE_LINE = 104;
const SNOW_LINE = 118;

/**
 * Largest horizontal distance, in blocks, that any tree may write from its trunk.
 *
 * This is a contract, not an observation. Chunks grow the trees of their neighbours
 * and clip what falls outside, which only produces a seamless canopy while the
 * margin of columns each chunk evaluates is at least this wide — so the widest crown
 * and the longest limb-plus-cluster in `placeTrees` both have to stay inside it. The
 * jungle giant is the binding case at 4 blocks of limb plus a 2.6-block cluster.
 */
const MAX_TREE_REACH = 7;

/**
 * The largest value `treeDensity` returns.
 *
 * Lets the tree pass reject a column with one integer hash, before paying for the
 * biome lookup that would tell it the real density. Understating it silently stops
 * the densest biome's trees from spawning, which is why a unit check holds the two
 * together rather than a comment asking the next person to remember.
 */
export const MAX_TREE_DENSITY = 0.017;

export const enum Biome {
  Plains,
  Forest,
  Desert,
  Tundra,
  Mountains,
  /** Open water. */
  Ocean,
  /** The sand strip where a continent meets the sea. */
  Beach,
  /** Banded rock, home of the canyons. */
  Badlands,
  /** Dense trees and the pillars that rise out of them. */
  Jungle,
  /** Low, wet, pond-pocked woodland. */
  Wetland,
}

/**
 * Procedural terrain, shaped in the spirit of the Tectonic world generator.
 *
 * The guiding idea is that a height is not one noise field but a *negotiation*
 * between several, each answering a different question:
 *
 * - `continent` — is this ocean or land, at the scale of thousands of blocks?
 * - `erosion`   — how worn down is this region? High erosion flattens; low
 *                 erosion lets mountains and plateaus survive.
 * - `ranges`    — where do mountain spines run? Ridged noise, so they form long
 *                 connected chains rather than isolated lumps.
 * - `terrace`   — where does the ground step up in plateaus instead of sloping?
 *
 * Composing them is what produces terrain with *regions* — a coastal plain that
 * climbs into foothills and then into a range, rather than uniform noise at one
 * amplitude everywhere. A single fbm field, however many octaves, always reads
 * as the same texture repeated to the horizon.
 *
 * Everything is a pure function of (seed, world coords), so a save stores only
 * the seed and the player's block edits.
 */
export class TerrainGen {
  readonly seed: number;
  private readonly continent: Noise;
  private readonly erosion: Noise;
  private readonly ranges: Noise;
  private readonly detail: Noise;
  private readonly terrace: Noise;
  private readonly temperature: Noise;
  private readonly humidity: Noise;
  private readonly island: Noise;
  private readonly trench: Noise;
  private readonly canyon: Noise;
  private readonly pillar: Noise;
  private readonly caveA: Noise;
  private readonly caveB: Noise;
  private readonly riverNoise: Noise;
  private readonly oreNoise: Noise;

  /** Column height cache — the mesher and tree pass query the same columns a lot. */
  private heightCache = new Map<number, number>();
  /** Column biome cache. Biome depends on height, so this saves a second climb. */
  private biomeCache = new Map<number, Biome>();

  constructor(seed: number) {
    this.seed = seed | 0;
    this.continent = new Noise(seed + 1);
    this.erosion = new Noise(seed + 2);
    this.ranges = new Noise(seed + 3);
    this.detail = new Noise(seed + 4);
    this.terrace = new Noise(seed + 5);
    this.temperature = new Noise(seed + 6);
    this.humidity = new Noise(seed + 7);
    this.island = new Noise(seed + 8);
    this.trench = new Noise(seed + 9);
    this.canyon = new Noise(seed + 10);
    this.pillar = new Noise(seed + 11);
    this.caveA = new Noise(seed + 12);
    this.caveB = new Noise(seed + 13);
    this.riverNoise = new Noise(seed + 14);
    this.oreNoise = new Noise(seed + 15);
  }

  private key(wx: number, wz: number): number {
    // Pack coords into one key; world is bounded well inside +/-32k.
    return ((wx + 32768) << 16) | (wz + 32768);
  }

  /**
   * How continental this column is, in roughly -1..1.
   *
   * The frequency is the headline number of the whole generator: 0.00042 puts a
   * continent's half-width at something like 1200 blocks, so crossing one is a
   * journey rather than a stroll, and the ocean between two of them is open
   * water you have to commit to.
   */
  private continentalness(wx: number, wz: number): number {
    return this.continent.fbm2(wx * 0.00042, wz * 0.00042, 4);
  }

  /** Whether the continent field puts this column out at sea. */
  isOceanRegion(wx: number, wz: number): boolean {
    return this.continentalness(wx, wz) < -0.02;
  }

  /** 0 = pristine and craggy, 1 = worn flat. */
  private erosionAt(wx: number, wz: number): number {
    return (this.erosion.fbm2(wx * 0.0016, wz * 0.0016, 3) + 1) * 0.5;
  }

  /** Highest terrain block (pre-cave, pre-tree) for a world column. */
  surfaceHeight(wx: number, wz: number): number {
    const key = this.key(wx, wz);
    const cached = this.heightCache.get(key);
    if (cached !== undefined) return cached;

    const h = this.computeHeight(wx, wz);
    const result = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h)));
    // Both caches are cleared together so they cannot disagree about a column.
    if (this.heightCache.size > 400_000) {
      this.heightCache.clear();
      this.biomeCache.clear();
    }
    this.heightCache.set(key, result);
    return result;
  }

  private computeHeight(wx: number, wz: number): number {
    const c = this.continentalness(wx, wz);

    // --- ocean ----------------------------------------------------------
    //
    // Everything below the shelf threshold is sea floor, and the floor itself is
    // shaped rather than flat: a trench field digs the deep basins out while
    // island noise lifts occasional land back above the waterline.
    if (c < -0.02) {
      // 0 at the shelf edge, 1 in the deepest water.
      //
      // The divisor is the one that decides whether oceans are deep at all. An
      // fbm field spends very little of its range near the extremes, so asking
      // for c <= -0.44 before the floor bottomed out meant 0.1% of the world was
      // deep water and the rest was shelf. Reaching full depth by -0.27 puts
      // real basins between the continents.
      const depth = Math.min(1, (-0.02 - c) / 0.25);
      const trench = this.trench.fbm2(wx * 0.004, wz * 0.004, 3);
      // Deep ocean floors sit down in the stone layer, and the ±10 of trench
      // noise gives them the valleys and rises that make diving worth doing.
      let floor = SEA_LEVEL - 6 - depth * 46 + trench * 10;

      // Islands: a sparse ridged field, only out past the shelf. Raised to a
      // power so the islands are small and distinct instead of a shoal of lumps
      // covering the whole ocean.
      const islandField = this.island.ridged2(wx * 0.0022, wz * 0.0022, 3);
      const islandMask = Math.max(0, islandField - 0.52) / 0.48;
      if (islandMask > 0) {
        const lift = Math.pow(islandMask, 1.6) * 46 * Math.min(1, depth * 2.2);
        floor += lift;
        // Islands get their own small relief so they are not smooth domes.
        if (lift > 6) floor += this.detail.fbm2(wx * 0.03, wz * 0.03, 3) * 4;
      }
      return Math.min(floor, SEA_LEVEL + 34);
    }

    // --- land -----------------------------------------------------------
    const erosion = this.erosionAt(wx, wz);
    // Coast rises out of the water over the first slice of continentalness, so
    // beaches are a transition and not a cliff.
    const coast = Math.min(1, (c + 0.02) / 0.1);
    let h = SEA_LEVEL - 2 + coast * 10;

    // Rolling ground. Eroded regions stay gentle; uneroded ones are lumpier.
    h += this.detail.fbm2(wx * 0.013, wz * 0.013, 4) * (5 + (1 - erosion) * 10);

    // --- mountain ranges ------------------------------------------------
    //
    // A ridged field at very low frequency gives long connected spines; the mask
    // is cut off well above zero so ranges occupy a minority of the land and
    // mean something when you reach one.
    const spine = this.ranges.ridged2(wx * 0.0011, wz * 0.0011, 4);
    const rangeMask = Math.max(0, spine - 0.42) / 0.58;
    if (rangeMask > 0) {
      // Erosion decides whether a range is a worn ridge or a wall of rock.
      const relief = 30 + (1 - erosion) * 62;
      // Cubed: the spine stays narrow and the foothills fall away quickly, which
      // is what makes a range read as a range rather than a plateau.
      h += Math.pow(rangeMask, 1.5) * relief * coast;
      // Craggy detail only up high, so the peaks are jagged but the plains are not.
      h += this.ranges.ridged2(wx * 0.016, wz * 0.016, 3) * 10 * Math.pow(rangeMask, 2);
    }

    // --- plateaus -------------------------------------------------------
    //
    // Quantising the height into steps is what makes a plateau: the ground holds
    // a level, then jumps. The ramp term blends part of the way back to the
    // smooth height so the steps are climbable instead of sheer everywhere.
    const biomeForShaping = this.biomeFromFields(wx, wz, h, c);
    // Terracing is wrong for anything whose character is smoothness. Applied
    // everywhere it quantised the dunes into flat benches with sheer one-block
    // steps, so deserts came out looking like quarries rather than sand.
    const terraces =
      biomeForShaping === Biome.Plains ||
      biomeForShaping === Biome.Forest ||
      biomeForShaping === Biome.Badlands ||
      biomeForShaping === Biome.Tundra;
    const terraceField = this.terrace.fbm2(wx * 0.0021, wz * 0.0021, 2);
    const terraceMask = Math.max(0, terraceField - 0.42) / 0.58;
    if (terraces && terraceMask > 0.001 && rangeMask < 0.5) {
      const step = 13;
      const stepped = Math.round(h / step) * step;

      // The blend has to be *mostly 0 or 1*, not a middling value.
      //
      // Blending halfway towards a quantised height does not give a gentler
      // plateau: it gives twice as many steps, half as tall. The first version
      // used the mask directly and turned every grassy hillside into a flight of
      // one-block stairs. A smoothstep keeps the plateau tops genuinely flat and
      // confines the transition to the rim.
      const t = Math.min(1, Math.max(0, (terraceMask - 0.12) / 0.3));
      let blend = t * t * (3 - 2 * t);

      // Ramps: where this slow field is high the terracing is nearly switched
      // off, which leaves a walkable slope up the side of the plateau instead of
      // a sheer wall all the way round.
      const ramp = this.terrace.noise2(wx * 0.009 + 50, wz * 0.009 - 20);
      if (ramp > 0.3) blend *= Math.max(0, 1 - (ramp - 0.3) / 0.35);

      h = h + (stepped - h) * blend;
    }

    const biome = biomeForShaping;

    // --- dunes ----------------------------------------------------------
    //
    // Deserts get smooth, rolling dunes: two offset low-frequency fields rather
    // than fbm, because fbm's high octaves add exactly the grit that stops sand
    // reading as sand.
    if (biome === Biome.Desert) {
      // Three scales of smooth hump: long drifts, dunes, and ripples on their
      // flanks. All plain noise2 rather than fbm, because fbm's high octaves add
      // exactly the grit that stops sand reading as sand.
      //
      // The amplitudes fall off faster than the frequencies rise, which is what
      // keeps the gradient shallow. Weighting them evenly produced sand with
      // vertical faces in it — dunes do not have cliffs.
      const drift = this.detail.noise2(wx * 0.0062 - 60, wz * 0.0062 + 30);
      const dune = this.detail.noise2(wx * 0.016, wz * 0.016);
      const ripple = this.detail.noise2(wx * 0.04 + 11, wz * 0.04 - 7);
      h += drift * 13 + dune * 5 + ripple * 1.5;
    }

    // --- canyons --------------------------------------------------------
    //
    // Carved rather than built: a narrow ridged channel subtracted from the
    // badlands. Subtracting is what gives the sheer walls — adding height
    // produces mesas, which is a different landscape.
    if (biome === Biome.Badlands) {
      const channel = this.canyon.ridged2(wx * 0.0034, wz * 0.0034, 3);
      const cut = Math.max(0, channel - 0.56) / 0.44;
      if (cut > 0) h -= Math.pow(cut, 0.7) * 44;
      // Isolated spires standing in the canyon floor.
      const spire = this.canyon.ridged2(wx * 0.02 + 90, wz * 0.02 - 40, 2);
      if (spire > 0.88) h += (spire - 0.88) * 150;
    }

    // --- jungle pillars -------------------------------------------------
    //
    // Tall, near-vertical columns. The mask is thresholded very high so they are
    // rare and slender; a lower cut-off turns the whole jungle into a plateau.
    if (biome === Biome.Jungle) {
      const field = this.pillar.ridged2(wx * 0.022, wz * 0.022, 2);
      const mask = Math.max(0, field - 0.66) / 0.34;
      if (mask > 0) h += Math.pow(mask, 0.5) * 62;
      // A second, finer set so the skyline has pillars of two different
      // thicknesses. One field alone gave a jungle either smothered in pillars
      // or with none at all, depending entirely on where the threshold sat.
      const fine = this.pillar.ridged2(wx * 0.055 + 200, wz * 0.055 - 140, 2);
      const fineMask = Math.max(0, fine - 0.82) / 0.18;
      if (fineMask > 0) h += Math.pow(fineMask, 0.6) * 34;
    }

    // --- wetlands -------------------------------------------------------
    //
    // Pressed down towards the waterline and pitted with hollows, so water
    // collects in ponds. The clamp keeps them from becoming one large lake.
    if (biome === Biome.Wetland) {
      h = SEA_LEVEL + 1 + (h - SEA_LEVEL) * 0.12;
      const pond = this.detail.noise2(wx * 0.035 + 310, wz * 0.035 - 210);
      if (pond < -0.22) h -= 2 + (-0.22 - pond) * 8;
    }

    return h;
  }

  /**
   * Biome from the climate fields, taking the height as an argument.
   *
   * Separated from `biomeAt` so `computeHeight` can ask which biome a column is
   * in *while* it is still deciding the height — dunes, canyons and pillars are
   * all biome-specific shaping. The height passed in is the pre-shaping value,
   * which is enough to tell ocean from mountain.
   */
  private biomeFromFields(wx: number, wz: number, h: number, c: number): Biome {
    if (c < -0.02 && h <= SEA_LEVEL) return Biome.Ocean;
    if (h <= SEA_LEVEL + 1) return Biome.Beach;
    if (h > TREE_LINE) return Biome.Mountains;

    const temp = this.temperature.fbm2(wx * 0.0019, wz * 0.0019, 3);
    const wet = this.humidity.fbm2(wx * 0.0023 + 70, wz * 0.0023 - 90, 3);

    // Thresholds sit close to zero because an fbm field keeps most of its mass
    // there. At ±0.3 the hot band covered 2% of the land between three biomes,
    // which left dunes, canyons and jungle pillars effectively unreachable —
    // terrain features nobody will ever see are not features.
    if (temp < -0.2) return Biome.Tundra;
    if (temp > 0.08) {
      // Hot: dry becomes desert, middling becomes badlands, wet becomes jungle.
      if (wet < -0.1) return Biome.Desert;
      if (wet < 0.12) return Biome.Badlands;
      return Biome.Jungle;
    }
    // Temperate: low ground that is also wet becomes marsh.
    if (wet > 0.14 && h < SEA_LEVEL + 10) return Biome.Wetland;
    if (wet > 0.02) return Biome.Forest;
    return Biome.Plains;
  }

  biomeAt(wx: number, wz: number): Biome {
    const key = this.key(wx, wz);
    const cached = this.biomeCache.get(key);
    if (cached !== undefined) return cached;

    const h = this.surfaceHeight(wx, wz);
    const c = this.continentalness(wx, wz);
    // Re-derived from the final height, so what the surface is made of agrees
    // with how tall it actually ended up.
    let biome = this.biomeFromFields(wx, wz, h, c);
    if (c < -0.02 && h <= SEA_LEVEL) biome = Biome.Ocean;
    else if (h > TREE_LINE) biome = Biome.Mountains;
    // Badlands keep their identity even where a canyon has cut the floor below
    // the waterline. Reclassifying those columns as beach put sand along the
    // bottom of every canyon and stopped the strata being drawn on its walls —
    // the river in the floor is wanted, the beach is not.
    else if (h <= SEA_LEVEL + 1 && biome !== Biome.Badlands) biome = Biome.Beach;
    this.biomeCache.set(key, biome);
    return biome;
  }

  /** True where a cave tunnel hollows out the rock. */
  private isCave(wx: number, y: number, wz: number): boolean {
    // Bounded well below the mountain tops: carving caves through a 150-block
    // peak costs two 3D noise samples per voxel for holes nobody will stand in,
    // and that cost is multiplied by the whole height of every range.
    if (y < 3 || y > 86) return false;
    // Two independent noise fields near zero: their intersection forms worm-like
    // tunnels rather than the swiss-cheese look of a single threshold.
    //
    // The first field alone decides the answer most of the time: the test needs
    // a² + b² < 0.0034, so any |a| at or above 0.058 rules the voxel out whatever
    // b turns out to be. Checking that before sampling the second field skips it
    // for about 94% of voxels, which is most of the generator's cost — this is
    // the hottest code in the project, two samples for every solid voxel below
    // the cave ceiling. The output is identical; only the work is less.
    const a = this.caveA.noise3(wx * 0.028, y * 0.05, wz * 0.028);
    const aSq = a * a;
    if (aSq >= 0.0034) return false;
    const b = this.caveB.noise3(wx * 0.028, y * 0.05, wz * 0.028);
    return aSq + b * b < 0.0034;
  }

  /**
   * The underground watercourses and, deeper still, the lava tunnels.
   *
   * Both are the same shape — a ridged channel followed through a narrow band of
   * depth — and differ only in what fills them and how deep they run. Returning
   * the fluid rather than a boolean keeps the two from drifting apart.
   *
   * They exist because mountains this tall leave no room for surface rivers to
   * cross a range: the water goes under it instead.
   */
  private tunnelFluid(wx: number, y: number, wz: number, surface: number): Block | null {
    // Rivers sit a good way below the surface but above the cave layer's floor.
    const riverBand = Math.min(SEA_LEVEL - 6, surface - 14);
    if (y <= riverBand && y >= riverBand - 5) {
      const channel = this.riverNoise.ridged2(wx * 0.0042, wz * 0.0042, 2);
      if (channel > 0.84) return Block.Water;
    }
    // Lava runs deep, on its own channel field offset far away so the two
    // networks are unrelated — a lava tunnel directly under a water one would
    // drain into it the moment the player broke the floor.
    if (y >= 8 && y <= 16) {
      const channel = this.riverNoise.ridged2(wx * 0.0052 + 400, wz * 0.0052 - 300, 2);
      if (channel > 0.86) return Block.Lava;
    }
    return null;
  }

  private oreAt(wx: number, y: number, wz: number): Block | null {
    if (y > SEA_LEVEL + 4) return null;
    const n = this.oreNoise.noise3(wx * 0.14, y * 0.14, wz * 0.14);
    if (y < 34 && n > 0.74) return Block.GoldOre;
    if (n > 0.62) return Block.IronOre;
    return null;
  }

  /**
   * Fills a chunk's voxel array, then re-applies any saved player edits.
   *
   * `treeMargin` exists for one test, which regenerates a chunk with a wider margin
   * and requires the result to be identical — that is what proves `MAX_TREE_REACH`
   * is actually wide enough for the trees as written. Callers should leave it alone.
   */
  generate(chunk: Chunk, treeMargin = MAX_TREE_REACH): void {
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
        const subsurface = subsurfaceBlock(biome);
        const soilDepth = biome === Biome.Desert ? 5 : biome === Biome.Badlands ? 2 : 3;
        const underwater = h <= SEA_LEVEL + 1;

        const top = Math.max(h, SEA_LEVEL);
        for (let y = 0; y <= top; y++) {
          let id: number;

          if (y === 0) {
            id = Block.Bedrock;
          } else if (y > h) {
            id = y <= SEA_LEVEL ? Block.Water : Block.Air;
          } else if (y === h) {
            id = underwater ? Block.Sand : surface;
          } else if (y >= h - soilDepth) {
            id = underwater ? Block.Sand : subsurface;
          } else if (biome === Biome.Badlands && y > SEA_LEVEL - 10) {
            // Strata. The band index comes from the world y alone, so the layers
            // line up across a whole canyon wall instead of stepping per column.
            id = canyonStrata(y);
          } else {
            id = this.oreAt(wx, y, wz) ?? Block.Stone;
          }

          // Carve caves, but never breach the seabed (avoids draining oceans).
          if (id !== Block.Air && id !== Block.Water && id !== Block.Bedrock && this.isCave(wx, y, wz)) {
            if (!(underwater && y > h - 4)) id = Block.Air;
          }

          // Underground rivers and lava tunnels are cut after the caves so they
          // win where the two overlap: a flooded channel that a cave has already
          // emptied would otherwise be a dry trench.
          if (id === Block.Stone || id === Block.Terracotta || id === Block.PaleTerracotta) {
            const fluid = this.tunnelFluid(wx, y, wz, h);
            if (fluid !== null) id = fluid;
          }

          if (id !== Block.Air) vox[voxelIndex(lx, y, lz)] = id;
        }
      }
    }

    this.placeTrees(chunk, treeMargin);

    // Player edits go on top of the generated terrain, so anything you have built
    // or mined always wins.
    chunk.applyEdits();
    chunk.recomputeHeightMap();
  }

  /**
   * Grows the trees.
   *
   * Trees are generated for a margin of columns *outside* the chunk as well, and
   * only the voxels landing inside get written. That way a trunk near a border
   * still grows its canopy across the seam without inter-chunk messaging: both
   * chunks evaluate the same root column, compute the identical tree, and each
   * keeps its own half. Everything here is therefore a pure function of
   * `(wx, wz, seed)` — a per-tree PRNG is seeded from the root column, so the
   * sequence of decisions depends only on which tree it is and never on the order
   * chunks happen to be generated in.
   *
   * The invariant that makes it work is `margin >= MAX_TREE_REACH`. Get it wrong
   * and canopies are sliced off at chunk borders; `scripts/unit.ts` asserts it by
   * regenerating with a wider margin and demanding the same voxels.
   *
   * `margin` is a parameter only so that test can vary it.
   */
  private placeTrees(chunk: Chunk, margin = MAX_TREE_REACH): void {
    const baseX = chunk.cx * CHUNK_SX;
    const baseZ = chunk.cz * CHUNK_SZ;
    const vox = chunk.voxels;

    /** Writes a leaf, never over anything solid. */
    const leaf = (wx: number, y: number, wz: number): void => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 0 || y >= CHUNK_SY) return;
      const i = voxelIndex(lx, y, lz);
      if (vox[i] !== Block.Air) return;
      vox[i] = Block.Leaves;
    };

    /**
     * Writes wood.
     *
     * `force` is for the trunk, which replaces the surface block it stands on so
     * the tree is rooted rather than balanced on top of the grass. Limbs leave it
     * off: a branch is allowed to displace air and its own foliage, but one that
     * overwrote terrain would bore a wooden plug through the hillside behind it.
     */
    const wood = (wx: number, y: number, wz: number, force = false): void => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 0 || y >= CHUNK_SY) return;
      const i = voxelIndex(lx, y, lz);
      if (!force && vox[i] !== Block.Air && vox[i] !== Block.Leaves) return;
      vox[i] = Block.Wood;
    };

    /** Hash of a voxel position. Absolute, so two chunks rag an edge identically. */
    const hash3 = (x: number, y: number, z: number, salt: number): number =>
      hash2i(x, Math.imul(z, 92837111) ^ Math.imul(y, 689287499), this.seed ^ salt);

    /**
     * A clump of foliage: an ellipsoid with a deterministically ragged shell.
     *
     * `squash` is how much more a block of vertical distance counts than a block of
     * horizontal — above 1 the clump is a flattened dome, which is what most
     * canopies are. `ragged` is the fraction of the outermost shell to drop, and it
     * is what stops the clump reading as a geometric solid.
     */
    const clump = (
      cx: number,
      cy: number,
      cz: number,
      radius: number,
      squash: number,
      ragged: number,
    ): void => {
      const reach = Math.min(Math.ceil(radius), MAX_TREE_REACH);
      const lift = Math.ceil(radius / Math.sqrt(squash));
      for (let dy = -lift; dy <= lift; dy++) {
        for (let dz = -reach; dz <= reach; dz++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const d = Math.sqrt(dx * dx + dz * dz + dy * dy * squash);
            if (d > radius) continue;
            if (d > radius - 1 && hash3(cx + dx, cy + dy, cz + dz, 0x1eaf) < ragged) continue;
            leaf(cx + dx, cy + dy, cz + dz);
          }
        }
      }
    };

    /** A branch, as a voxelised line of wood. */
    const limb = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        wood(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t));
      }
    };

    const TAU = Math.PI * 2;

    for (let wz = baseZ - margin; wz < baseZ + CHUNK_SZ + margin; wz++) {
      for (let wx = baseX - margin; wx < baseX + CHUNK_SX + margin; wx++) {
        // One integer hash rejects ~98% of columns before anything expensive runs.
        // Widening the margin to cover the new canopies took this loop from 484
        // columns a chunk to 900, and `biomeAt`/`surfaceHeight` are the two hottest
        // paths in the generator — so the spawn roll is taken first, against the
        // largest density any biome uses, and only survivors pay for a biome
        // lookup. Identical distribution, a fraction of the work.
        const roll = hash2i(wx, wz, this.seed ^ 0x5eed);
        if (roll >= MAX_TREE_DENSITY) continue;

        const biome = this.biomeAt(wx, wz);
        if (roll >= treeDensity(biome)) continue;

        const h = this.surfaceHeight(wx, wz);
        if (h <= SEA_LEVEL + 1 || h > TREE_LINE) continue;

        // Caves are carved *after* the surface is laid down, so a column's top
        // voxel may be a hole. Recomputed from the same pure function rather than
        // read back out of the chunk: a tree rooted in the chunk next door has to
        // reach the same verdict here as it does there, and reading voxels would
        // only work for roots inside this one — the two would then disagree about
        // whether the tree exists at all and slice its canopy along the seam.
        if (this.isCave(wx, h, wz)) continue;

        // Per-tree PRNG, seeded from the root column. hash2i returns a float
        // scaled from a uint32, so multiplying it back recovers that integer.
        const rand = mulberry32((hash2i(wx, wz, this.seed ^ 0xa11) * 4294967296) >>> 0);
        // Species is rolled on its own salt, so retuning a tree's shape cannot
        // shuffle which species grow where.
        const kind = treeKind(biome, h, hash2i(wx, wz, this.seed ^ 0x5bec1e5));

        switch (kind) {
          case TreeKind.Pine: {
            // A conifer: one straight bole, whorls of foliage tapering to a tip.
            const trunkH = 12 + Math.floor(rand() * 6);
            const topY = h + trunkH;
            for (let y = h; y <= topY; y++) wood(wx, y, wz, true);

            const skirt = h + 2 + Math.floor(rand() * 2);
            const tiers = Math.max(3, Math.floor((topY - skirt) / 2));
            for (let t = 0; t <= tiers; t++) {
              const y = skirt + t * 2;
              if (y > topY) break;
              // Quadratic rather than linear, so the tree flares into a skirt near
              // the ground instead of reading as a straight-sided triangle.
              const f = 1 - t / tiers;
              // Squash 2.6 and not more: the whorls sit two blocks apart, and at 3.4
              // each one was a single-voxel disc with clear air between it and the
              // next — the bole showed through and the tree read as threadbare.
              // Just over 2.6 is what makes consecutive whorls touch at their inner
              // radius while still pinching in to a tip.
              clump(wx, y, wz, 0.9 + f * f * 3.2, 2.6, 0.24);
            }
            clump(wx, topY + 1, wz, 1.2, 2, 0.2);
            break;
          }

          case TreeKind.Birch: {
            // Slender: a tall bare bole and a narrow crown held high.
            const trunkH = 11 + Math.floor(rand() * 4);
            const topY = h + trunkH;
            for (let y = h; y <= topY; y++) wood(wx, y, wz, true);

            clump(wx, topY, wz, 2.3 + rand() * 0.5, 2.4, 0.42);
            clump(wx, topY - 2 - Math.floor(rand() * 2), wz, 2 + rand() * 0.5, 2.6, 0.5);
            // One token limb, so it is not a perfectly straight pole.
            const angle = rand() * TAU;
            const from = topY - 3 - Math.floor(rand() * 3);
            const ex = wx + Math.round(Math.cos(angle) * 2);
            const ez = wz + Math.round(Math.sin(angle) * 2);
            limb(wx, from, wz, ex, from + 2, ez);
            clump(ex, from + 3, ez, 1.7, 2, 0.45);
            break;
          }

          case TreeKind.Jungle: {
            // The giant: bare for most of its height, then a broad layered crown.
            const trunkH = 16 + Math.floor(rand() * 7);
            const topY = h + trunkH;
            for (let y = h; y <= topY; y++) wood(wx, y, wz, true);

            // Buttress roots. A trunk this tall looks staked into the ground
            // without them.
            for (let i = 0; i < 4; i++) {
              const a = (i / 4) * TAU + 0.4;
              wood(wx + Math.round(Math.cos(a)), h, wz + Math.round(Math.sin(a)));
            }

            clump(wx, topY, wz, 5 + rand() * 0.8, 2.8, 0.42);
            const limbs = 3 + Math.floor(rand() * 3);
            for (let i = 0; i < limbs; i++) {
              const a = (i / limbs) * TAU + rand() * 0.8;
              const reach = 3 + Math.floor(rand() * 2);
              const from = topY - 2 - Math.floor(rand() * 4);
              const ex = wx + Math.round(Math.cos(a) * reach);
              const ez = wz + Math.round(Math.sin(a) * reach);
              limb(wx, from, wz, ex, from + 1, ez);
              clump(ex, from + 1, ez, 2 + rand() * 0.6, 2.2, 0.45);
            }
            break;
          }

          case TreeKind.Willow: {
            // Swamp tree: short, thick, wide-domed, with foliage hanging off the rim.
            const trunkH = 7 + Math.floor(rand() * 3);
            const topY = h + trunkH;
            for (let y = h; y <= topY; y++) wood(wx, y, wz, true);

            clump(wx, topY, wz, 4.2 + rand() * 0.8, 1.3, 0.4);
            const strands = 5 + Math.floor(rand() * 4);
            for (let i = 0; i < strands; i++) {
              const a = (i / strands) * TAU + rand() * 0.6;
              const rr = 2.6 + rand() * 1.6;
              const sx = wx + Math.round(Math.cos(a) * rr);
              const sz = wz + Math.round(Math.sin(a) * rr);
              const drop = 3 + Math.floor(rand() * 4);
              for (let d = 0; d < drop; d++) leaf(sx, topY - 1 - d, sz);
            }
            break;
          }

          default: {
            // Oak: a broad irregular crown carried on several limbs.
            const trunkH = 9 + Math.floor(rand() * 4);
            const topY = h + trunkH;
            for (let y = h; y <= topY; y++) wood(wx, y, wz, true);

            clump(wx, topY, wz, 3.6 + rand() * 0.8, 1.6, 0.4);
            const limbs = 3 + Math.floor(rand() * 2);
            for (let i = 0; i < limbs; i++) {
              const a = (i / limbs) * TAU + rand() * 0.9;
              const reach = 2 + Math.floor(rand() * 2);
              const from = h + Math.round(trunkH * (0.55 + rand() * 0.3));
              const ex = wx + Math.round(Math.cos(a) * reach);
              const ez = wz + Math.round(Math.sin(a) * reach);
              const ey = from + 1 + Math.floor(rand() * 2);
              limb(wx, from, wz, ex, ey, ez);
              clump(ex, ey + 1, ez, 2 + rand() * 0.7, 1.5, 0.45);
            }
            break;
          }
        }
      }
    }
  }
}

/** The tree shapes. Which one grows is decided by biome and altitude. */
const enum TreeKind {
  Oak,
  Birch,
  Pine,
  Jungle,
  Willow,
}

/**
 * Which species grows in a column.
 *
 * Mixing two shapes within a biome is what stops a forest reading as one asset
 * stamped repeatedly, and the altitude rule gives a forested mountainside a visible
 * band of conifers below the tree line rather than oaks all the way up.
 */
function treeKind(biome: Biome, h: number, roll: number): TreeKind {
  switch (biome) {
    case Biome.Jungle:
      return TreeKind.Jungle;
    case Biome.Wetland:
      return TreeKind.Willow;
    case Biome.Tundra:
      return TreeKind.Pine;
    case Biome.Forest:
      if (h > 92) return TreeKind.Pine;
      if (roll < 0.22) return TreeKind.Pine;
      if (roll < 0.42) return TreeKind.Birch;
      return TreeKind.Oak;
    default:
      return roll < 0.3 ? TreeKind.Birch : TreeKind.Oak;
  }
}

/**
 * Chance per column that a tree roots there.
 *
 * These dropped by roughly a factor of three when the trees grew. Canopy *area*
 * goes as the square of the crown radius, so doubling a tree's size without
 * thinning the stand does not give a denser forest — it gives one unbroken slab of
 * leaves at a single height, with no trunks and no sky visible underneath. The
 * numbers below are solved for the coverage wanted rather than guessed: for a crown
 * of area `a` and target coverage `c`, trees per column is `-ln(1 - c) / a`.
 */
export function treeDensity(biome: Biome): number {
  switch (biome) {
    case Biome.Forest:
      return 0.017;
    case Biome.Jungle:
      // The sparsest of the woodlands relative to its canopy, because the jungle's
      // whole visual point is the terrain pillars rising *through* the trees.
      return 0.01;
    case Biome.Wetland:
      return 0.01;
    case Biome.Tundra:
      return 0.005;
    case Biome.Plains:
      return 0.003;
    default:
      return 0;
  }
}

/**
 * Canyon strata.
 *
 * Banded on world y rather than on depth below the surface, so the layers run
 * level across a whole canyon wall. Banding by depth instead makes every column
 * carry its own stripes, which follow the terrain up and down and read as noise.
 */
function canyonStrata(y: number): Block {
  const band = Math.floor(y / 3) % 5;
  if (band === 0 || band === 3) return Block.PaleTerracotta;
  if (band === 2) return Block.Stone;
  return Block.Terracotta;
}

function subsurfaceBlock(biome: Biome): Block {
  switch (biome) {
    case Biome.Desert:
    case Biome.Beach:
      return Block.Sand;
    case Biome.Badlands:
      return Block.Terracotta;
    default:
      return Block.Dirt;
  }
}

function surfaceBlock(biome: Biome, h: number): Block {
  switch (biome) {
    case Biome.Desert:
    case Biome.Beach:
      return Block.Sand;
    case Biome.Tundra:
      return Block.Snow;
    case Biome.Badlands:
      return Block.Terracotta;
    case Biome.Mountains:
      return h > SNOW_LINE ? Block.Snow : Block.Stone;
    default:
      // Everything green turns to rock and then snow as it climbs.
      if (h > SNOW_LINE) return Block.Snow;
      if (h > TREE_LINE) return Block.Stone;
      return Block.Grass;
  }
}
