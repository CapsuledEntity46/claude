/** Terrain tile taxonomy plus the palettes and movement rules derived from it. */

export const TILE_SIZE = 32;

export const enum Tile {
  DeepWater = 0,
  Water = 1,
  Sand = 2,
  Grass = 3,
  DryGrass = 4,
  ForestFloor = 5,
  Rock = 6,
  Snow = 7,
  Dirt = 8,
  Road = 9,
  RoadLine = 10,
  FloorWood = 11,
  FloorConcrete = 12,
  FloorTile = 13,
  Gravel = 14,
  Farmland = 15,
  Count = 16,
}

export interface TileInfo {
  name: string;
  /** Base colour, plus a second colour that per-tile noise blends toward. */
  c0: [number, number, number];
  c1: [number, number, number];
  /** Movement multiplier (1 = normal). */
  speed: number;
  water: boolean;
  swimmable: boolean;
  /** Footstep material, drives audio + noise radius. */
  material: 'soft' | 'hard' | 'water' | 'wood' | 'gravel';
  /** How much a tile muffles footsteps — affects how far zombies hear you. */
  noise: number;
  indoor: boolean;
}

export const TILES: Record<Tile, TileInfo> = {
  [Tile.DeepWater]: { name: 'deep water', c0: [18, 38, 58], c1: [12, 28, 46], speed: 0.45, water: true, swimmable: true, material: 'water', noise: 1.1, indoor: false },
  [Tile.Water]: { name: 'water', c0: [34, 68, 92], c1: [26, 56, 80], speed: 0.6, water: true, swimmable: true, material: 'water', noise: 1.2, indoor: false },
  [Tile.Sand]: { name: 'sand', c0: [140, 126, 92], c1: [122, 110, 80], speed: 0.92, water: false, swimmable: false, material: 'soft', noise: 0.7, indoor: false },
  [Tile.Grass]: { name: 'grass', c0: [62, 82, 48], c1: [50, 70, 40], speed: 1, water: false, swimmable: false, material: 'soft', noise: 0.6, indoor: false },
  [Tile.DryGrass]: { name: 'dry grass', c0: [92, 92, 54], c1: [78, 80, 46], speed: 1, water: false, swimmable: false, material: 'soft', noise: 0.75, indoor: false },
  [Tile.ForestFloor]: { name: 'forest floor', c0: [44, 56, 36], c1: [34, 44, 28], speed: 0.94, water: false, swimmable: false, material: 'soft', noise: 0.55, indoor: false },
  [Tile.Rock]: { name: 'rock', c0: [86, 86, 88], c1: [68, 68, 72], speed: 0.88, water: false, swimmable: false, material: 'hard', noise: 1, indoor: false },
  [Tile.Snow]: { name: 'snow', c0: [186, 194, 202], c1: [166, 176, 186], speed: 0.8, water: false, swimmable: false, material: 'soft', noise: 0.5, indoor: false },
  [Tile.Dirt]: { name: 'dirt', c0: [78, 64, 48], c1: [64, 52, 40], speed: 1, water: false, swimmable: false, material: 'soft', noise: 0.7, indoor: false },
  [Tile.Road]: { name: 'road', c0: [56, 56, 58], c1: [46, 46, 49], speed: 1.12, water: false, swimmable: false, material: 'hard', noise: 1, indoor: false },
  [Tile.RoadLine]: { name: 'road', c0: [124, 116, 74], c1: [56, 56, 58], speed: 1.12, water: false, swimmable: false, material: 'hard', noise: 1, indoor: false },
  [Tile.FloorWood]: { name: 'floorboards', c0: [96, 74, 52], c1: [82, 62, 43], speed: 1, water: false, swimmable: false, material: 'wood', noise: 1.25, indoor: true },
  [Tile.FloorConcrete]: { name: 'concrete', c0: [92, 92, 90], c1: [80, 80, 79], speed: 1, water: false, swimmable: false, material: 'hard', noise: 1.1, indoor: true },
  [Tile.FloorTile]: { name: 'tiles', c0: [126, 128, 124], c1: [108, 110, 108], speed: 1, water: false, swimmable: false, material: 'hard', noise: 1.15, indoor: true },
  [Tile.Gravel]: { name: 'gravel', c0: [96, 92, 86], c1: [78, 75, 70], speed: 0.97, water: false, swimmable: false, material: 'gravel', noise: 1.3, indoor: false },
  [Tile.Farmland]: { name: 'farmland', c0: [72, 58, 40], c1: [88, 78, 44], speed: 0.95, water: false, swimmable: false, material: 'soft', noise: 0.7, indoor: false },
  [Tile.Count]: { name: '', c0: [0, 0, 0], c1: [0, 0, 0], speed: 1, water: false, swimmable: false, material: 'soft', noise: 1, indoor: false },
};

/** Biome bands — used for spawn rules, temperature offsets and prop selection. */
export const enum Biome {
  Ocean = 0,
  Beach = 1,
  Plains = 2,
  Forest = 3,
  Badlands = 4,
  Mountain = 5,
  Tundra = 6,
}

export const BIOME_NAMES: Record<Biome, string> = {
  [Biome.Ocean]: 'Ocean',
  [Biome.Beach]: 'Shoreline',
  [Biome.Plains]: 'Plains',
  [Biome.Forest]: 'Forest',
  [Biome.Badlands]: 'Badlands',
  [Biome.Mountain]: 'Mountains',
  [Biome.Tundra]: 'Tundra',
};

/** Ambient temperature offset per biome, in degrees C. */
export const BIOME_TEMP: Record<Biome, number> = {
  [Biome.Ocean]: -2,
  [Biome.Beach]: 2,
  [Biome.Plains]: 0,
  [Biome.Forest]: -1,
  [Biome.Badlands]: 7,
  [Biome.Mountain]: -9,
  [Biome.Tundra]: -16,
};

export const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Blend two colours; `t` of 0 returns `a`. */
export function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
