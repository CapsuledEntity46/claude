import { type BlockShape, shapeBlocksMovement, shapeBoxes, shapeIsFullCube, type ShapeBox } from './shapes';

/**
 * Block registry.
 *
 * Blocks are plain integer ids stored in Uint8Array chunk buffers, paired with a
 * `meta` byte holding orientation and state. Appearance is driven by per-face RGB
 * colors rather than a texture atlas: it keeps the project asset-free, and
 * combined with per-vertex ambient occlusion in the mesher it still reads clearly
 * as a voxel world.
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
  Torch = 17,
  // --- shaped building materials ---
  StoneSlab = 18,
  PlankSlab = 19,
  StoneStairs = 20,
  PlankStairs = 21,
  BrickStairs = 22,
  Window = 23,
  Door = 24,
  Fence = 25,
  Shingles = 26,
  // --- dungeon set ---
  DungeonBrick = 27,
  MossyBrick = 28,
  CrackedBrick = 29,
  Rubble = 30,

  // --- Tectonic terrain ---
  /** Deep-earth lava, filling the tunnels below the cave layer. */
  Lava = 31,
  /** Banded canyon rock, the badlands' surface and strata. */
  Terracotta = 32,
  /** A paler band, so canyon walls read as layered rather than flat. */
  PaleTerracotta = 33,
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
  /** Geometry and collision profile. Non-cube shapes never cull neighbours. */
  readonly shape: BlockShape;
  /** Placement orientation follows the player's facing. */
  readonly oriented: boolean;
  /** Right-clicking toggles the open bit. */
  readonly interactive: boolean;
  /** Grouped into the Materials tab, and exempt from carry weight. */
  readonly material: boolean;
}

interface DefOptions {
  solid?: boolean;
  opaque?: boolean;
  emissive?: number;
  shape?: BlockShape;
  oriented?: boolean;
  interactive?: boolean;
  material?: boolean;
}

function def(
  id: Block,
  name: string,
  glyph: string,
  hardness: number,
  side: RGB,
  top: RGB = side,
  bottom: RGB = side,
  opts: DefOptions = {},
): BlockDef {
  const shape = opts.shape ?? 'cube';
  return {
    id,
    name,
    glyph,
    hardness,
    side,
    top,
    bottom,
    solid: opts.solid ?? true,
    // A shape that does not fill its voxel must not hide its neighbours' faces,
    // or you would see through the gaps around it.
    opaque: (opts.opaque ?? true) && shapeIsFullCube(shape),
    emissive: opts.emissive ?? 0,
    shape,
    oriented: opts.oriented ?? false,
    interactive: opts.interactive ?? false,
    material: opts.material ?? true,
  };
}

const AIR = def(Block.Air, 'Air', '·', 0, [0, 0, 0], [0, 0, 0], [0, 0, 0], {
  solid: false,
  opaque: false,
  material: false,
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
  put(def(Block.Water, 'Water', '🌊', 0, [0.18, 0.36, 0.62], [0.2, 0.4, 0.7], [0.16, 0.3, 0.55], { solid: false, opaque: false, material: false }));
  put(def(Block.Bedrock, 'Bedrock', '⬛', Infinity, [0.14, 0.14, 0.16], undefined, undefined, { material: false }));
  put(def(Block.Brick, 'Brick', '🟥', 1.8, [0.55, 0.27, 0.22]));
  put(def(Block.Glass, 'Glass', '🪟', 0.3, [0.72, 0.85, 0.9], [0.72, 0.85, 0.9], [0.72, 0.85, 0.9], { opaque: false }));
  put(def(Block.Torchstone, 'Glowstone', '💡', 0.6, [0.95, 0.8, 0.42], [1.0, 0.88, 0.5], [0.9, 0.74, 0.38], { emissive: 0.55 }));

  // A real torch: a slim post with a burning head, not a glowing crate.
  put(def(Block.Torch, 'Torch', '🕯️', 0.1, [0.42, 0.29, 0.16], [1.0, 0.66, 0.26], [0.36, 0.25, 0.14], {
    emissive: 0.5,
    shape: 'torch',
    solid: false,
  }));

  // --- shaped building materials -------------------------------------------
  put(def(Block.StoneSlab, 'Stone Slab', '▬', 1.3, [0.5, 0.5, 0.53], undefined, undefined, { shape: 'slab' }));
  put(def(Block.PlankSlab, 'Plank Slab', '▬', 0.8, [0.65, 0.48, 0.28], undefined, undefined, { shape: 'slab' }));
  put(def(Block.StoneStairs, 'Stone Stairs', '🪜', 1.4, [0.5, 0.5, 0.53], undefined, undefined, { shape: 'stairs', oriented: true }));
  put(def(Block.PlankStairs, 'Plank Stairs', '🪜', 0.9, [0.65, 0.48, 0.28], undefined, undefined, { shape: 'stairs', oriented: true }));
  put(def(Block.BrickStairs, 'Brick Stairs', '🪜', 1.7, [0.55, 0.27, 0.22], undefined, undefined, { shape: 'stairs', oriented: true }));
  put(def(Block.Window, 'Window', '🪟', 0.3, [0.74, 0.87, 0.93], undefined, undefined, { shape: 'pane', oriented: true, opaque: false }));
  put(def(Block.Door, 'Door', '🚪', 1.0, [0.6, 0.42, 0.24], [0.66, 0.48, 0.28], [0.52, 0.36, 0.2], { shape: 'door', oriented: true, interactive: true }));
  put(def(Block.Fence, 'Fence', '🚧', 0.7, [0.58, 0.43, 0.25], undefined, undefined, { shape: 'fence', oriented: true, solid: true }));
  put(def(Block.Shingles, 'Roof Shingles', '🏠', 1.0, [0.42, 0.26, 0.24], [0.5, 0.31, 0.28], [0.36, 0.22, 0.2], { shape: 'wedge', oriented: true }));

  // --- dungeon set ----------------------------------------------------------
  put(def(Block.DungeonBrick, 'Dungeon Brick', '🧱', 2.2, [0.34, 0.34, 0.38]));
  put(def(Block.MossyBrick, 'Mossy Brick', '🧱', 2.0, [0.3, 0.38, 0.31]));
  put(def(Block.CrackedBrick, 'Cracked Brick', '🧱', 1.8, [0.38, 0.36, 0.34]));
  put(def(Block.Rubble, 'Rubble', '🪨', 0.9, [0.4, 0.38, 0.36]));

  // Lava behaves like water for movement — you fall into it, not onto it — but
  // lights its own tunnels. Emissive so the caves it fills are visible without
  // the player carrying a torch into them.
  put(
    def(Block.Lava, 'Lava', '\u{1F525}', 0, [0.95, 0.38, 0.09], [1, 0.52, 0.12], [0.7, 0.24, 0.05], {
      solid: false,
      opaque: false,
      material: false,
      emissive: 0.85,
    }),
  );
  put(def(Block.Terracotta, 'Terracotta', '\u{1F9F1}', 1.4, [0.69, 0.34, 0.19], [0.72, 0.37, 0.21], [0.62, 0.3, 0.16]));
  put(def(Block.PaleTerracotta, 'Pale Terracotta', '\u{1F3FA}', 1.4, [0.82, 0.58, 0.36], [0.85, 0.62, 0.4], [0.76, 0.52, 0.31]));

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

/**
 * Whether a block can be aimed at: mined, or built against.
 *
 * Distinct from `isSolid`, which is about movement. A torch stops nothing but
 * must still be minable, and water blocks nothing and must not be.
 */
export function isTargetable(id: number): boolean {
  return id !== Block.Air && id !== Block.Water && id !== Block.Lava;
}

/** The collision boxes a block occupies, or an empty list if it blocks nothing. */
export function blockCollisionBoxes(id: number, meta: number): readonly ShapeBox[] {
  const d = BLOCKS[id] ?? AIR;
  if (!d.solid) return EMPTY_BOXES;
  if (!shapeBlocksMovement(d.shape, meta)) return EMPTY_BOXES;
  return shapeBoxes(d.shape, meta);
}

const EMPTY_BOXES: readonly ShapeBox[] = [];

/** True for blocks that should cast a dynamic point light nearby. */
export function isLightSource(id: number): boolean {
  return ((BLOCKS[id] ?? AIR).emissive ?? 0) > 0.2;
}

/** Warm tint of the light a block emits. */
export function lightColorOf(id: number): RGB {
  return (BLOCKS[id] ?? AIR).top;
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
  Block.Torch,
  Block.StoneSlab,
  Block.PlankSlab,
  Block.StoneStairs,
  Block.PlankStairs,
  Block.BrickStairs,
  Block.Window,
  Block.Door,
  Block.Fence,
  Block.Shingles,
  Block.DungeonBrick,
  Block.MossyBrick,
  Block.Terracotta,
  Block.PaleTerracotta,
];
