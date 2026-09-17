/**
 * Block registry.
 *
 * Blocks are plain integer ids stored in Uint8Array chunk buffers. Appearance is
 * driven by per-face RGB colors rather than a texture atlas: it keeps the project
 * asset-free, and combined with per-vertex ambient occlusion in the mesher it
 * still reads clearly as a voxel world.
 */

export const enum Block {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Cobble = 4,
  Sand = 5,
  Wood = 6,
  Leaves = 7,
  Planks = 8,
  IronOre = 9,
  GoldOre = 10,
  Snow = 11,
  Water = 12,
  Bedrock = 13,
  Brick = 14,
  Glass = 15,
  Torchstone = 16,
}

export type RGB = readonly [number, number, number];

export interface BlockDef {
  readonly id: Block;
  readonly name: string;
  /** Blocks movement and stops raycasts. */
  readonly solid: boolean;
  /** Hides the neighbouring face when adjacent (false for glass/water/leaves). */
  readonly opaque: boolean;
  /** Seconds of continuous mining to break. */
  readonly hardness: number;
  readonly top: RGB;
  readonly side: RGB;
  readonly bottom: RGB;
  /** Emoji-ish glyph used by the hotbar and inventory UI. */
  readonly glyph: string;
  /** Extra emissive lift so "glowing" blocks do not go fully dark. */
  readonly emissive?: number;
}

function def(
  id: Block,
  name: string,
  glyph: string,
  hardness: number,
  side: RGB,
  top: RGB = side,
  bottom: RGB = side,
  opts: { solid?: boolean; opaque?: boolean; emissive?: number } = {},
): BlockDef {
  return {
    id,
    name,
    glyph,
    hardness,
    side,
    top,
    bottom,
    solid: opts.solid ?? true,
    opaque: opts.opaque ?? true,
    emissive: opts.emissive ?? 0,
  };
}

const AIR = def(Block.Air, 'Air', '·', 0, [0, 0, 0], [0, 0, 0], [0, 0, 0], {
  solid: false,
  opaque: false,
});

export const BLOCKS: readonly BlockDef[] = (() => {
  const list: BlockDef[] = [];
  const put = (d: BlockDef) => {
    list[d.id] = d;
  };

  put(AIR);
  put(def(Block.Grass, 'Grass', '🟩', 0.5, [0.44, 0.33, 0.2], [0.36, 0.62, 0.28], [0.4, 0.29, 0.18]));
  put(def(Block.Dirt, 'Dirt', '🟫', 0.5, [0.44, 0.33, 0.2]));
  put(def(Block.Stone, 'Stone', '⬜', 1.4, [0.49, 0.49, 0.52]));
  put(def(Block.Cobble, 'Cobblestone', '🧱', 1.6, [0.42, 0.42, 0.45]));
  put(def(Block.Sand, 'Sand', '🟨', 0.45, [0.85, 0.79, 0.56]));
  put(def(Block.Wood, 'Wood', '🪵', 1.0, [0.42, 0.31, 0.18], [0.55, 0.42, 0.26], [0.55, 0.42, 0.26]));
  put(def(Block.Leaves, 'Leaves', '🍃', 0.25, [0.22, 0.46, 0.2], [0.24, 0.5, 0.22], [0.2, 0.4, 0.18], { opaque: false }));
  put(def(Block.Planks, 'Planks', '🟧', 0.9, [0.65, 0.48, 0.28]));
  put(def(Block.IronOre, 'Iron Ore', '⛏️', 2.2, [0.55, 0.5, 0.47]));
  put(def(Block.GoldOre, 'Gold Ore', '🪙', 2.6, [0.6, 0.55, 0.35]));
  put(def(Block.Snow, 'Snow', '⬜', 0.4, [0.92, 0.94, 0.98]));
  put(def(Block.Water, 'Water', '🌊', 0, [0.18, 0.36, 0.62], [0.2, 0.4, 0.7], [0.16, 0.3, 0.55], { solid: false, opaque: false }));
  put(def(Block.Bedrock, 'Bedrock', '⬛', Infinity, [0.14, 0.14, 0.16]));
  put(def(Block.Brick, 'Brick', '🟥', 1.8, [0.55, 0.27, 0.22]));
  put(def(Block.Glass, 'Glass', '🪟', 0.3, [0.72, 0.85, 0.9], [0.72, 0.85, 0.9], [0.72, 0.85, 0.9], { opaque: false }));
  put(def(Block.Torchstone, 'Glowstone', '💡', 0.6, [0.95, 0.8, 0.42], [1.0, 0.88, 0.5], [0.9, 0.74, 0.38], { emissive: 0.55 }));

  // Fill any accidental gaps so lookups never return undefined.
  for (let i = 0; i < list.length; i++) if (!list[i]) list[i] = AIR;
  return list;
})();

export function blockDef(id: number): BlockDef {
  return BLOCKS[id] ?? AIR;
}

export function isSolid(id: number): boolean {
  return (BLOCKS[id] ?? AIR).solid;
}

export function isOpaque(id: number): boolean {
  return (BLOCKS[id] ?? AIR).opaque;
}

export function isAir(id: number): boolean {
  return id === Block.Air;
}

/** What a block yields when mined. Stone drops cobble, like you'd expect. */
export function blockDrop(id: number): Block | null {
  switch (id) {
    case Block.Stone:
      return Block.Cobble;
    case Block.Grass:
      return Block.Dirt;
    case Block.Leaves:
      return null;
    case Block.Bedrock:
    case Block.Air:
    case Block.Water:
      return null;
    default:
      return id as Block;
  }
}

/** Blocks the player can place from the hotbar. */
export const PLACEABLE: readonly Block[] = [
  Block.Dirt,
  Block.Cobble,
  Block.Planks,
  Block.Stone,
  Block.Sand,
  Block.Brick,
  Block.Glass,
  Block.Torchstone,
];
