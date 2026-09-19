import * as THREE from 'three';
import { Block } from './blocks';
import { mulberry32 } from './noise';

/**
 * Procedurally generated block texture atlas.
 *
 * The world began with no textures at all: every block was a flat RGB triple baked
 * into the vertex colours alongside ambient occlusion and per-face shading. That is
 * fine for masonry and hopeless for ground cover and foliage, which differ by blades,
 * grit, veins and grain — and the seam where turf meets soil needs two materials in
 * one face.
 *
 * Still no external assets: every tile is drawn in code on a canvas at load.
 *
 * ## Resolution
 *
 * Tiles are 64px. The first version used 32px and the detail came out far too coarse
 * — a 3px pebble is a tenth of a 32px block face, so soil read as confetti rather
 * than as dirt. 64px with `NearestFilter` magnification keeps the deliberately
 * pixelated look while leaving room for grit, veins and growth rings to be small
 * relative to the block.
 *
 * ## How this coexists with vertex colours
 *
 * The material multiplies the map by the vertex colour, and the mesher keeps writing
 * AO and face shading there — so shading, occlusion and the day/night cycle all keep
 * working untouched. For a *textured* block the mesher writes greyscale shading only
 * and lets the texture supply the hue; for every other block it writes tint×shade as
 * before and samples a blank white tile, which multiplies to exactly what it drew
 * before. Nothing that was not asked to change looks different.
 *
 * ## Split into pure data and canvas drawing
 *
 * Everything the mesher needs — which tile a face uses, and where that tile sits in
 * UV space — is arithmetic, and lives here as plain functions. The canvas work is
 * behind `createBlockAtlas`, called once by the renderer. The unit tests mesh real
 * chunks in Node where there is no `document`, so touching a canvas at import time
 * would break them.
 */

/**
 * Drawn size of one tile.
 *
 * "Medium resolution": pixelated enough to sit alongside a blocky world, detailed
 * enough that a pebble is a pebble rather than a tenth of the block.
 */
export const TILE_PIXELS = 64;
/**
 * Gutter around each tile, in pixels.
 *
 * Mipmapping averages neighbouring texels, and at the edge of a tile those
 * neighbours belong to a *different* tile — so grass bleeds into dirt as the camera
 * pulls back. Each tile's border is duplicated outwards into this gutter so the
 * averaging has same-tile pixels to chew on.
 */
export const TILE_PADDING = 8;
const CELL_PIXELS = TILE_PIXELS + TILE_PADDING * 2;
const ATLAS_COLUMNS = 4;
export const ATLAS_PIXELS = CELL_PIXELS * ATLAS_COLUMNS;

/**
 * Tile slots in the atlas.
 *
 * Ground cover and foliage come in pairs. One tile per block type makes a dug pit or
 * a canopy visibly checkerboard, because every block carries the identical image; a
 * second variant chosen by world position breaks the repeat up at no cost.
 */
export const Tile = {
  /** Flat white. Multiplying by this leaves a block's vertex colour untouched. */
  Blank: 0,
  GrassTopA: 1,
  GrassTopB: 2,
  GrassSide: 3,
  DirtA: 4,
  DirtB: 5,
  LeavesA: 6,
  LeavesB: 7,
  /** Bark, for the sides of a log. */
  LogSide: 8,
  /** End grain: growth rings and radial cracks, for the cut faces of a log. */
  LogTop: 9,
} as const;

export type TileId = (typeof Tile)[keyof typeof Tile];

/** Every tile in the atlas. Exported so tests iterate it rather than a stale list. */
export const ALL_TILE_IDS: readonly number[] = Object.values(Tile);

export interface TileRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * UV rectangle of a tile's drawn area, excluding its gutter.
 *
 * Throws on an unknown tile rather than returning `NaN` coordinates. A NaN UV is
 * silent: geometry still builds, the material still draws, and the only symptom is
 * untextured faces — which is indistinguishable from the texture work not being
 * wired up at all. Renaming a tile once produced exactly that.
 */
export function tileRect(tile: number): TileRect {
  if (!Number.isInteger(tile) || tile < 0 || tile >= ATLAS_COLUMNS * ATLAS_COLUMNS) {
    throw new Error(`tileRect: no such tile ${tile}`);
  }
  const column = tile % ATLAS_COLUMNS;
  const row = Math.floor(tile / ATLAS_COLUMNS);
  const x = column * CELL_PIXELS + TILE_PADDING;
  const y = row * CELL_PIXELS + TILE_PADDING;
  return {
    u0: x / ATLAS_PIXELS,
    v0: 1 - (y + TILE_PIXELS) / ATLAS_PIXELS,
    u1: (x + TILE_PIXELS) / ATLAS_PIXELS,
    v1: 1 - y / ATLAS_PIXELS,
  };
}

/**
 * Picks one of `count` variants for a block, from its world position.
 *
 * Deterministic and independent of chunk boundaries, so the same block always draws
 * the same way however the world streams in.
 */
function variant(wx: number, wz: number, count: number): number {
  let h = (wx * 374761393 + wz * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return Math.abs(h ^ (h >>> 16)) % count;
}

/**
 * Which tile a block's face samples.
 *
 * Anything not listed gets the blank tile, so adding a texture to one block never
 * disturbs the rest of the world.
 */
export function tileForFace(blockId: number, face: 'top' | 'side' | 'bottom', wx = 0, wz = 0): number {
  switch (blockId) {
    case Block.Grass:
      // Turf on top, a ragged fringe of it hanging over gritty soil on the sides,
      // plain soil underneath.
      if (face === 'top') return variant(wx, wz, 2) === 0 ? Tile.GrassTopA : Tile.GrassTopB;
      if (face === 'side') return Tile.GrassSide;
      return variant(wx, wz, 2) === 0 ? Tile.DirtA : Tile.DirtB;
    case Block.Dirt:
      return variant(wx, wz, 2) === 0 ? Tile.DirtA : Tile.DirtB;
    case Block.Leaves:
      return variant(wx, wz, 2) === 0 ? Tile.LeavesA : Tile.LeavesB;
    case Block.Wood:
      // The cut faces show growth rings; the sides show bark.
      return face === 'side' ? Tile.LogSide : Tile.LogTop;
    default:
      return Tile.Blank;
  }
}

/**
 * True when the texture carries the block's colour.
 *
 * For these the mesher writes greyscale shading into the vertex colour rather than
 * tint×shade, because multiplying a green texture by an already-green tint darkens
 * it twice over. The block's `top`/`side`/`bottom` colours stay as they are — the
 * HUD, the held-block model and the break particles all still read them.
 */
export function isTexturedBlock(blockId: number): boolean {
  return (
    blockId === Block.Grass ||
    blockId === Block.Dirt ||
    blockId === Block.Leaves ||
    blockId === Block.Wood
  );
}

// ------------------------------------------------------------------ palettes

/**
 * Turf greens, deliberately a narrow ramp.
 *
 * A wide ramp from near-black to bright tip — which is what this started as — reads
 * as static rather than as grass: the darkest strokes become holes and the lightest
 * become sparkle. Real turf is tonally tight, and the blade structure comes from
 * *direction*, not from contrast.
 */
const GRASS_GREENS = ['#2b4417', '#33511c', '#3b5d23', '#446a2a', '#4d7833', '#57853b', '#629345', '#6da04e'];
const GRASS_SHADOW = '#20340f';
const GRASS_TIPS = ['#7aae58', '#87bb64'];

/**
 * Soil tones, pitched light and kept close together.
 *
 * Two corrections from the first attempt. Side faces carry a baked brightness of
 * 0.70–0.88 plus ambient occlusion, so a texture painted at the reference's own
 * values lands markedly darker on the block. And the spread was far too wide: bright
 * grey pebbles against dark brown read as confetti, not as earth. Stones are now
 * muted towards the soil they sit in.
 */
const SOIL_BASE = ['#7d6341', '#8a6f4b', '#6f5636', '#947a57', '#664e31'];
const SOIL_GRIT = ['#95795200', '#9a7f58', '#a68b62', '#8a6f4a'].map((c) => c.slice(0, 7));
const SOIL_DARK = ['#4a3620', '#3f2d1a', '#533c24'];
const PEBBLE_GREY = ['#8b8578', '#968f81', '#7d776b'];
const PEBBLE_WARM = ['#a2855c', '#ab8f66', '#8e7449'];

/** Leaf greens: mostly mid, a few yellowed, the odd dry one. */
const LEAF_GREENS = ['#2c4a1e', '#345623', '#3d6329', '#467030', '#4f7c37', '#5a8a40'];
const LEAF_LIGHT = ['#6f9f4b', '#7dab55', '#8ab861'];
const LEAF_DRY = ['#7a6b32', '#6d5a28'];
/** The gaps between leaves. Opaque — see the leaf drawing for why. */
const LEAF_VOID = '#1b2d12';

/** Bark: grey-brown plates with dark furrows between them. */
const BARK_TONES = ['#5c4a3a', '#664f3c', '#705843', '#523f31', '#7a6149'];
const BARK_FURROW = ['#33261d', '#2a1f18', '#3d2e23'];
const BARK_LICHEN = ['#6e6f59', '#7b7c64'];

/** End grain: pale sapwood, warmer heartwood, dark cracks. */
const WOOD_RINGS = ['#d8b183', '#cfa676', '#c49a6a', '#bb8e60', '#b08354', '#c7a070'];
const WOOD_DARK = ['#8a5f38', '#7a5230'];
const WOOD_CRACK = '#4d341d';

type Ctx = CanvasRenderingContext2D;

function pick(list: readonly string[], rand: () => number): string {
  return list[Math.floor(rand() * list.length)];
}

// ------------------------------------------------------------------ soil

/**
 * Mottled soil: broad blotches, fine grit, small stones, twigs.
 *
 * Feature sizes are kept small relative to the tile and tones close to the base. The
 * failure mode here is not "too plain", it is "too busy": coarse high-contrast speckle
 * reads as noise at every distance, and mipmapping turns it into grey mush.
 */
function drawSoil(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = SOIL_BASE[0];
  ctx.fillRect(x, y, size, size);

  // Broad tonal blotches, larger than any single feature, so the soil has areas of
  // light and shade rather than uniform speckle.
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = pick(SOIL_BASE, rand);
    const w = 6 + Math.floor(rand() * 18);
    const h = 5 + Math.floor(rand() * 14);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), w, h);
  }

  // Fine grit: single specks, close in tone to the soil.
  for (let i = 0; i < Math.round(size * size * 0.1); i++) {
    ctx.fillStyle = pick(SOIL_GRIT, rand);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1, 1);
  }

  // Dark organic matter: short thin streaks.
  for (let i = 0; i < Math.round(size * size * 0.03); i++) {
    ctx.fillStyle = pick(SOIL_DARK, rand);
    const length = 1 + Math.floor(rand() * 3);
    if (rand() < 0.5) ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), length, 1);
    else ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1, length);
  }

  // Stones: a body with one lit edge and one shaded edge, which is enough to suggest
  // a rounded pebble. Sparse, and muted towards the soil around them.
  for (let i = 0; i < Math.round(size * size * 0.007); i++) {
    const w = 2 + Math.floor(rand() * 3);
    const h = 2 + Math.floor(rand() * 2);
    const px = x + Math.floor(rand() * (size - w));
    const py = y + Math.floor(rand() * (size - h));
    const warm = rand() < 0.5;
    ctx.fillStyle = pick(warm ? PEBBLE_WARM : PEBBLE_GREY, rand);
    ctx.fillRect(px, py, w, h);
    ctx.fillStyle = warm ? '#bb9f74' : '#a7a093';
    ctx.fillRect(px, py, w, 1);
    ctx.fillStyle = SOIL_DARK[0];
    ctx.fillRect(px, py + h - 1, w, 1);
  }

  // Roots and twigs.
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = pick(SOIL_DARK, rand);
    const tx = x + Math.floor(rand() * size);
    const ty = y + Math.floor(rand() * size);
    const length = 3 + Math.floor(rand() * 7);
    if (rand() < 0.5) ctx.fillRect(tx, ty, length, 1);
    else ctx.fillRect(tx, ty, 1, length);
  }
}

// ------------------------------------------------------------------ grass

/** Turf seen from above: dense directional blades over a tight tonal base. */
function drawGrassTop(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = GRASS_SHADOW;
  ctx.fillRect(x, y, size, size);

  // Broad tonal patches, at a scale larger than a blade, drawn from across the whole
  // ramp so the tile has light and shaded areas rather than one mid-tone.
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = GRASS_GREENS[Math.floor(rand() * GRASS_GREENS.length)];
    const w = 9 + Math.floor(rand() * 18);
    const h = 9 + Math.floor(rand() * 18);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), w, h);
  }

  // Blades: short runs in four directions, drawn darkest first so lighter blades
  // land on top. The sense of grass comes from strokes being directional and
  // overlapping, not from them differing in colour.
  //
  // Density matters as much as palette. Seven passes at high density overdraw each
  // other until only the lightest two survive, and the tile averages out flat — the
  // measured contrast fell to a third of what the leaf tiles carry, which on screen
  // is indistinguishable from no texture at all. Sparser passes let the darker
  // blades show through.
  for (let pass = 0; pass < GRASS_GREENS.length; pass++) {
    ctx.fillStyle = GRASS_GREENS[pass];
    for (let i = 0; i < Math.round(size * size * 0.075); i++) {
      const bx = x + Math.floor(rand() * size);
      const by = y + Math.floor(rand() * size);
      const length = 3 + Math.floor(rand() * 5);
      const roll = rand();
      if (roll < 0.34) ctx.fillRect(bx, by, 1, length);
      else if (roll < 0.68) ctx.fillRect(bx, by, length, 1);
      else {
        const step = roll < 0.84 ? 1 : -1;
        for (let k = 0; k < length; k++) ctx.fillRect(bx + k * step, by + k, 1, 1);
      }
    }
  }

  // Sunlit tips.
  for (let i = 0; i < Math.round(size * size * 0.03); i++) {
    ctx.fillStyle = pick(GRASS_TIPS, rand);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1, 1 + Math.floor(rand() * 3));
  }

  // A couple of bare spots showing soil through the turf.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = pick(SOIL_BASE, rand);
    const w = 1 + Math.floor(rand() * 2);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), w, w);
  }
}

/**
 * The side of a turf block: grass above, soil below, ragged between.
 *
 * The fringe depth is per-column, so the boundary is irregular the way it is in the
 * reference rather than a ruled line across the block.
 */
function drawGrassSide(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  drawSoil(ctx, x, y, size, rand);

  const baseDepth = Math.round(size * 0.32);
  for (let column = 0; column < size; column++) {
    // Two sine terms plus jitter: neighbouring columns stay related, so the fringe
    // has clumps in it instead of looking like per-pixel noise.
    const depth = Math.max(
      2,
      baseDepth + Math.round(Math.sin(column * 0.31) * 3 + Math.sin(column * 0.09) * 2.5 + (rand() - 0.5) * 4),
    );
    for (let row = 0; row < depth; row++) {
      const t = row / Math.max(1, depth - 1);
      // Lighter at the top where the turf catches the sky, shading into the fringe.
      const shade = Math.min(GRASS_GREENS.length - 1, Math.max(0, Math.floor((1 - t) * 4 + rand() * 3)));
      ctx.fillStyle = GRASS_GREENS[shade];
      ctx.fillRect(x + column, y + row, 1, 1);
    }
    // A blade or two hanging past the fringe.
    if (rand() < 0.34) {
      ctx.fillStyle = pick(GRASS_GREENS.slice(0, 4), rand);
      ctx.fillRect(x + column, y + depth, 1, 1 + Math.floor(rand() * 3));
    }
  }
}

// ------------------------------------------------------------------ leaves

/**
 * Dense overlapping leaves with veins.
 *
 * The reference has transparent gaps, but leaves render in the *opaque* pass on a
 * material shared with every other block, so an alpha cutout would mean either a
 * second material for one block type or `alphaTest` applied to the whole world. The
 * gaps are filled with deep shadow green instead — which is how Minecraft's own
 * "fast" leaves work, and reads correctly because the inside of a canopy is dark.
 */
function drawLeaves(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = LEAF_VOID;
  ctx.fillRect(x, y, size, size);

  ctx.save();
  // Clip so leaves near the border cannot spill into a neighbouring tile's gutter.
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();

  const leaves = 78;
  for (let i = 0; i < leaves; i++) {
    const cx = x + rand() * size;
    const cy = y + rand() * size;
    const length = size * (0.1 + rand() * 0.1);
    const width = length * (0.42 + rand() * 0.2);
    const angle = rand() * Math.PI * 2;

    const roll = rand();
    const fill = roll < 0.12 ? pick(LEAF_LIGHT, rand) : roll < 0.16 ? pick(LEAF_DRY, rand) : pick(LEAF_GREENS, rand);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // A lens shape: pointed at both ends, which is what makes it read as a leaf
    // rather than as a blob.
    ctx.beginPath();
    ctx.moveTo(-length, 0);
    ctx.quadraticCurveTo(0, -width, length, 0);
    ctx.quadraticCurveTo(0, width, -length, 0);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Midrib, a shade lighter, plus a couple of side veins.
    ctx.strokeStyle = pick(LEAF_LIGHT, rand);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(-length * 0.8, 0);
    ctx.lineTo(length * 0.8, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // A darker edge along one side, which separates overlapping leaves.
    ctx.strokeStyle = LEAF_VOID;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(-length, 0);
    ctx.quadraticCurveTo(0, width, length, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  ctx.restore();
}

// ------------------------------------------------------------------ wood

/** Bark: vertical plates split by dark furrows. */
function drawBark(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = BARK_TONES[0];
  ctx.fillRect(x, y, size, size);

  // Vertical streaks of plate colour. Bark's structure runs with the trunk, so
  // everything here is tall and thin.
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = pick(BARK_TONES, rand);
    const w = 1 + Math.floor(rand() * 4);
    const h = 6 + Math.floor(rand() * 28);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), w, h);
  }

  // Furrows: dark cracks that wander down the tile, with the occasional branch.
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = pick(BARK_FURROW, rand);
    let fx = Math.floor(rand() * size);
    for (let row = 0; row < size; row++) {
      ctx.fillRect(x + ((fx + size) % size), y + row, 1 + (rand() < 0.3 ? 1 : 0), 1);
      if (rand() < 0.22) fx += rand() < 0.5 ? 1 : -1;
    }
  }

  // Short horizontal breaks between plates.
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = pick(BARK_FURROW, rand);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 2 + Math.floor(rand() * 4), 1);
  }

  // Highlights on the plate edges, and a little lichen.
  for (let i = 0; i < 50; i++) {
    ctx.fillStyle = BARK_TONES[4];
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1, 2 + Math.floor(rand() * 5));
  }
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = pick(BARK_LICHEN, rand);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1 + Math.floor(rand() * 2), 1);
  }
}

/**
 * End grain: concentric growth rings, radial cracks, and a bark rind.
 *
 * Rings are drawn as circles of slightly wobbling radius from the centre outwards,
 * which is enough for a cut log at this size. The radial cracks are what stop it
 * reading as a target.
 */
function drawEndGrain(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  const cx = x + size / 2;
  const cy = y + size / 2;

  ctx.fillStyle = WOOD_RINGS[0];
  ctx.fillRect(x, y, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();

  // Rings, outermost first so inner ones draw over them.
  const rings = 15;
  for (let i = rings; i >= 1; i--) {
    const radius = (i / rings) * size * 0.52;
    ctx.beginPath();
    // Slight per-ring wobble, so they are not perfect circles.
    for (let a = 0; a <= 32; a++) {
      const angle = (a / 32) * Math.PI * 2;
      const wobble = 1 + Math.sin(angle * 3 + i) * 0.03 + Math.sin(angle * 5 - i * 2) * 0.02;
      const px = cx + Math.cos(angle) * radius * wobble;
      const py = cy + Math.sin(angle) * radius * wobble;
      if (a === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? pick(WOOD_RINGS, rand) : pick(WOOD_DARK, rand);
    ctx.fill();
  }

  // Radial cracks from the heart outwards.
  ctx.strokeStyle = WOOD_CRACK;
  for (let i = 0; i < 6; i++) {
    const angle = rand() * Math.PI * 2;
    const reach = size * (0.2 + rand() * 0.3);
    ctx.lineWidth = rand() < 0.5 ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
    ctx.stroke();
  }

  // The heart.
  ctx.fillStyle = WOOD_CRACK;
  ctx.fillRect(cx - 1, cy - 1, 3, 3);

  ctx.restore();

  // Bark rind around the outside, which is what makes it read as a cut log rather
  // than as a decorative disc.
  const rind = Math.max(2, Math.round(size * 0.075));
  for (let i = 0; i < size; i++) {
    for (const [px, py, w, h] of [
      [x + i, y, 1, rind],
      [x + i, y + size - rind, 1, rind],
      [x, y + i, rind, 1],
      [x + size - rind, y + i, rind, 1],
    ] as const) {
      ctx.fillStyle = pick(BARK_TONES, rand);
      ctx.fillRect(px, py, w, h);
      if (rand() < 0.3) {
        ctx.fillStyle = pick(BARK_FURROW, rand);
        ctx.fillRect(px, py, w, 1);
      }
    }
  }
}

// ------------------------------------------------------------------ atlas

/**
 * The atlas, or `null` where there is nothing to draw on.
 *
 * The unit tests mesh real chunks in Node, which has no `document`. Those tests are
 * about geometry — face culling, ambient occlusion, UV ranges — none of which need
 * the pixels to exist, so returning null and leaving the material untextured is
 * better than making the whole suite require a DOM.
 */
export function tryCreateBlockAtlas(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  return createBlockAtlas();
}

/**
 * Mean brightness and contrast of each tile's pixels.
 *
 * A tile that came out flat has a standard deviation near zero, and that is
 * indistinguishable on screen from the texture never having been applied. Reading the
 * atlas back is the only way to tell which of the two is happening.
 */
export function atlasTileStats(texture: THREE.Texture): Record<string, { mean: number; stdev: number }> {
  const source = texture.image as HTMLCanvasElement | undefined;
  const out: Record<string, { mean: number; stdev: number }> = {};
  if (!source) return out;

  const scratch = document.createElement('canvas');
  scratch.width = ATLAS_PIXELS;
  scratch.height = ATLAS_PIXELS;
  const ctx = scratch.getContext('2d');
  if (!ctx) return out;
  ctx.drawImage(source, 0, 0);

  const names = Object.entries(Tile);
  for (const [name, tile] of names) {
    const x = (tile % ATLAS_COLUMNS) * CELL_PIXELS + TILE_PADDING;
    const y = Math.floor(tile / ATLAS_COLUMNS) * CELL_PIXELS + TILE_PADDING;
    const { data } = ctx.getImageData(x, y, TILE_PIXELS, TILE_PIXELS);
    let sum = 0;
    let sumSq = 0;
    const pixels = TILE_PIXELS * TILE_PIXELS;
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      sum += luma;
      sumSq += luma * luma;
    }
    const mean = sum / pixels;
    out[name] = {
      mean: Number(mean.toFixed(3)),
      stdev: Number(Math.sqrt(Math.max(0, sumSq / pixels - mean * mean)).toFixed(3)),
    };
  }
  return out;
}

/**
 * Builds the atlas.
 *
 * Each tile is drawn into its cell and then its border is duplicated outwards into
 * the gutter, so mipmapping never averages one tile against its neighbour.
 */
export function createBlockAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PIXELS;
  canvas.height = ATLAS_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;

  // Fixed seed: the atlas is identical every run, so screenshots are comparable.
  const rand = mulberry32(0x9e3779b9);

  const originOf = (tile: number): [number, number] => [
    (tile % ATLAS_COLUMNS) * CELL_PIXELS + TILE_PADDING,
    Math.floor(tile / ATLAS_COLUMNS) * CELL_PIXELS + TILE_PADDING,
  ];

  const draw = (tile: number, paint: (x: number, y: number) => void): void => {
    const [x, y] = originOf(tile);
    paint(x, y);
  };

  // Blank: white, the identity for a multiply.
  draw(Tile.Blank, (x, y) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, TILE_PIXELS, TILE_PIXELS);
  });

  draw(Tile.GrassTopA, (x, y) => drawGrassTop(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.GrassTopB, (x, y) => drawGrassTop(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.GrassSide, (x, y) => drawGrassSide(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.DirtA, (x, y) => drawSoil(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.DirtB, (x, y) => drawSoil(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.LeavesA, (x, y) => drawLeaves(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.LeavesB, (x, y) => drawLeaves(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.LogSide, (x, y) => drawBark(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.LogTop, (x, y) => drawEndGrain(ctx, x, y, TILE_PIXELS, rand));

  // Gutters: extend each tile's edge pixels outwards.
  for (const tile of ALL_TILE_IDS) {
    const [x, y] = originOf(tile);
    const p = TILE_PADDING;
    const s = TILE_PIXELS;
    ctx.drawImage(canvas, x, y, 1, s, x - p, y, p, s);
    ctx.drawImage(canvas, x + s - 1, y, 1, s, x + s, y, p, s);
    ctx.drawImage(canvas, x, y, s, 1, x, y - p, s, p);
    ctx.drawImage(canvas, x, y + s - 1, s, 1, x, y + s, s, p);
    ctx.drawImage(canvas, x, y, 1, 1, x - p, y - p, p, p);
    ctx.drawImage(canvas, x + s - 1, y, 1, 1, x + s, y - p, p, p);
    ctx.drawImage(canvas, x, y + s - 1, 1, 1, x - p, y + s, p, p);
    ctx.drawImage(canvas, x + s - 1, y + s - 1, 1, 1, x + s, y + s, p, p);
  }

  const texture = new THREE.CanvasTexture(canvas);
  // Crisp texels close up, mipmapped in the distance. Nearest sampling alone
  // shimmers badly on terrain seen edge-on across a valley.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.name = 'block-atlas';
  return texture;
}
