import * as THREE from 'three';
import { Block } from './blocks';
import { mulberry32 } from './noise';

/**
 * Procedurally generated block texture atlas.
 *
 * Until now the world had no textures at all: every block was a flat RGB triple
 * baked into the vertex colours alongside ambient occlusion and per-face shading.
 * That is fine for masonry but hopeless for ground cover — grass and dirt differ by
 * blades, grit and pebbles, none of which a single colour can express, and the seam
 * where turf meets soil needs the two in one face.
 *
 * Still no external assets: the atlas is drawn in code on a canvas at load.
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

/** Drawn size of one tile. Chunky on purpose: this is a blocky world. */
export const TILE_PIXELS = 32;
/**
 * Gutter around each tile, in pixels.
 *
 * Mipmapping averages neighbouring texels, and at the edge of a tile those
 * neighbours belong to a *different* tile — so grass bleeds into dirt as the camera
 * pulls back. Each tile's border is duplicated outwards into this gutter so the
 * averaging has same-tile pixels to chew on.
 */
export const TILE_PADDING = 4;
const CELL_PIXELS = TILE_PIXELS + TILE_PADDING * 2;
const ATLAS_COLUMNS = 4;
export const ATLAS_PIXELS = CELL_PIXELS * ATLAS_COLUMNS;

/** Tile slots in the atlas. */
export const Tile = {
  /** Flat white. Multiplying by this leaves a block's vertex colour untouched. */
  Blank: 0,
  GrassTop: 1,
  GrassSide: 2,
  Dirt: 3,
} as const;

export type TileId = (typeof Tile)[keyof typeof Tile];

export interface TileRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** UV rectangle of a tile's drawn area, excluding its gutter. */
export function tileRect(tile: number): TileRect {
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
 * Which tile a block's face samples.
 *
 * Anything not listed gets the blank tile, so adding a texture to one block never
 * disturbs the rest of the world.
 */
export function tileForFace(blockId: number, face: 'top' | 'side' | 'bottom'): number {
  if (blockId === Block.Grass) {
    // The whole point of the reference: turf on top, a ragged fringe of it hanging
    // over gritty soil on the sides, plain soil underneath.
    if (face === 'top') return Tile.GrassTop;
    return face === 'side' ? Tile.GrassSide : Tile.Dirt;
  }
  if (blockId === Block.Dirt) return Tile.Dirt;
  return Tile.Blank;
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
  return blockId === Block.Grass || blockId === Block.Dirt;
}

// ------------------------------------------------------------------ drawing

/**
 * Palettes sampled from the reference photograph: cool dark turf shading up to
 * yellow-green tips, and soil that is mostly mid-brown with tan grit, pale stones and
 * near-black organic matter through it.
 */
/**
 * Turf greens, deliberately a narrow ramp.
 *
 * A wide ramp from near-black to bright tip — which is what this started as — reads
 * as static rather than as grass: at one block per tile the darkest strokes become
 * holes and the lightest become sparkle. Real turf is tonally tight, and the blade
 * structure comes from *direction*, not from contrast.
 */
const GRASS_GREENS = ['#37561f', '#3d5f25', '#44692b', '#4b7431', '#527e37', '#5a883e', '#629246'];
/** Gaps between blades: a shade below the ramp, not black. */
const GRASS_SHADOW = ['#2f4a1b', '#2a4218'];
/** Sun-caught tips, used sparingly. */
const GRASS_TIPS = ['#6c9e4d', '#78aa57'];
/**
 * Soil tones, pitched light on purpose.
 *
 * Side faces carry a baked brightness of 0.70–0.88 and ambient occlusion on top of
 * that, so a texture painted at the reference's own values comes out markedly darker
 * on the block than in the reference. These are lifted to land where the photograph
 * sits once shading has been applied.
 */
const SOIL_BASE = ['#7d6341', '#8a6e4b', '#725838', '#977c57', '#6a5031'];
const SOIL_GRIT = ['#a3865d', '#b4996f', '#c2a478', '#8d7149'];
const SOIL_DARK = ['#3b2a1a', '#2c1f12', '#45301c'];
const PEBBLE_GREY = ['#8a8a86', '#9c9c96', '#6e6e6a', '#adaca5'];
const PEBBLE_WARM = ['#b08a55', '#c39a63', '#8c6b3f'];

type Ctx = CanvasRenderingContext2D;

function pick(list: readonly string[], rand: () => number): string {
  return list[Math.floor(rand() * list.length)];
}

/** Mottled soil: base blotches, grit, pebbles, twigs. */
function drawSoil(ctx: Ctx, x: number, y: number, width: number, height: number, rand: () => number): void {
  ctx.fillStyle = SOIL_BASE[0];
  ctx.fillRect(x, y, width, height);

  // Broad blotches, so the soil is not a flat slab of brown.
  for (let i = 0; i < Math.round(width * height * 0.09); i++) {
    ctx.fillStyle = pick(SOIL_BASE, rand);
    const w = 2 + Math.floor(rand() * 5);
    const h = 2 + Math.floor(rand() * 4);
    ctx.fillRect(x + Math.floor(rand() * width), y + Math.floor(rand() * height), w, h);
  }

  // Grit: single bright specks of sand.
  for (let i = 0; i < Math.round(width * height * 0.14); i++) {
    ctx.fillStyle = pick(SOIL_GRIT, rand);
    ctx.fillRect(x + Math.floor(rand() * width), y + Math.floor(rand() * height), 1, 1);
  }

  // Dark organic matter.
  for (let i = 0; i < Math.round(width * height * 0.06); i++) {
    ctx.fillStyle = pick(SOIL_DARK, rand);
    ctx.fillRect(x + Math.floor(rand() * width), y + Math.floor(rand() * height), 1 + Math.floor(rand() * 2), 1);
  }

  // Pebbles: the detail that makes it read as soil rather than as noise. Drawn as a
  // body with a lighter top edge, which is enough to suggest a lit round stone.
  for (let i = 0; i < Math.round(width * height * 0.035); i++) {
    const size = 2 + Math.floor(rand() * 2);
    const px = x + Math.floor(rand() * (width - size));
    const py = y + Math.floor(rand() * (height - size));
    const warm = rand() < 0.45;
    ctx.fillStyle = pick(warm ? PEBBLE_WARM : PEBBLE_GREY, rand);
    ctx.fillRect(px, py, size, size);
    ctx.fillStyle = warm ? '#d8b988' : '#c9c9c2';
    ctx.fillRect(px, py, size, 1);
  }

  // Twigs and roots.
  for (let i = 0; i < Math.round(width * height * 0.01); i++) {
    ctx.fillStyle = pick(SOIL_DARK, rand);
    const tx = x + Math.floor(rand() * width);
    const ty = y + Math.floor(rand() * height);
    const length = 2 + Math.floor(rand() * 4);
    if (rand() < 0.5) ctx.fillRect(tx, ty, length, 1);
    else ctx.fillRect(tx, ty, 1, length);
  }
}

/** Turf seen from above: dense blades over dark gaps. */
function drawGrassTop(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  ctx.fillStyle = GRASS_SHADOW[0];
  ctx.fillRect(x, y, size, size);

  // Broad tonal patches first, so the turf has areas of light and shade at a scale
  // larger than a blade. Without these the tile is uniform mush at any distance.
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = GRASS_GREENS[Math.floor(rand() * 4)];
    const w = 4 + Math.floor(rand() * 8);
    const h = 4 + Math.floor(rand() * 8);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), w, h);
  }

  // Blades, drawn darkest first so the lighter ones land on top. Each is a short
  // run in one of four directions: the sense of grass comes from the strokes being
  // directional and overlapping, not from them being different colours.
  for (let pass = 0; pass < GRASS_GREENS.length; pass++) {
    ctx.fillStyle = GRASS_GREENS[pass];
    const count = Math.round(size * size * 0.28);
    for (let i = 0; i < count; i++) {
      const bx = x + Math.floor(rand() * size);
      const by = y + Math.floor(rand() * size);
      const length = 2 + Math.floor(rand() * 3);
      const roll = rand();
      if (roll < 0.34) ctx.fillRect(bx, by, 1, length);
      else if (roll < 0.68) ctx.fillRect(bx, by, length, 1);
      else {
        // A diagonal blade, one pixel at a time.
        const step = roll < 0.84 ? 1 : -1;
        for (let k = 0; k < length; k++) ctx.fillRect(bx + k * step, by + k, 1, 1);
      }
    }
  }

  // A scattering of sunlit tips.
  for (let i = 0; i < Math.round(size * size * 0.05); i++) {
    ctx.fillStyle = pick(GRASS_TIPS, rand);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1, 1 + Math.floor(rand() * 2));
  }

  // Two bare spots showing soil through the turf. Any more and it reads as dirty.
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = pick(SOIL_BASE, rand);
    ctx.fillRect(x + Math.floor(rand() * size), y + Math.floor(rand() * size), 1, 1);
  }
}

/**
 * The side of a turf block: grass above, soil below, ragged between.
 *
 * The fringe depth is per-column, so the boundary is irregular the way it is in the
 * reference rather than a ruled line across the block.
 */
function drawGrassSide(ctx: Ctx, x: number, y: number, size: number, rand: () => number): void {
  drawSoil(ctx, x, y, size, size, rand);

  const baseDepth = Math.round(size * 0.34);
  for (let column = 0; column < size; column++) {
    // A shallow random walk keeps neighbouring columns related, so the fringe has
    // clumps in it instead of looking like per-pixel noise.
    const depth = baseDepth + Math.round(Math.sin(column * 0.9) * 1.6 + (rand() - 0.5) * 3.4);
    for (let row = 0; row < depth; row++) {
      // Darker towards the bottom of the fringe, where the blades are in shadow.
      const t = row / Math.max(1, depth - 1);
      // Lighter at the top where the turf catches the sky, shading down into the
      // fringe. Bounded to the ramp so the side never disagrees with the top.
      const shade = Math.min(GRASS_GREENS.length - 1, Math.max(0, Math.floor((1 - t) * 4 + rand() * 3)));
      ctx.fillStyle = GRASS_GREENS[shade];
      ctx.fillRect(x + column, y + row, 1, 1);
    }
    // A blade or two hanging past the fringe.
    if (rand() < 0.3) {
      ctx.fillStyle = pick(GRASS_GREENS.slice(0, 4), rand);
      ctx.fillRect(x + column, y + depth, 1, 1 + Math.floor(rand() * 2));
    }
  }
}

/**
 * Builds the atlas.
 *
 * Each tile is drawn into its cell and then its border is duplicated outwards into
 * the gutter, so mipmapping never averages one tile against its neighbour.
 */
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

  // Blank: white, the identity for a multiply.
  {
    const [x, y] = originOf(Tile.Blank);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, TILE_PIXELS, TILE_PIXELS);
  }
  {
    const [x, y] = originOf(Tile.GrassTop);
    drawGrassTop(ctx, x, y, TILE_PIXELS, rand);
  }
  {
    const [x, y] = originOf(Tile.GrassSide);
    drawGrassSide(ctx, x, y, TILE_PIXELS, rand);
  }
  {
    const [x, y] = originOf(Tile.Dirt);
    drawSoil(ctx, x, y, TILE_PIXELS, TILE_PIXELS, rand);
  }

  // Gutters: extend each tile's edge pixels outwards.
  for (const tile of [Tile.Blank, Tile.GrassTop, Tile.GrassSide, Tile.Dirt]) {
    const [x, y] = originOf(tile);
    const p = TILE_PADDING;
    const s = TILE_PIXELS;
    // Sides.
    ctx.drawImage(canvas, x, y, 1, s, x - p, y, p, s);
    ctx.drawImage(canvas, x + s - 1, y, 1, s, x + s, y, p, s);
    ctx.drawImage(canvas, x, y, s, 1, x, y - p, s, p);
    ctx.drawImage(canvas, x, y + s - 1, s, 1, x, y + s, s, p);
    // Corners.
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
