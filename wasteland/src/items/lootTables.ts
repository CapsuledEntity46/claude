/**
 * Loot tables.
 *
 * Entries are `[itemId, weight, min, max]`. Weight is relative within the table.
 * Tables also declare how many rolls a container gets and the chance each roll
 * produces anything at all, so empty cupboards stay a real (and tense) outcome.
 */

import type { RNG } from '../core/rng';
import { makeStack, type ItemStack } from './item';
import { itemDef } from './itemdefs';

export type LootEntry = readonly [string, number, number, number];

export interface LootTable {
  rolls: [number, number];
  /** Probability any single roll yields loot. */
  fill: number;
  entries: readonly LootEntry[];
}

export type LootTableName =
  | 'kitchen' | 'bedroom' | 'bathroom' | 'livingroom' | 'wardrobe' | 'fridge'
  | 'shop' | 'pharmacy' | 'hardware' | 'gas_station' | 'warehouse' | 'barn'
  | 'military' | 'military_crate' | 'hospital' | 'police' | 'toolbox' | 'locker'
  | 'safe' | 'car' | 'barrel' | 'crate_wood' | 'trash'
  | 'zombie' | 'zombie_brute' | 'bandit' | 'bandit_heavy'
  | 'deer' | 'wolf' | 'boar' | 'chicken' | 'bush' | 'starter';

const T = (rolls: [number, number], fill: number, entries: readonly LootEntry[]): LootTable => ({ rolls, fill, entries });

export const LOOT: Record<LootTableName, LootTable> = {
  // ---------------- residential ----------------
  kitchen: T([2, 4], 0.7, [
    ['canned_beans', 20, 1, 2], ['canned_tuna', 16, 1, 2], ['canned_peaches', 12, 1, 1],
    ['cereal', 10, 1, 1], ['bread', 9, 1, 1], ['granola', 12, 1, 3],
    ['water_bottle', 18, 1, 2], ['soda', 12, 1, 2], ['coffee', 7, 1, 1],
    ['empty_can', 14, 1, 4], ['matches', 8, 1, 3], ['rag', 10, 1, 3],
    ['combat_knife', 3, 1, 1], ['cloth', 10, 2, 6], ['apple', 8, 1, 2],
    ['honey', 2, 1, 1], ['vodka', 3, 1, 1],
  ]),
  bedroom: T([2, 3], 0.62, [
    ['cloth', 22, 2, 8], ['shirt', 10, 1, 1], ['jeans', 9, 1, 1], ['hoodie', 7, 1, 1],
    ['shoes', 8, 1, 1], ['beanie', 6, 1, 1], ['backpack_small', 5, 1, 1],
    ['sleeping_bag', 3, 1, 1], ['flashlight', 5, 1, 1], ['battery', 5, 1, 2],
    ['radio', 3, 1, 1], ['lockpick', 3, 1, 2], ['pants_cloth', 8, 1, 1],
    ['baseball_bat', 4, 1, 1], ['ammo_pistol', 4, 4, 10], ['scrap', 8, 2, 6],
  ]),
  bathroom: T([1, 3], 0.6, [
    ['bandage', 20, 1, 3], ['rag', 22, 1, 4], ['painkillers', 12, 1, 2],
    ['antibiotics', 6, 1, 1], ['cloth', 16, 1, 5], ['water_bottle', 10, 1, 1],
    ['medkit', 3, 1, 1], ['tape', 6, 1, 2],
  ]),
  livingroom: T([2, 3], 0.6, [
    ['cloth', 18, 2, 6], ['tech_trash', 8, 1, 2], ['battery', 8, 1, 2],
    ['radio', 5, 1, 1], ['scrap', 14, 2, 8], ['wire', 8, 2, 6],
    ['chocolate', 8, 1, 2], ['soda', 8, 1, 2], ['map_item', 4, 1, 1],
    ['binoculars', 3, 1, 1], ['revolver', 2, 1, 1], ['ammo_pistol', 5, 3, 8],
    ['empty_can', 10, 1, 3],
  ]),
  wardrobe: T([2, 4], 0.72, [
    ['shirt', 16, 1, 1], ['jeans', 14, 1, 1], ['hoodie', 12, 1, 1],
    ['jacket_leather', 6, 1, 1], ['boots_leather', 8, 1, 1], ['shoes', 10, 1, 1],
    ['hat_cloth', 8, 1, 1], ['beanie', 8, 1, 1], ['gloves_leather', 7, 1, 1],
    ['bandana', 8, 1, 1], ['pants_cloth', 12, 1, 1], ['cloth', 18, 2, 6],
    ['backpack_small', 5, 1, 1], ['backpack_large', 2, 1, 1],
  ]),
  fridge: T([1, 3], 0.65, [
    ['canned_beans', 14, 1, 2], ['raw_meat', 16, 1, 3], ['water_bottle', 18, 1, 2],
    ['soda', 14, 1, 3], ['apple', 12, 1, 3], ['corn', 8, 1, 3],
    ['energy_drink', 6, 1, 2], ['raw_fish', 6, 1, 2], ['honey', 3, 1, 1],
  ]),
  trash: T([1, 2], 0.45, [
    ['empty_can', 26, 1, 4], ['cloth', 20, 1, 4], ['scrap', 16, 1, 5],
    ['rag', 14, 1, 3], ['wire', 8, 1, 3], ['tech_trash', 4, 1, 1],
    ['low_fuel', 5, 1, 3], ['nails_res', 8, 3, 10],
  ]),

  // ---------------- commercial ----------------
  shop: T([3, 5], 0.72, [
    ['canned_beans', 16, 1, 3], ['canned_tuna', 14, 1, 3], ['cereal', 10, 1, 2],
    ['water_bottle', 18, 1, 3], ['soda', 14, 1, 4], ['energy_drink', 8, 1, 2],
    ['chocolate', 12, 1, 3], ['granola', 12, 1, 4], ['bread', 8, 1, 2],
    ['bandage', 8, 1, 2], ['lighter', 8, 1, 1], ['matches', 8, 1, 4],
    ['backpack_small', 4, 1, 1], ['scrap', 10, 2, 8], ['pumpkin', 3, 1, 1],
  ]),
  pharmacy: T([2, 4], 0.75, [
    ['bandage', 22, 1, 4], ['painkillers', 16, 1, 3], ['antibiotics', 12, 1, 2],
    ['medkit', 8, 1, 1], ['syringe', 5, 1, 1], ['blood_bag', 5, 1, 1],
    ['rag', 14, 2, 5], ['splint', 8, 1, 2], ['vodka', 5, 1, 1],
  ]),
  hardware: T([3, 5], 0.75, [
    ['wood', 18, 40, 140], ['nails_res', 16, 10, 40], ['metal_frag', 14, 20, 90],
    ['hammer', 10, 1, 1], ['hatchet', 8, 1, 1], ['pickaxe', 7, 1, 1],
    ['shovel', 7, 1, 1], ['crowbar', 6, 1, 1], ['tape', 10, 1, 3],
    ['rope', 9, 1, 3], ['tarp', 6, 1, 2], ['sheet_metal', 6, 1, 3],
    ['spring', 5, 1, 2], ['gears', 5, 1, 2], ['nailgun', 3, 1, 1],
    ['nails_ammo', 5, 10, 30], ['building_plan', 6, 1, 1], ['low_fuel', 7, 2, 8],
  ]),
  gas_station: T([2, 4], 0.7, [
    ['low_fuel', 22, 4, 16], ['soda', 14, 1, 3], ['granola', 12, 1, 3],
    ['canned_beans', 10, 1, 2], ['water_bottle', 12, 1, 2], ['tape', 8, 1, 2],
    ['lighter', 8, 1, 1], ['molotov', 4, 1, 2], ['scrap', 12, 2, 10],
    ['tech_trash', 5, 1, 2], ['crowbar', 4, 1, 1], ['shotgun_pump', 2, 1, 1],
    ['ammo_shotgun', 5, 3, 9],
  ]),
  warehouse: T([3, 6], 0.7, [
    ['wood', 16, 60, 200], ['metal_frag', 16, 30, 140], ['stone', 10, 40, 150],
    ['sheet_metal', 10, 1, 4], ['gears', 9, 1, 3], ['spring', 8, 1, 3],
    ['tech_trash', 7, 1, 3], ['rope', 8, 1, 4], ['tarp', 7, 1, 3],
    ['scrap', 14, 5, 25], ['large_box', 3, 1, 1], ['hqm', 3, 2, 8],
    ['sledgehammer', 3, 1, 1], ['fire_axe', 3, 1, 1],
  ]),
  barn: T([2, 4], 0.68, [
    ['wood', 18, 40, 160], ['cloth', 14, 4, 14], ['seeds', 14, 4, 16],
    ['corn', 12, 2, 6], ['pumpkin', 8, 1, 2], ['hatchet', 8, 1, 1],
    ['shovel', 8, 1, 1], ['rope', 10, 1, 4], ['saddle', 6, 1, 1],
    ['double_barrel', 5, 1, 1], ['ammo_shotgun', 8, 3, 10],
    ['hunting_trap', 5, 1, 2], ['leather', 8, 2, 8], ['fishing_rod', 5, 1, 1],
  ]),

  // ---------------- high tier ----------------
  military: T([3, 5], 0.8, [
    ['ammo_rifle', 18, 15, 45], ['ammo_heavy', 10, 8, 24], ['ammo_pistol', 14, 15, 40],
    ['carbine', 6, 1, 1], ['ak47', 5, 1, 1], ['pistol', 9, 1, 1],
    ['smg', 6, 1, 1], ['helmet_military', 8, 1, 1], ['kevlar_vest', 7, 1, 1],
    ['pants_tactical', 8, 1, 1], ['boots_combat', 9, 1, 1], ['gloves_tactical', 8, 1, 1],
    ['backpack_military', 5, 1, 1], ['medkit', 9, 1, 2], ['grenade', 6, 1, 2],
    ['flashbang', 6, 1, 2], ['smoke_grenade', 7, 1, 2], ['scope', 4, 1, 1],
    ['silencer', 4, 1, 1], ['muzzle_brake', 5, 1, 1], ['gas_mask', 4, 1, 1],
    ['nvg', 1, 1, 1], ['hqm', 6, 4, 14], ['tech_trash', 7, 1, 3],
  ]),
  military_crate: T([4, 6], 0.92, [
    ['ammo_rifle', 18, 30, 60], ['ammo_heavy', 12, 12, 30], ['ak47', 7, 1, 1],
    ['carbine', 7, 1, 1], ['sniper', 2, 1, 1], ['lmg', 1, 1, 1],
    ['hunting_rifle', 6, 1, 1], ['plate_carrier', 4, 1, 1], ['kevlar_vest', 8, 1, 1],
    ['helmet_military', 9, 1, 1], ['leg_plates', 6, 1, 1], ['grenade', 8, 2, 4],
    ['satchel', 3, 1, 2], ['rocket', 2, 1, 2], ['launcher', 1, 1, 1],
    ['medkit', 10, 1, 3], ['syringe', 7, 1, 2], ['scope', 6, 1, 1],
    ['silencer', 6, 1, 1], ['nvg', 2, 1, 1], ['hqm', 8, 8, 20],
  ]),
  hospital: T([3, 5], 0.82, [
    ['bandage', 20, 2, 6], ['medkit', 14, 1, 3], ['blood_bag', 12, 1, 3],
    ['syringe', 10, 1, 2], ['antibiotics', 14, 1, 3], ['painkillers', 14, 1, 4],
    ['splint', 10, 1, 2], ['rag', 14, 2, 6], ['gas_mask', 4, 1, 1],
    ['tech_trash', 6, 1, 2], ['scrap', 8, 4, 14],
  ]),
  police: T([2, 4], 0.78, [
    ['pistol', 12, 1, 1], ['revolver', 10, 1, 1], ['shotgun_pump', 8, 1, 1],
    ['ammo_pistol', 18, 12, 36], ['ammo_shotgun', 12, 6, 18], ['helmet_riot', 10, 1, 1],
    ['kevlar_vest', 8, 1, 1], ['boots_combat', 8, 1, 1], ['flashbang', 7, 1, 2],
    ['medkit', 7, 1, 1], ['lockpick', 8, 1, 3], ['flaregun', 5, 1, 1],
    ['flare', 6, 2, 5], ['laser', 5, 1, 1],
  ]),
  toolbox: T([2, 3], 0.8, [
    ['nails_res', 20, 10, 40], ['metal_frag', 16, 20, 80], ['tape', 12, 1, 3],
    ['wire', 12, 2, 8], ['gears', 10, 1, 3], ['spring', 10, 1, 3],
    ['hammer', 8, 1, 1], ['hatchet', 6, 1, 1], ['pickaxe', 6, 1, 1],
    ['sheet_metal', 7, 1, 2], ['tech_trash', 5, 1, 2], ['crowbar', 5, 1, 1],
  ]),
  locker: T([2, 4], 0.72, [
    ['pants_tactical', 12, 1, 1], ['boots_combat', 12, 1, 1], ['kevlar_vest', 8, 1, 1],
    ['helmet_riot', 8, 1, 1], ['balaclava', 10, 1, 1], ['gloves_tactical', 10, 1, 1],
    ['backpack_large', 8, 1, 1], ['ammo_rifle', 10, 10, 30], ['ammo_pistol', 12, 10, 30],
    ['medkit', 7, 1, 1], ['ghillie', 2, 1, 1],
  ]),
  safe: T([2, 3], 0.95, [
    ['hqm', 16, 6, 18], ['ammo_heavy', 12, 10, 24], ['pistol', 10, 1, 1],
    ['silenced_pistol', 6, 1, 1], ['scope', 8, 1, 1], ['silencer', 8, 1, 1],
    ['grenade', 8, 1, 3], ['satchel', 4, 1, 1], ['medkit', 10, 1, 2],
    ['tech_trash', 10, 2, 5], ['nvg', 3, 1, 1], ['katana', 4, 1, 1],
  ]),
  car: T([2, 3], 0.6, [
    ['low_fuel', 20, 3, 12], ['scrap', 18, 3, 12], ['metal_frag', 14, 20, 70],
    ['tech_trash', 8, 1, 2], ['battery', 10, 1, 2], ['tape', 10, 1, 2],
    ['wire', 10, 2, 6], ['gears', 8, 1, 2], ['spring', 8, 1, 2],
    ['sheet_metal', 8, 1, 3], ['crowbar', 5, 1, 1], ['medkit', 4, 1, 1],
    ['map_item', 4, 1, 1],
  ]),
  barrel: T([1, 3], 0.85, [
    ['scrap', 20, 2, 10], ['metal_frag', 18, 15, 60], ['low_fuel', 12, 2, 8],
    ['cloth', 14, 2, 8], ['tech_trash', 8, 1, 2], ['gunpowder', 6, 5, 20],
    ['sulfur', 8, 10, 40], ['charcoal', 10, 10, 40], ['wire', 8, 1, 5],
    ['empty_can', 10, 1, 4],
  ]),
  crate_wood: T([2, 4], 0.85, [
    ['wood', 18, 50, 180], ['stone', 14, 40, 140], ['metal_frag', 14, 20, 80],
    ['cloth', 12, 4, 16], ['leather', 8, 2, 8], ['arrow_wood', 10, 4, 12],
    ['bow', 5, 1, 1], ['stone_hatchet', 7, 1, 1], ['stone_pickaxe', 7, 1, 1],
    ['bandage', 8, 1, 3], ['canned_beans', 8, 1, 2], ['scrap', 10, 3, 12],
    ['campfire', 5, 1, 1], ['storage_box', 3, 1, 1],
  ]),

  // ---------------- corpses ----------------
  zombie: T([1, 2], 0.42, [
    ['cloth', 24, 1, 4], ['rag', 16, 1, 2], ['bone_frag', 20, 1, 4],
    ['animal_fat', 10, 1, 2], ['scrap', 10, 1, 4], ['empty_can', 8, 1, 2],
    ['ammo_pistol', 6, 2, 6], ['bandage', 6, 1, 1], ['canned_beans', 5, 1, 1],
    ['lighter', 3, 1, 1], ['battery', 3, 1, 1],
  ]),
  zombie_brute: T([2, 4], 0.8, [
    ['bone_frag', 22, 4, 12], ['cloth', 18, 3, 8], ['animal_fat', 14, 2, 6],
    ['leather', 10, 1, 4], ['scrap', 12, 4, 14], ['metal_frag', 10, 20, 60],
    ['medkit', 5, 1, 1], ['ammo_rifle', 6, 5, 15], ['hqm', 3, 1, 4],
  ]),
  bandit: T([2, 4], 0.85, [
    ['ammo_pistol', 16, 6, 20], ['ammo_shotgun', 8, 3, 8], ['ammo_rifle', 8, 6, 18],
    ['bandage', 14, 1, 3], ['canned_beans', 10, 1, 2], ['water_bottle', 10, 1, 2],
    ['scrap', 14, 3, 14], ['cloth', 12, 2, 8], ['painkillers', 8, 1, 2],
    ['pistol', 6, 1, 1], ['revolver', 6, 1, 1], ['machete', 5, 1, 1],
    ['hide_vest', 6, 1, 1], ['jacket_leather', 5, 1, 1], ['lockpick', 6, 1, 2],
  ]),
  bandit_heavy: T([3, 5], 0.92, [
    ['ammo_rifle', 18, 15, 40], ['ammo_heavy', 10, 8, 20], ['ak47', 6, 1, 1],
    ['carbine', 5, 1, 1], ['smg', 7, 1, 1], ['shotgun_pump', 7, 1, 1],
    ['kevlar_vest', 8, 1, 1], ['helmet_military', 7, 1, 1], ['medkit', 12, 1, 2],
    ['grenade', 6, 1, 2], ['scope', 4, 1, 1], ['silencer', 4, 1, 1],
    ['backpack_large', 6, 1, 1], ['hqm', 6, 2, 8], ['scrap', 12, 6, 20],
  ]),

  // ---------------- animals & foraging ----------------
  deer: T([3, 4], 1, [
    ['raw_meat', 40, 2, 4], ['leather', 30, 2, 5], ['bone_frag', 24, 2, 6],
    ['animal_fat', 20, 1, 3],
  ]),
  wolf: T([3, 4], 1, [
    ['raw_meat', 34, 1, 3], ['leather', 30, 2, 4], ['bone_frag', 28, 3, 7],
    ['animal_fat', 16, 1, 2],
  ]),
  boar: T([3, 5], 1, [
    ['raw_meat', 40, 3, 6], ['leather', 26, 2, 5], ['bone_frag', 22, 2, 6],
    ['animal_fat', 26, 2, 5],
  ]),
  chicken: T([2, 3], 1, [
    ['raw_meat', 40, 1, 2], ['bone_frag', 24, 1, 3], ['cloth', 18, 1, 2],
  ]),
  bush: T([1, 2], 0.8, [
    ['berries', 34, 1, 4], ['plant_fiber', 30, 2, 6], ['cloth', 16, 1, 3],
    ['mushroom', 12, 1, 2], ['seeds', 12, 1, 3],
  ]),

  /** What you wash up on the shore with. */
  starter: T([3, 3], 1, [
    ['rock', 1, 1, 1], ['torch', 1, 1, 1], ['bandage', 1, 2, 2],
  ]),
};

/** Some items should stay rare until the player has survived a while. */
const DAY_GATE: Record<string, number> = {
  ak47: 4, carbine: 4, sniper: 7, lmg: 9, launcher: 10, rocket: 10,
  satchel: 6, nvg: 6, plate_carrier: 6, ghillie: 5, katana: 4, hqm: 3,
};

/**
 * Roll a loot table into concrete stacks.
 * `day` gates the strongest items, `luck` biases roll counts upward.
 */
export function rollLoot(name: LootTableName, rng: RNG, day = 1, luck = 0): ItemStack[] {
  const table = LOOT[name];
  const out: ItemStack[] = [];
  const rolls = rng.int(table.rolls[0], table.rolls[1]) + (luck > 0 && rng.bool(luck) ? 1 : 0);

  const pool = table.entries.filter((e) => (DAY_GATE[e[0]] ?? 0) <= day);
  if (pool.length === 0) return out;

  for (let i = 0; i < rolls; i++) {
    if (!rng.bool(table.fill)) continue;
    const entry = rng.weighted(pool, (e) => e[1]);
    const count = rng.int(entry[2], entry[3]);
    if (count <= 0) continue;
    const max = itemDef(entry[0]).stack;
    let remaining = count;
    while (remaining > 0) {
      const chunk = Math.min(remaining, max);
      out.push(makeStack(entry[0], chunk));
      remaining -= chunk;
    }
  }
  return out;
}
