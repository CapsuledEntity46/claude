/**
 * World props: everything standing in the world that isn't a creature or a wall.
 *
 * Three overlapping roles, any of which a prop may have:
 *  - obstacle  (`radius` > 0)         — blocks movement, maybe sight
 *  - harvestable (`harvest`)          — yields resources when struck with the right tool
 *  - container (`container`)          — holds rolled loot you can open with E
 */

import type { LootTableName } from '../items/lootTables';
import type { ToolClass } from '../items/itemdefs';

export type PropKind =
  // nature
  | 'tree_oak' | 'tree_pine' | 'tree_dead' | 'bush' | 'hemp' | 'log' | 'stump'
  | 'rock_small' | 'rock_large' | 'ore_metal' | 'ore_sulfur' | 'ore_hqm'
  | 'corn_plant' | 'pumpkin_plant' | 'reeds'
  // town exterior
  | 'car' | 'car_wreck' | 'streetlight' | 'fence_wood' | 'fence_chain'
  | 'dumpster' | 'trashbag' | 'gas_pump' | 'haybale' | 'well' | 'tombstone'
  | 'sandbag' | 'barbwire' | 'water_tower' | 'sign' | 'pallet' | 'tire' | 'crate_wood'
  // interior furniture
  | 'fridge' | 'stove' | 'sink' | 'counter' | 'shelf' | 'wardrobe' | 'bed'
  | 'sofa' | 'table' | 'chair' | 'desk' | 'bookshelf' | 'toilet' | 'bathtub'
  | 'locker' | 'toolbox' | 'safe' | 'crate_military' | 'ammo_box' | 'medbox' | 'barrel';

export interface HarvestSpec {
  item: string;
  /** Yield per successful hit. */
  min: number;
  max: number;
  /** Tool classes that work well; others do a fraction of the damage. */
  tool: ToolClass;
  /** Total prop hit points; tool power is the damage per swing. */
  hp: number;
  /** Optional bonus item rolled occasionally. */
  bonus?: { item: string; chance: number; min: number; max: number };
}

export interface PropDef {
  name: string;
  /** Collision radius in world units; 0 means walk-through. */
  radius: number;
  blocksSight: boolean;
  /** Visual size for the renderer, in world units. */
  size: number;
  /** Apparent height — drives shadow length and draw order offset. */
  height: number;
  harvest?: HarvestSpec;
  container?: { cols: number; rows: number; table: LootTableName; label: string; lockChance?: number };
  /** Emits light at night (streetlights). */
  light?: number;
  /** Hurts anything walking over it. */
  damageOnTouch?: number;
  /** Destructible by explosives/melee without yielding resources. */
  hp?: number;
  /** Indoor props are hidden while the roof is drawn. */
  indoor?: boolean;
}

const P = (def: PropDef): PropDef => def;

export const PROPS: Record<PropKind, PropDef> = {
  // ------------------------------------------------------------------ nature
  tree_oak: P({
    name: 'Oak Tree', radius: 17, blocksSight: true, size: 86, height: 120,
    harvest: { item: 'wood', min: 22, max: 34, tool: 'wood', hp: 100, bonus: { item: 'plant_fiber', chance: 0.3, min: 1, max: 3 } },
  }),
  tree_pine: P({
    name: 'Pine Tree', radius: 14, blocksSight: true, size: 72, height: 150,
    harvest: { item: 'wood', min: 18, max: 28, tool: 'wood', hp: 90 },
  }),
  tree_dead: P({
    name: 'Dead Tree', radius: 12, blocksSight: false, size: 60, height: 100,
    harvest: { item: 'wood', min: 12, max: 20, tool: 'wood', hp: 60 },
  }),
  bush: P({
    name: 'Bush', radius: 0, blocksSight: false, size: 42, height: 26,
    harvest: { item: 'plant_fiber', min: 2, max: 5, tool: 'flesh', hp: 24, bonus: { item: 'berries', chance: 0.55, min: 1, max: 3 } },
  }),
  hemp: P({
    name: 'Hemp Plant', radius: 0, blocksSight: false, size: 38, height: 40,
    harvest: { item: 'cloth', min: 4, max: 8, tool: 'flesh', hp: 20, bonus: { item: 'plant_fiber', chance: 0.7, min: 2, max: 5 } },
  }),
  log: P({
    name: 'Fallen Log', radius: 15, blocksSight: false, size: 96, height: 24,
    harvest: { item: 'wood', min: 14, max: 22, tool: 'wood', hp: 70 },
  }),
  stump: P({ name: 'Stump', radius: 11, blocksSight: false, size: 34, height: 18, harvest: { item: 'wood', min: 6, max: 12, tool: 'wood', hp: 40 } }),
  rock_small: P({
    name: 'Rock', radius: 16, blocksSight: false, size: 52, height: 34,
    harvest: { item: 'stone', min: 18, max: 30, tool: 'stone', hp: 90 },
  }),
  rock_large: P({
    name: 'Boulder', radius: 30, blocksSight: true, size: 96, height: 72,
    harvest: { item: 'stone', min: 30, max: 48, tool: 'stone', hp: 170, bonus: { item: 'metal_ore', chance: 0.3, min: 2, max: 6 } },
  }),
  ore_metal: P({
    name: 'Metal Ore Node', radius: 22, blocksSight: false, size: 68, height: 48,
    harvest: { item: 'metal_ore', min: 14, max: 24, tool: 'stone', hp: 140, bonus: { item: 'stone', chance: 0.6, min: 5, max: 14 } },
  }),
  ore_sulfur: P({
    name: 'Sulfur Ore Node', radius: 22, blocksSight: false, size: 68, height: 48,
    harvest: { item: 'sulfur_ore', min: 12, max: 20, tool: 'stone', hp: 140, bonus: { item: 'stone', chance: 0.5, min: 4, max: 12 } },
  }),
  ore_hqm: P({
    name: 'High Quality Ore', radius: 20, blocksSight: false, size: 58, height: 42,
    harvest: { item: 'hqm_ore', min: 2, max: 5, tool: 'metal', hp: 180, bonus: { item: 'metal_ore', chance: 0.7, min: 4, max: 10 } },
  }),
  corn_plant: P({ name: 'Corn', radius: 0, blocksSight: false, size: 36, height: 54, harvest: { item: 'corn', min: 1, max: 2, tool: 'flesh', hp: 14, bonus: { item: 'seeds', chance: 0.5, min: 1, max: 3 } } }),
  pumpkin_plant: P({ name: 'Pumpkin Patch', radius: 0, blocksSight: false, size: 44, height: 24, harvest: { item: 'pumpkin', min: 1, max: 1, tool: 'flesh', hp: 18, bonus: { item: 'seeds', chance: 0.6, min: 1, max: 4 } } }),
  reeds: P({ name: 'Reeds', radius: 0, blocksSight: false, size: 40, height: 44, harvest: { item: 'plant_fiber', min: 3, max: 6, tool: 'flesh', hp: 12 } }),

  // ------------------------------------------------------- town, exterior
  car: P({
    name: 'Abandoned Car', radius: 34, blocksSight: true, size: 120, height: 52, hp: 400,
    container: { cols: 5, rows: 3, table: 'car', label: 'Car Boot' },
  }),
  car_wreck: P({
    name: 'Burnt-Out Car', radius: 32, blocksSight: true, size: 112, height: 44, hp: 300,
    harvest: { item: 'metal_frag', min: 12, max: 24, tool: 'metal', hp: 200, bonus: { item: 'scrap', chance: 0.4, min: 1, max: 3 } },
  }),
  streetlight: P({ name: 'Street Light', radius: 7, blocksSight: false, size: 20, height: 150, light: 210, hp: 120 }),
  fence_wood: P({ name: 'Wooden Fence', radius: 0, blocksSight: false, size: 64, height: 40, hp: 90, harvest: { item: 'wood', min: 6, max: 12, tool: 'wood', hp: 50 } }),
  fence_chain: P({ name: 'Chain Fence', radius: 0, blocksSight: false, size: 64, height: 60, hp: 140, harvest: { item: 'metal_frag', min: 6, max: 14, tool: 'metal', hp: 80 } }),
  dumpster: P({
    name: 'Dumpster', radius: 28, blocksSight: false, size: 92, height: 46, hp: 250,
    container: { cols: 5, rows: 3, table: 'trash', label: 'Dumpster' },
  }),
  trashbag: P({
    name: 'Rubbish Pile', radius: 0, blocksSight: false, size: 40, height: 24,
    container: { cols: 3, rows: 2, table: 'trash', label: 'Rubbish' },
  }),
  gas_pump: P({
    name: 'Fuel Pump', radius: 16, blocksSight: false, size: 44, height: 70, hp: 120,
    container: { cols: 3, rows: 2, table: 'gas_station', label: 'Fuel Pump' },
  }),
  haybale: P({ name: 'Hay Bale', radius: 24, blocksSight: false, size: 74, height: 50, harvest: { item: 'plant_fiber', min: 8, max: 16, tool: 'flesh', hp: 40, bonus: { item: 'seeds', chance: 0.4, min: 1, max: 4 } } }),
  well: P({ name: 'Stone Well', radius: 26, blocksSight: false, size: 78, height: 46 }),
  tombstone: P({ name: 'Gravestone', radius: 12, blocksSight: false, size: 32, height: 44, hp: 100 }),
  sandbag: P({ name: 'Sandbag Wall', radius: 22, blocksSight: false, size: 72, height: 42, hp: 300 }),
  barbwire: P({ name: 'Barbed Wire', radius: 0, blocksSight: false, size: 68, height: 30, damageOnTouch: 9, hp: 120 }),
  water_tower: P({ name: 'Water Tower', radius: 40, blocksSight: true, size: 130, height: 260, hp: 900 }),
  sign: P({ name: 'Road Sign', radius: 6, blocksSight: false, size: 26, height: 80, hp: 60 }),
  pallet: P({ name: 'Pallet Stack', radius: 20, blocksSight: false, size: 64, height: 32, harvest: { item: 'wood', min: 10, max: 18, tool: 'wood', hp: 50 } }),
  tire: P({ name: 'Tyre Pile', radius: 18, blocksSight: false, size: 54, height: 34, hp: 90 }),
  crate_wood: P({
    name: 'Wooden Crate', radius: 19, blocksSight: false, size: 58, height: 44, hp: 120,
    container: { cols: 6, rows: 3, table: 'crate_wood', label: 'Wooden Crate' },
  }),

  // ------------------------------------------------------- interior furniture
  fridge: P({
    name: 'Refrigerator', radius: 20, blocksSight: false, size: 58, height: 76, indoor: true, hp: 200,
    container: { cols: 5, rows: 3, table: 'fridge', label: 'Refrigerator' },
  }),
  stove: P({
    name: 'Stove', radius: 20, blocksSight: false, size: 58, height: 52, indoor: true, hp: 200,
    container: { cols: 4, rows: 3, table: 'kitchen', label: 'Stove' },
  }),
  sink: P({
    name: 'Sink', radius: 18, blocksSight: false, size: 52, height: 44, indoor: true, hp: 120,
    container: { cols: 4, rows: 2, table: 'kitchen', label: 'Sink Cupboard' },
  }),
  counter: P({
    name: 'Counter', radius: 20, blocksSight: false, size: 72, height: 44, indoor: true, hp: 150,
    container: { cols: 5, rows: 3, table: 'kitchen', label: 'Counter' },
  }),
  shelf: P({
    name: 'Shelf', radius: 14, blocksSight: false, size: 68, height: 74, indoor: true, hp: 100,
    container: { cols: 6, rows: 2, table: 'shop', label: 'Shelf' },
  }),
  wardrobe: P({
    name: 'Wardrobe', radius: 22, blocksSight: false, size: 66, height: 90, indoor: true, hp: 160,
    container: { cols: 5, rows: 4, table: 'wardrobe', label: 'Wardrobe' },
  }),
  bed: P({
    name: 'Bed', radius: 26, blocksSight: false, size: 96, height: 30, indoor: true,
    container: { cols: 4, rows: 2, table: 'bedroom', label: 'Under the Bed' },
  }),
  sofa: P({
    name: 'Sofa', radius: 24, blocksSight: false, size: 96, height: 38, indoor: true,
    container: { cols: 4, rows: 2, table: 'livingroom', label: 'Sofa Cushions' },
  }),
  table: P({ name: 'Table', radius: 22, blocksSight: false, size: 78, height: 38, indoor: true, hp: 100 }),
  chair: P({ name: 'Chair', radius: 12, blocksSight: false, size: 36, height: 42, indoor: true, hp: 50, harvest: { item: 'wood', min: 4, max: 9, tool: 'wood', hp: 30 } }),
  desk: P({
    name: 'Desk', radius: 22, blocksSight: false, size: 82, height: 42, indoor: true, hp: 120,
    container: { cols: 5, rows: 3, table: 'livingroom', label: 'Desk' },
  }),
  bookshelf: P({
    name: 'Bookshelf', radius: 18, blocksSight: true, size: 70, height: 96, indoor: true, hp: 120,
    container: { cols: 6, rows: 3, table: 'livingroom', label: 'Bookshelf' },
  }),
  toilet: P({
    name: 'Toilet', radius: 14, blocksSight: false, size: 40, height: 44, indoor: true, hp: 80,
    container: { cols: 3, rows: 2, table: 'bathroom', label: 'Cistern' },
  }),
  bathtub: P({
    name: 'Bathtub', radius: 24, blocksSight: false, size: 88, height: 34, indoor: true, hp: 140,
    container: { cols: 4, rows: 2, table: 'bathroom', label: 'Bathtub' },
  }),
  locker: P({
    name: 'Locker', radius: 18, blocksSight: false, size: 54, height: 92, indoor: true, hp: 180,
    container: { cols: 4, rows: 4, table: 'locker', label: 'Locker', lockChance: 0.2 },
  }),
  toolbox: P({
    name: 'Toolbox', radius: 14, blocksSight: false, size: 44, height: 30, indoor: true, hp: 100,
    container: { cols: 4, rows: 3, table: 'toolbox', label: 'Toolbox' },
  }),
  safe: P({
    name: 'Floor Safe', radius: 16, blocksSight: false, size: 48, height: 40, indoor: true, hp: 600,
    container: { cols: 5, rows: 3, table: 'safe', label: 'Safe', lockChance: 0.85 },
  }),
  crate_military: P({
    name: 'Military Crate', radius: 22, blocksSight: false, size: 74, height: 46, hp: 200,
    container: { cols: 6, rows: 4, table: 'military_crate', label: 'Military Crate', lockChance: 0.35 },
  }),
  ammo_box: P({
    name: 'Ammo Box', radius: 16, blocksSight: false, size: 50, height: 34, hp: 150,
    container: { cols: 4, rows: 3, table: 'military', label: 'Ammo Box' },
  }),
  medbox: P({
    name: 'Medical Cabinet', radius: 16, blocksSight: false, size: 52, height: 70, indoor: true, hp: 120,
    container: { cols: 4, rows: 3, table: 'hospital', label: 'Medical Cabinet' },
  }),
  barrel: P({
    name: 'Barrel', radius: 18, blocksSight: false, size: 52, height: 56, hp: 120,
    container: { cols: 4, rows: 3, table: 'barrel', label: 'Barrel' },
  }),
};

export const propDef = (k: PropKind): PropDef => PROPS[k];
