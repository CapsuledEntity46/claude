/**
 * Crafting recipes.
 *
 * Progression is gated by *stations* rather than an XP tree: you can whittle a
 * spear anywhere, but a bolt-action rifle needs a level 3 workbench, which needs
 * a level 2 workbench's worth of resources to build.
 */

import { itemDef } from './itemdefs';

export type Station = 'none' | 'campfire' | 'furnace' | 'bench1' | 'bench2' | 'bench3';

export const STATION_LABEL: Record<Station, string> = {
  none: 'Hand', campfire: 'Campfire', furnace: 'Furnace',
  bench1: 'Workbench 1', bench2: 'Workbench 2', bench3: 'Workbench 3',
};

export interface Recipe {
  /** Output item id. Doubles as the recipe key. */
  out: string;
  count: number;
  /** `[itemId, quantity]` pairs. */
  cost: readonly (readonly [string, number])[];
  /** Seconds to craft one batch. */
  time: number;
  station: Station;
  group: string;
}

const R = (
  out: string,
  count: number,
  time: number,
  station: Station,
  group: string,
  ...cost: (readonly [string, number])[]
): Recipe => ({ out, count, time, station, group, cost });

export const RECIPES: readonly Recipe[] = [
  // ---------------------------------------------------------------- resources
  R('cloth', 3, 2, 'none', 'Resources', ['plant_fiber', 10]),
  R('rope', 1, 3, 'none', 'Resources', ['plant_fiber', 20]),
  R('rag', 2, 1.5, 'none', 'Resources', ['cloth', 2]),
  R('bone_frag', 4, 2, 'none', 'Resources', ['bone_club', 1]),
  R('charcoal', 10, 6, 'campfire', 'Resources', ['wood', 25]),
  R('low_fuel', 4, 8, 'campfire', 'Resources', ['animal_fat', 10], ['cloth', 3]),
  R('gunpowder', 10, 5, 'bench1', 'Resources', ['sulfur', 20], ['charcoal', 30]),
  R('metal_frag', 10, 5, 'furnace', 'Resources', ['metal_ore', 10], ['wood', 5]),
  R('hqm', 1, 8, 'furnace', 'Resources', ['hqm_ore', 5], ['wood', 10]),
  R('sulfur', 10, 5, 'furnace', 'Resources', ['sulfur_ore', 10], ['wood', 5]),
  R('nails_res', 12, 3, 'bench1', 'Resources', ['metal_frag', 20]),
  R('sheet_metal', 1, 6, 'bench2', 'Resources', ['metal_frag', 100]),
  R('tape', 2, 3, 'bench1', 'Resources', ['cloth', 6], ['low_fuel', 2]),

  // ---------------------------------------------------------------- cooking
  R('cooked_meat', 1, 4, 'campfire', 'Cooking', ['raw_meat', 1]),
  R('cooked_fish', 1, 3.5, 'campfire', 'Cooking', ['raw_fish', 1]),
  R('water_bottle', 1, 5, 'campfire', 'Cooking', ['dirty_water', 1]),
  R('bread', 1, 6, 'campfire', 'Cooking', ['seeds', 12]),

  // ---------------------------------------------------------------- medical
  R('bandage', 1, 3, 'none', 'Medical', ['rag', 2], ['cloth', 3]),
  R('splint', 1, 4, 'none', 'Medical', ['wood', 20], ['cloth', 8], ['rope', 1]),
  R('medkit', 1, 10, 'bench2', 'Medical', ['bandage', 4], ['cloth', 20], ['tape', 1]),
  R('blood_bag', 1, 12, 'bench2', 'Medical', ['cloth', 15], ['tech_trash', 1], ['rag', 4]),

  // ---------------------------------------------------------------- tools
  R('torch', 1, 2, 'none', 'Tools', ['wood', 5], ['cloth', 1]),
  R('stone_hatchet', 1, 5, 'none', 'Tools', ['wood', 20], ['stone', 15]),
  R('stone_pickaxe', 1, 5, 'none', 'Tools', ['wood', 20], ['stone', 15]),
  R('building_plan', 1, 3, 'none', 'Tools', ['wood', 20]),
  R('hammer', 1, 6, 'bench1', 'Tools', ['wood', 50], ['metal_frag', 100]),
  R('hatchet', 1, 8, 'bench1', 'Tools', ['wood', 75], ['metal_frag', 125]),
  R('pickaxe', 1, 8, 'bench1', 'Tools', ['wood', 100], ['metal_frag', 150]),
  R('shovel', 1, 6, 'bench1', 'Tools', ['wood', 60], ['metal_frag', 80]),
  R('canteen', 1, 6, 'bench1', 'Tools', ['metal_frag', 60]),
  R('lantern', 1, 7, 'bench1', 'Tools', ['metal_frag', 50], ['low_fuel', 10]),
  R('flashlight', 1, 8, 'bench2', 'Tools', ['metal_frag', 40], ['battery', 1], ['tech_trash', 1]),
  R('fishing_rod', 1, 6, 'bench1', 'Tools', ['wood', 40], ['rope', 1], ['wire', 5]),
  R('lockpick', 2, 4, 'bench1', 'Tools', ['metal_frag', 20], ['wire', 4]),
  R('binoculars', 1, 9, 'bench2', 'Tools', ['metal_frag', 60], ['tech_trash', 2]),
  R('compass_item', 1, 5, 'bench1', 'Tools', ['metal_frag', 30], ['wire', 2]),

  // ---------------------------------------------------------------- melee
  R('wooden_spear', 1, 5, 'none', 'Melee', ['wood', 30]),
  R('stone_spear', 1, 6, 'none', 'Melee', ['wood', 30], ['stone', 20]),
  R('bone_knife', 1, 4, 'none', 'Melee', ['bone_frag', 10]),
  R('bone_club', 1, 4, 'none', 'Melee', ['bone_frag', 15]),
  R('combat_knife', 1, 7, 'bench1', 'Melee', ['metal_frag', 75], ['wood', 15], ['cloth', 5]),
  R('machete', 1, 9, 'bench1', 'Melee', ['metal_frag', 125], ['wood', 30]),
  R('nail_bat', 1, 5, 'bench1', 'Melee', ['baseball_bat', 1], ['nails_res', 20]),
  R('crowbar', 1, 7, 'bench1', 'Melee', ['metal_frag', 110]),
  R('fire_axe', 1, 14, 'bench3', 'Melee', ['metal_frag', 175], ['hqm', 8], ['wood', 50]),
  R('sledgehammer', 1, 16, 'bench3', 'Melee', ['metal_frag', 200], ['hqm', 10], ['wood', 60]),
  R('katana', 1, 18, 'bench3', 'Melee', ['hqm', 20], ['metal_frag', 150], ['cloth', 10]),

  // ---------------------------------------------------------------- ranged
  R('bow', 1, 8, 'none', 'Firearms', ['wood', 50], ['cloth', 10]),
  R('crossbow', 1, 12, 'bench1', 'Firearms', ['wood', 200], ['metal_frag', 75], ['rope', 2]),
  R('revolver', 1, 12, 'bench1', 'Firearms', ['metal_frag', 125], ['hqm', 4], ['spring', 1]),
  R('nailgun', 1, 10, 'bench2', 'Firearms', ['metal_frag', 150], ['spring', 2], ['gears', 1]),
  R('pistol', 1, 14, 'bench2', 'Firearms', ['metal_frag', 175], ['hqm', 4], ['spring', 2]),
  R('double_barrel', 1, 14, 'bench2', 'Firearms', ['metal_frag', 175], ['hqm', 6], ['wood', 40]),
  R('shotgun_pump', 1, 18, 'bench2', 'Firearms', ['metal_frag', 225], ['hqm', 10], ['spring', 2], ['wood', 50]),
  R('thompson', 1, 20, 'bench2', 'Firearms', ['metal_frag', 250], ['hqm', 12], ['wood', 80], ['spring', 2]),
  R('smg', 1, 22, 'bench2', 'Firearms', ['metal_frag', 250], ['hqm', 15], ['spring', 3], ['gears', 2]),
  R('silenced_pistol', 1, 10, 'bench3', 'Firearms', ['pistol', 1], ['silencer', 1]),
  R('hunting_rifle', 1, 24, 'bench3', 'Firearms', ['metal_frag', 250], ['hqm', 20], ['spring', 2], ['wood', 120]),
  R('ak47', 1, 30, 'bench3', 'Firearms', ['metal_frag', 300], ['hqm', 30], ['spring', 4], ['gears', 2], ['wood', 100]),
  R('carbine', 1, 32, 'bench3', 'Firearms', ['metal_frag', 350], ['hqm', 40], ['spring', 4], ['gears', 3]),
  R('sniper', 1, 40, 'bench3', 'Firearms', ['metal_frag', 400], ['hqm', 60], ['spring', 5], ['gears', 4], ['scope', 1]),
  R('lmg', 1, 50, 'bench3', 'Firearms', ['metal_frag', 600], ['hqm', 100], ['spring', 8], ['gears', 6]),
  R('launcher', 1, 45, 'bench3', 'Firearms', ['metal_frag', 400], ['hqm', 80], ['tech_trash', 6], ['gears', 4]),
  R('flaregun', 1, 8, 'bench1', 'Firearms', ['metal_frag', 90], ['spring', 1]),

  // ---------------------------------------------------------------- ammunition
  R('arrow_wood', 3, 2, 'none', 'Ammunition', ['wood', 10]),
  R('arrow_bone', 3, 3, 'none', 'Ammunition', ['wood', 8], ['bone_frag', 5]),
  R('bolt', 2, 3, 'bench1', 'Ammunition', ['metal_frag', 20], ['wood', 10]),
  R('ammo_pistol', 3, 2, 'bench1', 'Ammunition', ['metal_frag', 10], ['gunpowder', 5]),
  R('ammo_shotgun', 3, 2.5, 'bench1', 'Ammunition', ['metal_frag', 15], ['gunpowder', 8]),
  R('ammo_slug', 2, 3, 'bench3', 'Ammunition', ['metal_frag', 20], ['gunpowder', 10]),
  R('ammo_rifle', 2, 3, 'bench2', 'Ammunition', ['metal_frag', 10], ['gunpowder', 10]),
  R('ammo_heavy', 2, 4, 'bench3', 'Ammunition', ['metal_frag', 15], ['gunpowder', 15], ['hqm', 1]),
  R('nails_ammo', 8, 2, 'bench1', 'Ammunition', ['metal_frag', 15]),
  R('flare', 2, 3, 'bench1', 'Ammunition', ['gunpowder', 10], ['cloth', 4], ['sulfur', 10]),
  R('rocket', 1, 20, 'bench3', 'Ammunition', ['metal_frag', 150], ['gunpowder', 150], ['low_fuel', 30], ['sheet_metal', 2]),

  // ---------------------------------------------------------------- throwables
  R('molotov', 1, 4, 'none', 'Throwables', ['vodka', 1], ['cloth', 2], ['low_fuel', 5]),
  R('throwing_knife', 2, 5, 'bench1', 'Throwables', ['metal_frag', 40]),
  R('beancan', 1, 5, 'bench1', 'Throwables', ['empty_can', 1], ['gunpowder', 30], ['cloth', 5]),
  R('smoke_grenade', 1, 6, 'bench2', 'Throwables', ['metal_frag', 30], ['gunpowder', 20], ['cloth', 10]),
  R('flashbang', 1, 6, 'bench2', 'Throwables', ['metal_frag', 30], ['gunpowder', 25], ['tech_trash', 1]),
  R('grenade', 1, 8, 'bench2', 'Throwables', ['metal_frag', 50], ['gunpowder', 60], ['spring', 1]),
  R('satchel', 1, 12, 'bench3', 'Throwables', ['beancan', 4], ['rope', 2], ['cloth', 10]),

  // ---------------------------------------------------------------- attachments
  R('weapon_light', 1, 6, 'bench2', 'Attachments', ['tech_trash', 1], ['battery', 1], ['metal_frag', 30]),
  R('laser', 1, 8, 'bench2', 'Attachments', ['tech_trash', 2], ['battery', 1], ['metal_frag', 40]),
  R('muzzle_brake', 1, 8, 'bench2', 'Attachments', ['metal_frag', 80], ['hqm', 3]),
  R('silencer', 1, 10, 'bench2', 'Attachments', ['metal_frag', 100], ['hqm', 4], ['cloth', 10]),
  R('scope', 1, 14, 'bench3', 'Attachments', ['hqm', 6], ['tech_trash', 2], ['spring', 1]),

  // ---------------------------------------------------------------- apparel
  R('hide_vest', 1, 6, 'none', 'Apparel', ['leather', 20], ['cloth', 10]),
  R('bandana', 1, 2, 'none', 'Apparel', ['cloth', 5]),
  R('hat_cloth', 1, 3, 'none', 'Apparel', ['cloth', 8]),
  R('pants_cloth', 1, 4, 'none', 'Apparel', ['cloth', 12]),
  R('shirt', 1, 4, 'none', 'Apparel', ['cloth', 10]),
  R('gloves_leather', 1, 4, 'none', 'Apparel', ['leather', 8]),
  R('boots_leather', 1, 5, 'none', 'Apparel', ['leather', 12], ['cloth', 8]),
  R('backpack_small', 1, 7, 'bench1', 'Apparel', ['leather', 15], ['cloth', 20], ['rope', 2]),
  R('balaclava', 1, 4, 'bench1', 'Apparel', ['cloth', 15]),
  R('backpack_large', 1, 12, 'bench2', 'Apparel', ['leather', 30], ['cloth', 40], ['rope', 4], ['sheet_metal', 1]),
  R('helmet_riot', 1, 12, 'bench2', 'Apparel', ['sheet_metal', 3], ['cloth', 20], ['metal_frag', 100]),
  R('kevlar_vest', 1, 16, 'bench2', 'Apparel', ['cloth', 60], ['leather', 30], ['sheet_metal', 2]),
  R('pants_tactical', 1, 12, 'bench2', 'Apparel', ['cloth', 40], ['leather', 15], ['sheet_metal', 1]),
  R('boots_combat', 1, 10, 'bench2', 'Apparel', ['leather', 20], ['cloth', 15], ['metal_frag', 40]),
  R('gloves_tactical', 1, 8, 'bench2', 'Apparel', ['leather', 12], ['cloth', 10]),
  R('gas_mask', 1, 14, 'bench3', 'Apparel', ['cloth', 20], ['tech_trash', 2], ['sheet_metal', 1], ['rope', 1]),
  R('ghillie', 1, 18, 'bench3', 'Apparel', ['cloth', 60], ['plant_fiber', 100], ['rope', 4]),
  R('helmet_military', 1, 18, 'bench3', 'Apparel', ['hqm', 15], ['cloth', 20], ['sheet_metal', 2]),
  R('leg_plates', 1, 16, 'bench3', 'Apparel', ['hqm', 12], ['sheet_metal', 2], ['cloth', 20]),
  R('plate_carrier', 1, 26, 'bench3', 'Apparel', ['hqm', 25], ['sheet_metal', 4], ['cloth', 40], ['leather', 20]),
  R('nvg', 1, 24, 'bench3', 'Apparel', ['tech_trash', 8], ['battery', 2], ['hqm', 10]),
  R('backpack_military', 1, 20, 'bench3', 'Apparel', ['leather', 40], ['cloth', 60], ['rope', 6], ['sheet_metal', 2]),

  // ---------------------------------------------------------------- deployables
  R('campfire', 1, 5, 'none', 'Deployables', ['wood', 100]),
  R('sleeping_bag', 1, 6, 'none', 'Deployables', ['cloth', 30]),
  R('storage_box', 1, 8, 'none', 'Deployables', ['wood', 100]),
  R('workbench_1', 1, 12, 'none', 'Deployables', ['wood', 500], ['metal_frag', 100], ['stone', 100]),
  R('spike_trap', 1, 5, 'none', 'Deployables', ['wood', 60]),
  R('furnace', 1, 10, 'bench1', 'Deployables', ['stone', 200], ['low_fuel', 25], ['wood', 100]),
  R('door_wood', 1, 8, 'bench1', 'Deployables', ['wood', 300]),
  R('water_catcher', 1, 10, 'bench1', 'Deployables', ['metal_frag', 100], ['tarp', 1]),
  R('hunting_trap', 1, 9, 'bench1', 'Deployables', ['metal_frag', 125], ['gears', 1], ['spring', 1]),
  R('saddle', 1, 10, 'bench1', 'Deployables', ['leather', 40], ['rope', 3], ['metal_frag', 60]),
  R('large_box', 1, 12, 'bench2', 'Deployables', ['wood', 250], ['metal_frag', 50]),
  R('tool_cupboard', 1, 14, 'bench2', 'Deployables', ['wood', 1000]),
  R('door_metal', 1, 14, 'bench2', 'Deployables', ['sheet_metal', 5], ['metal_frag', 200]),
  R('workbench_2', 1, 20, 'bench1', 'Deployables', ['wood', 1000], ['metal_frag', 500], ['scrap', 50], ['hqm', 4]),
  R('workbench_3', 1, 35, 'bench2', 'Deployables', ['wood', 2000], ['metal_frag', 1000], ['hqm', 50], ['tech_trash', 10], ['gears', 10]),
];

/** Index for quick lookup by output id. */
export const RECIPE_BY_OUT = new Map<string, Recipe>(RECIPES.map((r) => [r.out, r]));

export const RECIPE_GROUPS: string[] = [...new Set(RECIPES.map((r) => r.group))];

/** Station tiers, so a level 3 bench also satisfies level 1 and 2 recipes. */
const BENCH_RANK: Record<Station, number> = { none: 0, campfire: 0, furnace: 0, bench1: 1, bench2: 2, bench3: 3 };

export function stationSatisfied(required: Station, available: Set<Station>): boolean {
  if (required === 'none') return true;
  if (required === 'campfire' || required === 'furnace') return available.has(required);
  const need = BENCH_RANK[required];
  for (const s of available) {
    if (BENCH_RANK[s] >= need && s !== 'campfire' && s !== 'furnace') return true;
  }
  return false;
}

/** Human-readable cost line, e.g. "120 Wood, 40 Stone". */
export function costText(r: Recipe): string {
  return r.cost.map(([id, n]) => `${n} ${itemDef(id).name}`).join(', ');
}
