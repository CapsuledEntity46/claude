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
 * Sized for a *realistic* look rather than a pixel-art one: the reference photographs
 * are 1024px and this is a little under an eighth of that, which keeps grain, veins
 * and growth rings readable without a 4k atlas. Sampled with `LinearFilter`, so
 * nothing about the result is deliberately pixelated.
 */
export const TILE_PIXELS = 128;
/**
 * Gutter around each tile, in pixels.
 *
 * Mipmapping averages neighbouring texels, and at the edge of a tile those
 * neighbours belong to a *different* tile — so grass bleeds into dirt as the camera
 * pulls back. Each tile's border is duplicated outwards into this gutter so the
 * averaging has same-tile pixels to chew on.
 */
export const TILE_PADDING = 16;
const CELL_PIXELS = TILE_PIXELS + TILE_PADDING * 2;
/**
 * Grid width of the atlas, in cells.
 *
 * Five rather than four purely for headroom: the eighteen tiles below would fit a
 * 4x4 grid with nothing to spare, and `tileRect` throws past the last slot — so the
 * next block type to want a texture would fail at runtime rather than at review.
 */
const ATLAS_COLUMNS = 5;
export const ATLAS_PIXELS = CELL_PIXELS * ATLAS_COLUMNS;

/**
 * Tile slots in the atlas.
 *
 * Ground cover, foliage and rock come in pairs. One tile per block type makes a dug
 * pit or a canopy visibly checkerboard, because every block carries the identical
 * image; a second variant chosen by world position breaks the repeat up at no cost.
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
  /** Grey cracked stone — the bulk of everything underground and every mountain. */
  StoneA: 10,
  StoneB: 11,
  /** Rippled desert sand, for beaches and dunes. */
  SandA: 12,
  SandB: 13,
  /** Rust-red banded rock, for the badlands and the canyon walls. */
  RedRockA: 14,
  RedRockB: 15,
  /**
   * The same red rock washed pale.
   *
   * Canyon strata alternate Terracotta with PaleTerracotta, and the whole point of
   * that is a visible band. Pointing both at one tile would texture the canyon
   * beautifully and flatten its stripes away, because a textured block takes its
   * colour from the tile rather than from its own tint.
   */
  PaleRedRockA: 16,
  PaleRedRockB: 17,
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
 *
 * `wy` is mixed in as well as `wx`/`wz`, which matters for anything that stacks.
 * Ground cover is a single layer and never noticed, but stone forms cliffs and mine
 * shafts hundreds of blocks tall: keyed on the horizontal position alone, every
 * block in a column picks the same variant and the wall comes out in vertical
 * stripes — the exact artefact the second variant exists to prevent.
 */
function variant(wx: number, wy: number, wz: number, count: number): number {
  let h = (wx * 374761393 + wy * 1103515245 + wz * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return Math.abs(h ^ (h >>> 16)) % count;
}

/**
 * Which tile a block's face samples.
 *
 * Anything not listed gets the blank tile, so adding a texture to one block never
 * disturbs the rest of the world.
 *
 * Deliberately *not* extended to cobblestone, dungeon brick, slabs or stairs even
 * though all of them are made of rock. Masonry reads as masonry because it is not
 * natural stone, and the shaped blocks stretch a whole tile across each sub-cube
 * box of their geometry, which a 128px rock face would show up badly. Ores stay flat
 * for a gameplay reason: now that stone has detail, a flat ore block is *easier* to
 * pick out of a wall than it was before.
 */
export function tileForFace(
  blockId: number,
  face: 'top' | 'side' | 'bottom',
  wx = 0,
  wy = 0,
  wz = 0,
): number {
  switch (blockId) {
    case Block.Grass:
      // Turf on top, a ragged fringe of it hanging over gritty soil on the sides,
      // plain soil underneath.
      if (face === 'top') return variant(wx, 0, wz, 2) === 0 ? Tile.GrassTopA : Tile.GrassTopB;
      if (face === 'side') return Tile.GrassSide;
      return variant(wx, 0, wz, 2) === 0 ? Tile.DirtA : Tile.DirtB;
    case Block.Dirt:
      return variant(wx, 0, wz, 2) === 0 ? Tile.DirtA : Tile.DirtB;
    case Block.Leaves:
      return variant(wx, wy, wz, 2) === 0 ? Tile.LeavesA : Tile.LeavesB;
    case Block.Wood:
      // The cut faces show growth rings; the sides show bark.
      return face === 'side' ? Tile.LogSide : Tile.LogTop;
    case Block.Stone:
      return variant(wx, wy, wz, 2) === 0 ? Tile.StoneA : Tile.StoneB;
    case Block.Sand:
      return variant(wx, wy, wz, 2) === 0 ? Tile.SandA : Tile.SandB;
    case Block.Terracotta:
      return variant(wx, wy, wz, 2) === 0 ? Tile.RedRockA : Tile.RedRockB;
    case Block.PaleTerracotta:
      return variant(wx, wy, wz, 2) === 0 ? Tile.PaleRedRockA : Tile.PaleRedRockB;
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
    blockId === Block.Wood ||
    blockId === Block.Stone ||
    blockId === Block.Sand ||
    blockId === Block.Terracotta ||
    blockId === Block.PaleTerracotta
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
const GRASS_GREENS = ['#44552a', '#4c5f31', '#546b37', '#5c763e', '#648245', '#6c8d4c', '#759854', '#7ea35d'];
const GRASS_SHADOW = '#333f1e';
const GRASS_TIPS = ['#8aab66', '#96b772'];

/**
 * Soil tones, pitched light and kept close together.
 *
 * Two corrections from the first attempt. Side faces carry a baked brightness of
 * 0.70–0.88 plus ambient occlusion, so a texture painted at the reference's own
 * values lands markedly darker on the block. And the spread was far too wide: bright
 * grey pebbles against dark brown read as confetti, not as earth. Stones are now
 * muted towards the soil they sit in.
 */
const SOIL_BASE = ['#a98a5e', '#b6976a', '#9c7e52', '#c3a479', '#90744c'];
const SOIL_GRIT = ['#c4a67c', '#d0b389', '#dabf95', '#b79b70'];
const SOIL_DARK = ['#6b5132', '#5e472b', '#765a38'];
const PEBBLE_GREY = ['#9d968a', '#a9a296', '#8d8779'];
const PEBBLE_WARM = ['#b4966b', '#bfa176', '#a08359'];

/** Leaf greens: mostly mid, a few yellowed, the odd dry one. */
const LEAF_GREENS = ['#37591f', '#416829', '#4b7731', '#55863a', '#5f9443', '#6aa34d'];
const LEAF_LIGHT = ['#83b95c', '#91c667', '#9fd374'];
const LEAF_DRY = ['#7a6b32', '#6d5a28'];
/** The gaps between leaves. Opaque — see the leaf drawing for why. */
const LEAF_VOID = '#25391a';

/** Bark: grey-brown plates with dark furrows between them. */
const BARK_TONES = ['#6d5744', '#7b6350', '#8a715c', '#5a4636', '#9b8169', '#4d3b2d'];
const BARK_FURROW = ['#2e2218', '#241a12', '#3a2b20'];
const BARK_LICHEN = ['#8a8b70', '#97987c'];

/** End grain: pale sapwood, warmer heartwood, dark cracks. */
const WOOD_RINGS = ['#d8b183', '#cfa676', '#c49a6a', '#bb8e60', '#b08354', '#c7a070'];
const WOOD_DARK = ['#8a5f38', '#7a5230'];
const WOOD_CRACK = '#4d341d';

/**
 * Rock palettes, for the procedurally painted fallback.
 *
 * Each is pitched at the mean luma `scripts/glb-tiles.mjs` tone-maps the authored
 * tile to — grey stone 0.56, red rock 0.53, pale red rock 0.67 — so a browser that
 * fails to fetch the sheets does not suddenly render a differently-lit world.
 */
interface RockPalette {
  /** Broad tonal range of the rock face. */
  body: readonly string[];
  /** Catching the light on a raised plate. */
  lit: readonly string[];
  /** Crack and fissure ink. */
  crack: readonly string[];
  /** Flecks of mineral or lichen. */
  fleck: readonly string[];
}

const STONE_ROCK: RockPalette = {
  body: ['#8d8d91', '#97979b', '#838387', '#a1a1a5', '#79797d'],
  lit: ['#b4b4b8', '#c0c0c4', '#aaaaae'],
  crack: ['#4a4a4e', '#3e3e42', '#565659'],
  fleck: ['#c8c8c0', '#8f9490', '#b0aca2'],
};

const RED_ROCK: RockPalette = {
  body: ['#a86a3c', '#b47544', '#9c6034', '#c08250', '#8d542c'],
  lit: ['#cb9262', '#d6a071', '#c08858'],
  crack: ['#5a3118', '#4a2712', '#68391d'],
  fleck: ['#d8b183', '#9a7a5a', '#c48f5e'],
};

const PALE_RED_ROCK: RockPalette = {
  body: ['#cda679', '#d6b185', '#c29b6e', '#e0bd93', '#b78f64'],
  lit: ['#e8cca6', '#f0d7b4', '#e2c49c'],
  crack: ['#8a6440', '#7a5636', '#9a7450'],
  fleck: ['#f0ddc0', '#bfa588', '#dcc2a0'],
};

/**
 * Sand: a narrow, bright, warm ramp.
 *
 * Narrower than it looks like it should be. Sand's character is *ripple*, not tonal
 * variety — the authored tile measures a luma stdev of 0.017 before its normal map
 * is lit, which is to say the colour is nearly uniform and all the form comes from
 * relief. Painting it with a wide ramp reads as gravel.
 */
const SAND_BODY = ['#ddc89b', '#e4d1a6', '#d4bd8e', '#ebdab4', '#cbb382'];
const SAND_LIT = ['#f2e4c2', '#f8edd2'];
const SAND_SHADE = ['#ab9064', '#9c8358', '#b99d71'];

type Ctx = CanvasRenderingContext2D;

function pick(list: readonly string[], rand: () => number): string {
  return list[Math.floor(rand() * list.length)];
}

// ------------------------------------------------------------------ brushes

/**
 * Soft-edged brushes.
 *
 * These are what separate a realistic texture from a pixel-art one. Hard-edged
 * `fillRect` speckle is legible at 32px and reads as noise at 128px; the same detail
 * painted with translucent radial gradients reads as grain, mottling and wear. Every
 * texture below is built by layering these rather than by setting pixels.
 */

/** A soft round dab, fading to nothing at its edge. */
function blob(ctx: Ctx, cx: number, cy: number, radius: number, color: string, alpha: number): void {
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** A slightly curved stroke — a blade, a root, a wood fibre. */
function stroke(
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bow: number,
  color: string,
  width: number,
  alpha: number,
): void {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  // Bow perpendicular to the run, so the curve reads as growth rather than as a
  // wobble.
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy) || 1;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(mx - (dy / length) * bow, my + (dx / length) * bow, x1, y1);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Fine grain: a dense field of tiny translucent dabs.
 *
 * Low alpha is the point. Opaque single pixels of a contrasting tone read as dirt on
 * the *lens*; translucent ones sink into the surface and read as texture in it.
 */
function grain(
  ctx: Ctx,
  x: number,
  y: number,
  size: number,
  rand: () => number,
  tones: readonly string[],
  count: number,
  maxRadius: number,
  alpha: number,
): void {
  for (let i = 0; i < count; i++) {
    blob(
      ctx,
      x + rand() * size,
      y + rand() * size,
      0.6 + rand() * maxRadius,
      pick(tones, rand),
      alpha * (0.4 + rand() * 0.6),
    );
  }
}

/** A rounded stone, lit from the upper left. */
function stone(ctx: Ctx, cx: number, cy: number, radius: number, body: string, lit: string, rand: () => number): void {
  // Contact shadow first, so the stone sits in the soil rather than on it.
  blob(ctx, cx + radius * 0.2, cy + radius * 0.35, radius * 1.5, 'rgba(50,36,20,0.5)', 0.4);

  const gradient = ctx.createRadialGradient(
    cx - radius * 0.35,
    cy - radius * 0.4,
    radius * 0.1,
    cx,
    cy,
    radius * 1.05,
  );
  gradient.addColorStop(0, lit);
  gradient.addColorStop(0.55, body);
  gradient.addColorStop(1, 'rgba(70,54,34,0.85)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  // Slightly irregular, so stones are not a field of identical circles.
  const points = 9;
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r = radius * (0.82 + rand() * 0.3);
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r * 0.85;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

// ------------------------------------------------------------------ soil

/**
 * Mottled soil: layered tonal wash, fine grain, rounded stones, roots.
 *
 * Painted rather than plotted. The failure mode here is not "too plain", it is "too
 * busy": hard-edged high-contrast speckle reads as noise at every distance and turns
 * to grey mush under mipmapping. Broad soft washes carry the form, dense low-alpha
 * grain carries the surface, and only a handful of stones are drawn with real edges.
 */
function drawSoil(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = SOIL_BASE[0];
  ctx.fillRect(x, y, size, size);

  // Broad tonal wash: large overlapping soft dabs, so the soil has areas of light and
  // shade at a scale well above any single feature.
  for (let i = 0; i < 70; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.08 + rand() * 0.22), pick(SOIL_BASE, rand), 0.5);
  }
  // Damp patches and dry patches.
  for (let i = 0; i < 18; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.05 + rand() * 0.12), pick(SOIL_DARK, rand), 0.18);
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.04 + rand() * 0.1), pick(SOIL_GRIT, rand), 0.26);
  }

  // Fine grain, in two scales: coarse sand over fine silt.
  grain(ctx, x, y, size, rand, SOIL_GRIT, Math.round(size * size * 0.05), 1.6, 0.4);
  grain(ctx, x, y, size, rand, SOIL_DARK, Math.round(size * size * 0.022), 1.3, 0.24);
  grain(ctx, x, y, size, rand, SOIL_BASE, Math.round(size * size * 0.04), 2.0, 0.3);

  // Roots and twigs: thin curved strokes, a few catching the light.
  for (let i = 0; i < 16; i++) {
    const x0 = x + rand() * size;
    const y0 = y + rand() * size;
    const angle = rand() * Math.PI * 2;
    const length = size * (0.06 + rand() * 0.16);
    stroke(
      ctx,
      x0,
      y0,
      x0 + Math.cos(angle) * length,
      y0 + Math.sin(angle) * length,
      size * 0.03 * (rand() - 0.5),
      pick(SOIL_DARK, rand),
      0.8 + rand() * 1.4,
      0.55,
    );
  }

  // Stones. Sparse and muted towards the soil they sit in — bright grey pebbles
  // against dark brown is what made the first attempt read as confetti.
  const stones = Math.round(size * size * 0.0022);
  for (let i = 0; i < stones; i++) {
    const warm = rand() < 0.5;
    stone(
      ctx,
      x + size * 0.06 + rand() * size * 0.88,
      y + size * 0.06 + rand() * size * 0.88,
      size * (0.018 + rand() * 0.028),
      pick(warm ? PEBBLE_WARM : PEBBLE_GREY, rand),
      warm ? '#c6a87c' : '#b3ada0',
      rand,
    );
  }

  // A final whisper of grain over the stones, tying them into the surface.
  grain(ctx, x, y, size, rand, SOIL_GRIT, Math.round(size * size * 0.012), 1.2, 0.2);
}

// ------------------------------------------------------------------ grass

/** Turf seen from above: dense directional blades over a mottled base. */
function drawGrassTop(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = GRASS_GREENS[2];
  ctx.fillRect(x, y, size, size);

  // Tonal patches, larger than any blade, so the turf has light and shade.
  for (let i = 0; i < 46; i++) {
    blob(
      ctx,
      x + rand() * size,
      y + rand() * size,
      size * (0.07 + rand() * 0.2),
      GRASS_GREENS[Math.floor(rand() * GRASS_GREENS.length)],
      0.5,
    );
  }
  // Shadowed gaps between clumps.
  for (let i = 0; i < 22; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.03 + rand() * 0.09), GRASS_SHADOW, 0.3);
  }

  // Blades: fine curved strokes in every direction. Density and direction carry the
  // reading, not colour contrast — an earlier version used a near-black-to-bright
  // ramp and looked like static.
  const blades = Math.round(size * size * 0.045);
  for (let i = 0; i < blades; i++) {
    const bx = x + rand() * size;
    const by = y + rand() * size;
    const angle = rand() * Math.PI * 2;
    const length = size * (0.055 + rand() * 0.085);
    stroke(
      ctx,
      bx,
      by,
      bx + Math.cos(angle) * length,
      by + Math.sin(angle) * length,
      size * 0.02 * (rand() - 0.5),
      GRASS_GREENS[Math.floor(rand() * GRASS_GREENS.length)],
      0.7 + rand() * 0.9,
      0.5 + rand() * 0.4,
    );
  }

  // Sunlit blades on top, sparse.
  for (let i = 0; i < Math.round(size * size * 0.005); i++) {
    const bx = x + rand() * size;
    const by = y + rand() * size;
    const angle = rand() * Math.PI * 2;
    const length = size * (0.04 + rand() * 0.06);
    stroke(
      ctx,
      bx,
      by,
      bx + Math.cos(angle) * length,
      by + Math.sin(angle) * length,
      0,
      pick(GRASS_TIPS, rand),
      0.7 + rand() * 0.7,
      0.55,
    );
  }

  // A couple of worn patches showing soil through the turf.
  for (let i = 0; i < 3; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.02 + rand() * 0.035), pick(SOIL_BASE, rand), 0.5);
  }
}

/**
 * The side of a turf block: grass above, soil below, ragged between.
 *
 * The boundary is a filled path with a wandering top edge and individual blades
 * hanging past it, rather than a ruled line across the block.
 */
function drawGrassSide(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  drawSoil(ctx, x, y, size, rand);

  const baseDepth = size * 0.3;
  // Depth per column, from two slow sine terms plus jitter: neighbouring columns stay
  // related, so the fringe clumps instead of looking like per-pixel noise.
  const depthAt = (column: number): number =>
    Math.max(
      size * 0.08,
      baseDepth + Math.sin(column * 0.055) * size * 0.05 + Math.sin(column * 0.017) * size * 0.04,
    );

  // The turf band, as one filled shape.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size, y + depthAt(size));
  for (let column = size; column >= 0; column -= 2) {
    ctx.lineTo(x + column, y + depthAt(column));
  }
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = GRASS_GREENS[2];
  ctx.fillRect(x, y, size, size);
  // Shade the band downwards: turf catches the sky at the top and darkens into the
  // fringe.
  const shade = ctx.createLinearGradient(x, y, x, y + baseDepth * 1.3);
  shade.addColorStop(0, 'rgba(255,255,255,0.16)');
  shade.addColorStop(0.55, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.42)');
  for (let i = 0; i < 30; i++) {
    blob(
      ctx,
      x + rand() * size,
      y + rand() * baseDepth * 1.4,
      size * (0.04 + rand() * 0.12),
      GRASS_GREENS[Math.floor(rand() * GRASS_GREENS.length)],
      0.5,
    );
  }
  // Vertical blades within the band.
  for (let i = 0; i < Math.round(size * 2.2); i++) {
    const bx = x + rand() * size;
    const top = y + rand() * baseDepth * 0.5;
    stroke(
      ctx,
      bx,
      top,
      bx + (rand() - 0.5) * size * 0.03,
      top + size * (0.06 + rand() * 0.16),
      size * 0.012 * (rand() - 0.5),
      GRASS_GREENS[Math.floor(rand() * GRASS_GREENS.length)],
      0.7 + rand() * 0.9,
      0.55,
    );
  }
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, size, baseDepth * 1.3);
  ctx.restore();

  // Blades hanging past the fringe into the soil.
  for (let i = 0; i < Math.round(size * 0.7); i++) {
    const bx = x + rand() * size;
    const top = y + depthAt(bx - x) - size * 0.01;
    stroke(
      ctx,
      bx,
      top,
      bx + (rand() - 0.5) * size * 0.04,
      top + size * (0.02 + rand() * 0.07),
      size * 0.01 * (rand() - 0.5),
      GRASS_GREENS[Math.floor(rand() * 4)],
      0.7 + rand() * 0.8,
      0.6,
    );
  }
}

// ------------------------------------------------------------------ leaves

/**
 * Dense overlapping leaves with midribs and soft shadows.
 *
 * The reference has transparent gaps, but leaves render in the *opaque* pass on a
 * material shared with every other block, so an alpha cutout would mean either a
 * second material for one block type or `alphaTest` applied to the whole world. The
 * gaps are filled with deep shadow green instead, which reads correctly because the
 * inside of a canopy is dark.
 */
function drawLeaves(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = LEAF_VOID;
  ctx.fillRect(x, y, size, size);
  // A little depth in the voids, so gaps read as canopy interior rather than as paint.
  for (let i = 0; i < 24; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.05 + rand() * 0.14), pick(LEAF_GREENS, rand), 0.3);
  }

  ctx.save();
  // Clip so leaves near the border cannot spill into a neighbouring tile's gutter.
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();

  const leaves = 150;
  for (let i = 0; i < leaves; i++) {
    const cx = x + rand() * size;
    const cy = y + rand() * size;
    const length = size * (0.055 + rand() * 0.06);
    const width = length * (0.4 + rand() * 0.2);
    const angle = rand() * Math.PI * 2;

    const roll = rand();
    const base = roll < 0.12 ? pick(LEAF_LIGHT, rand) : roll < 0.16 ? pick(LEAF_DRY, rand) : pick(LEAF_GREENS, rand);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Drop shadow, which is what makes a mat of leaves read as layered.
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = LEAF_VOID;
    ctx.beginPath();
    ctx.moveTo(-length + 1.5, 2);
    ctx.quadraticCurveTo(1.5, -width + 2, length + 1.5, 2);
    ctx.quadraticCurveTo(1.5, width + 2, -length + 1.5, 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // The blade: lit along one side, shaded along the other.
    const shading = ctx.createLinearGradient(0, -width, 0, width);
    shading.addColorStop(0, base);
    shading.addColorStop(1, pick(LEAF_GREENS, rand));
    ctx.fillStyle = shading;
    ctx.beginPath();
    ctx.moveTo(-length, 0);
    ctx.quadraticCurveTo(0, -width, length, 0);
    ctx.quadraticCurveTo(0, width, -length, 0);
    ctx.closePath();
    ctx.fill();

    // Midrib and a few side veins.
    stroke(ctx, -length * 0.85, 0, length * 0.85, 0, 0, pick(LEAF_LIGHT, rand), 0.9, 0.4);
    for (let v = 0; v < 3; v++) {
      const t = -0.4 + v * 0.4;
      const side = rand() < 0.5 ? 1 : -1;
      stroke(
        ctx,
        length * t,
        0,
        length * (t + 0.25),
        side * width * 0.65,
        0,
        pick(LEAF_LIGHT, rand),
        0.6,
        0.22,
      );
    }

    // Darkened rim along one edge, separating overlapping leaves.
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = LEAF_VOID;
    ctx.lineWidth = 1;
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

/** Bark: fibrous vertical plates split by deep furrows. */
function drawBark(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = BARK_TONES[0];
  ctx.fillRect(x, y, size, size);

  // Broad vertical tonal bands. Bark's structure runs with the trunk, so every
  // feature here is tall and narrow.
  for (let i = 0; i < 46; i++) {
    const bx = x + rand() * size;
    const gradient = ctx.createLinearGradient(bx - size * 0.05, 0, bx + size * 0.05, 0);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.5, pick(BARK_TONES, rand));
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = gradient;
    ctx.fillRect(bx - size * 0.05, y, size * 0.1, size);
    ctx.globalAlpha = 1;
  }

  // Furrows: dark seams that wander down the tile, drawn as soft gradients so they
  // read as depth rather than as drawn lines.
  const furrows = 9;
  for (let i = 0; i < furrows; i++) {
    let fx = x + ((i + rand() * 0.6) / furrows) * size;
    const width = size * (0.012 + rand() * 0.02);
    for (let yy = y; yy < y + size; yy += 2) {
      fx += (rand() - 0.5) * size * 0.012;
      const gradient = ctx.createLinearGradient(fx - width * 2, 0, fx + width * 2, 0);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(0.5, pick(BARK_FURROW, rand));
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = gradient;
      ctx.fillRect(fx - width * 2, yy, width * 4, 3);
      ctx.globalAlpha = 1;
    }
  }

  // Fibres: long fine strokes along the grain, light and dark.
  for (let i = 0; i < Math.round(size * 5); i++) {
    const bx = x + rand() * size;
    const top = y + rand() * size;
    const length = size * (0.06 + rand() * 0.3);
    stroke(
      ctx,
      bx,
      top,
      bx + (rand() - 0.5) * size * 0.02,
      top + length,
      size * 0.008 * (rand() - 0.5),
      rand() < 0.45 ? BARK_TONES[4] : pick(BARK_FURROW, rand),
      0.6 + rand() * 1.2,
      0.4 + rand() * 0.4,
    );
  }

  // Short cross-breaks between plates.
  for (let i = 0; i < 70; i++) {
    const bx = x + rand() * size;
    const by = y + rand() * size;
    stroke(ctx, bx, by, bx + size * (0.02 + rand() * 0.05), by + (rand() - 0.5) * size * 0.01, 0, pick(BARK_FURROW, rand), 1.1, 0.45);
  }

  // Lichen, and grain over everything.
  for (let i = 0; i < 12; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.015 + rand() * 0.03), pick(BARK_LICHEN, rand), 0.35);
  }
  grain(ctx, x, y, size, rand, BARK_TONES, Math.round(size * size * 0.02), 1.4, 0.25);
}

/**
 * End grain: concentric growth rings, radial cracks, and a bark rind.
 *
 * Rings are drawn as many thin soft arcs of slightly wandering radius, which is what
 * makes them read as grain rather than as a printed target.
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

  // Sapwood is paler towards the outside, heartwood warmer at the core.
  const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.6);
  body.addColorStop(0, WOOD_DARK[0]);
  body.addColorStop(0.45, WOOD_RINGS[3]);
  body.addColorStop(1, WOOD_RINGS[0]);
  ctx.fillStyle = body;
  ctx.fillRect(x, y, size, size);

  // Rings.
  const rings = 34;
  for (let i = rings; i >= 1; i--) {
    const radius = (i / rings) * size * 0.52;
    ctx.beginPath();
    for (let a = 0; a <= 64; a++) {
      const angle = (a / 64) * Math.PI * 2;
      const wobble = 1 + Math.sin(angle * 3 + i * 0.7) * 0.025 + Math.sin(angle * 5 - i * 1.3) * 0.018;
      const px = cx + Math.cos(angle) * radius * wobble;
      const py = cy + Math.sin(angle) * radius * wobble;
      if (a === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = i % 2 === 0 ? pick(WOOD_RINGS, rand) : pick(WOOD_DARK, rand);
    ctx.lineWidth = i % 2 === 0 ? 1.2 + rand() * 1.4 : 0.8 + rand();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Radial cracks from the heart outwards.
  for (let i = 0; i < 7; i++) {
    const angle = rand() * Math.PI * 2;
    const reach = size * (0.16 + rand() * 0.3);
    stroke(
      ctx,
      cx,
      cy,
      cx + Math.cos(angle) * reach,
      cy + Math.sin(angle) * reach,
      size * 0.02 * (rand() - 0.5),
      WOOD_CRACK,
      0.9 + rand() * 1.6,
      0.75,
    );
  }
  blob(ctx, cx, cy, size * 0.03, WOOD_CRACK, 0.8);

  grain(ctx, x, y, size, rand, WOOD_RINGS, Math.round(size * size * 0.015), 1.3, 0.18);
  ctx.restore();

  // Bark rind around the outside, which is what makes it read as a cut log rather
  // than as a decorative disc.
  const rind = size * 0.08;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.rect(x + rind, y + rind, size - rind * 2, size - rind * 2);
  ctx.clip('evenodd');
  drawBark(ctx, x, y, size, rand);
  ctx.restore();
}


// ------------------------------------------------------------------ rock

/**
 * Cracked rock: tonal plates divided by branching fissures.
 *
 * This is the *fallback*. The rock a player normally sees is baked from
 * `assets/blocks/*.glb` by `scripts/glb-tiles.mjs` and composited over this tile
 * once it loads. Painting it anyway is what keeps two promises: the unit tests mesh
 * chunks in Node where no image can be fetched, and a browser that loses the
 * request gets stone that still looks like stone instead of a flat grey cube.
 *
 * Fissures are drawn as *branching* runs rather than independent scratches. A field
 * of unconnected strokes reads as damage to the texture; a few trunks with offshoots
 * read as rock that has split.
 */
function drawRock(ctx: Ctx, x: number, y: number, size: number, rand: () => number, palette: RockPalette): void {
  ctx.fillStyle = palette.body[0];
  ctx.fillRect(x, y, size, size);

  // Plates: broad overlapping washes, well above the scale of any crack, so the
  // face has regions of light and shade rather than uniform noise.
  for (let i = 0; i < 60; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.1 + rand() * 0.26), pick(palette.body, rand), 0.5);
  }
  for (let i = 0; i < 14; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.06 + rand() * 0.14), pick(palette.lit, rand), 0.3);
  }

  // Fissures. Each trunk wanders across the tile; each offshoot leaves it part way
  // along at a shallow angle.
  const trunks = 5;
  for (let t = 0; t < trunks; t++) {
    let px = x + rand() * size;
    let py = y + rand() * size;
    let angle = rand() * Math.PI * 2;
    const segments = 3 + Math.floor(rand() * 3);
    for (let s = 0; s < segments; s++) {
      const length = size * (0.12 + rand() * 0.2);
      angle += (rand() - 0.5) * 1.1;
      const nx = px + Math.cos(angle) * length;
      const ny = py + Math.sin(angle) * length;
      stroke(ctx, px, py, nx, ny, size * 0.04 * (rand() - 0.5), pick(palette.crack, rand), 1 + rand() * 1.8, 0.6);
      // A highlight along one side of the crack is what gives it depth: the lip of
      // the break catches light that the groove itself does not.
      stroke(
        ctx,
        px + size * 0.012,
        py - size * 0.012,
        nx + size * 0.012,
        ny - size * 0.012,
        0,
        pick(palette.lit, rand),
        0.9,
        0.22,
      );
      if (rand() < 0.5) {
        const branchAngle = angle + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.7);
        const branchLength = size * (0.06 + rand() * 0.12);
        stroke(
          ctx,
          nx,
          ny,
          nx + Math.cos(branchAngle) * branchLength,
          ny + Math.sin(branchAngle) * branchLength,
          0,
          pick(palette.crack, rand),
          0.8 + rand(),
          0.45,
        );
      }
      px = nx;
      py = ny;
    }
  }

  // Grit and mineral flecks, at two scales.
  grain(ctx, x, y, size, rand, palette.fleck, Math.round(size * size * 0.03), 1.4, 0.3);
  grain(ctx, x, y, size, rand, palette.crack, Math.round(size * size * 0.02), 1.2, 0.2);
  grain(ctx, x, y, size, rand, palette.body, Math.round(size * size * 0.035), 2.1, 0.3);

  // A few embedded nodules, so the surface is not uniformly flat-faced.
  const nodules = Math.round(size * size * 0.0012);
  for (let i = 0; i < nodules; i++) {
    stone(
      ctx,
      x + rand() * size,
      y + rand() * size,
      size * (0.025 + rand() * 0.04),
      pick(palette.body, rand),
      pick(palette.lit, rand),
      rand,
    );
  }
}

// ------------------------------------------------------------------ sand

/**
 * Wind-rippled sand.
 *
 * The ripples are drawn as roughly parallel bowed strokes, each paired with a
 * lighter one just above it. That pairing is the whole effect: a ripple is a crest
 * and a trough, and a single-tone stroke reads as a scratch. The run direction
 * wanders a little across the tile so the field does not look combed.
 */
function drawSand(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = SAND_BODY[0];
  ctx.fillRect(x, y, size, size);

  for (let i = 0; i < 40; i++) {
    blob(ctx, x + rand() * size, y + rand() * size, size * (0.1 + rand() * 0.25), pick(SAND_BODY, rand), 0.45);
  }

  // Ripple crests, marching across the tile at a shallow angle.
  const ripples = 16;
  const drift = (rand() - 0.5) * 0.5;
  for (let i = 0; i < ripples; i++) {
    const t = (i + rand() * 0.4) / ripples;
    const y0 = y + t * size * 1.15 - size * 0.08;
    const slope = drift + (rand() - 0.5) * 0.18;
    const x0 = x - size * 0.1;
    const x1 = x + size * 1.1;
    const bow = size * (0.04 + rand() * 0.06) * (rand() < 0.5 ? -1 : 1);
    // Trough first, then the crest a little above it.
    stroke(ctx, x0, y0, x1, y0 + slope * size, bow, pick(SAND_SHADE, rand), size * 0.022, 0.3);
    stroke(
      ctx,
      x0,
      y0 - size * 0.018,
      x1,
      y0 + slope * size - size * 0.018,
      bow,
      pick(SAND_LIT, rand),
      size * 0.016,
      0.26,
    );
  }

  // Fine grain. Dense and very low alpha — sand is made of visible grains, but at a
  // scale where any individual one that reads on its own is a stone, not a grain.
  grain(ctx, x, y, size, rand, SAND_LIT, Math.round(size * size * 0.06), 1.1, 0.22);
  grain(ctx, x, y, size, rand, SAND_SHADE, Math.round(size * size * 0.035), 1.0, 0.16);
  grain(ctx, x, y, size, rand, SAND_BODY, Math.round(size * size * 0.05), 1.8, 0.24);
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

/** Top-left pixel of a tile's drawn area, excluding its gutter. */
function tileOrigin(tile: number): [number, number] {
  return [
    (tile % ATLAS_COLUMNS) * CELL_PIXELS + TILE_PADDING,
    Math.floor(tile / ATLAS_COLUMNS) * CELL_PIXELS + TILE_PADDING,
  ];
}

/**
 * Smears a tile's border pixels outwards into its gutter.
 *
 * Has to be re-run on any tile whose pixels are replaced after the atlas is first
 * built, or the gutter keeps the *old* tile's edge and mipmapping blends the two at
 * distance — a stone face that fades to procedural grey as you walk away from it.
 */
function fillGutter(ctx: Ctx, canvas: HTMLCanvasElement, tile: number): void {
  const [x, y] = tileOrigin(tile);
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

/**
 * The authored tile sheets, and which atlas slots each one fills.
 *
 * Baked from `assets/blocks/*.glb` by `npm run tiles` and committed under
 * `public/textures/`, so a normal checkout needs no build step and no GLB parsing
 * at runtime. Each sheet is one row of 128px variants.
 *
 * `wash` derives an extra, paler pair of tiles from the same image. Only red rock
 * uses it, for the alternating canyon strata.
 */
const AUTHORED_SHEETS: readonly {
  file: string;
  tiles: readonly number[];
  wash?: { tiles: readonly number[]; alpha: number };
}[] = [
  { file: 'rock.png', tiles: [Tile.StoneA, Tile.StoneB] },
  { file: 'sand.png', tiles: [Tile.SandA, Tile.SandB] },
  {
    file: 'red-rock.png',
    tiles: [Tile.RedRockA, Tile.RedRockB],
    // 0.30 and not more: the wash both lightens and desaturates, and it scales the
    // tile's contrast by (1 - alpha) as it goes. Past about 0.45 the pale band
    // stops clearing the contrast floor that the smoke suite enforces, which is
    // the same thing as saying it stops looking like rock.
    wash: { tiles: [Tile.PaleRedRockA, Tile.PaleRedRockB], alpha: 0.3 },
  },
];

/** Loads one image, resolving to null rather than rejecting if it is unavailable. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * Composites the authored rock and sand tiles over the painted ones.
 *
 * Deliberately *not* awaited by startup. The atlas is complete and correct the
 * moment `createBlockAtlas` returns, because every tile these sheets replace has
 * already been painted in code; this only upgrades them. Nothing downstream depends
 * on the pixels: UVs are fixed by `tileRect`, so chunks meshed before the sheets
 * arrive pick up the new image for free on the next frame drawn.
 *
 * Which means a slow or failed fetch costs exactly the procedural look, never a
 * stall on a loading screen and never an untextured world. Resolves with the number
 * of sheets applied, so callers and tests can tell which of the two happened.
 */
export async function loadAuthoredBlockTiles(texture: THREE.Texture, baseUrl = 'textures/'): Promise<number> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return 0;
  const canvas = texture.image as HTMLCanvasElement | undefined;
  if (!canvas) return 0;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const sheets = await Promise.all(AUTHORED_SHEETS.map((sheet) => loadImage(baseUrl + sheet.file)));

  let applied = 0;
  sheets.forEach((image, index) => {
    if (!image) return;
    const sheet = AUTHORED_SHEETS[index];
    // Variant size comes from the image rather than from TILE_PIXELS, so a
    // re-bake at a different resolution scales instead of cropping.
    const source = image.height;

    const paint = (tile: number, slot: number, wash: number): void => {
      const [tx, ty] = tileOrigin(tile);
      ctx.drawImage(image, slot * source, 0, source, source, tx, ty, TILE_PIXELS, TILE_PIXELS);
      if (wash > 0) {
        ctx.globalAlpha = wash;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(tx, ty, TILE_PIXELS, TILE_PIXELS);
        ctx.globalAlpha = 1;
      }
      fillGutter(ctx, canvas, tile);
    };

    sheet.tiles.forEach((tile, slot) => paint(tile, slot, 0));
    sheet.wash?.tiles.forEach((tile, slot) => paint(tile, slot, sheet.wash!.alpha));
    applied++;
  });

  if (applied > 0) texture.needsUpdate = true;
  return applied;
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
    const [x, y] = tileOrigin(tile);
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
  ctx.imageSmoothingEnabled = true;

  // Fixed seed: the atlas is identical every run, so screenshots are comparable.
  const rand = mulberry32(0x9e3779b9);

  const draw = (tile: number, paint: (x: number, y: number) => void): void => {
    const [x, y] = tileOrigin(tile);
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

  // Rock and sand. These are the fallback for the authored sheets in
  // public/textures/, which loadAuthoredBlockTiles composites over them.
  draw(Tile.StoneA, (x, y) => drawRock(ctx, x, y, TILE_PIXELS, rand, STONE_ROCK));
  draw(Tile.StoneB, (x, y) => drawRock(ctx, x, y, TILE_PIXELS, rand, STONE_ROCK));
  draw(Tile.SandA, (x, y) => drawSand(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.SandB, (x, y) => drawSand(ctx, x, y, TILE_PIXELS, rand));
  draw(Tile.RedRockA, (x, y) => drawRock(ctx, x, y, TILE_PIXELS, rand, RED_ROCK));
  draw(Tile.RedRockB, (x, y) => drawRock(ctx, x, y, TILE_PIXELS, rand, RED_ROCK));
  draw(Tile.PaleRedRockA, (x, y) => drawRock(ctx, x, y, TILE_PIXELS, rand, PALE_RED_ROCK));
  draw(Tile.PaleRedRockB, (x, y) => drawRock(ctx, x, y, TILE_PIXELS, rand, PALE_RED_ROCK));

  // Gutters: extend each tile's edge pixels outwards.
  for (const tile of ALL_TILE_IDS) fillGutter(ctx, canvas, tile);

  const texture = new THREE.CanvasTexture(canvas);
  // Crisp texels close up, mipmapped in the distance. Nearest sampling alone
  // shimmers badly on terrain seen edge-on across a valley.
  // Smooth magnification. Nearest sampling is what gives a texture that deliberately
  // blocky, Minecraft-ish look; these textures are meant to read as photographs of
  // soil and bark, so they are filtered like photographs.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.name = 'block-atlas';
  return texture;
}
