import { ITEMS, type ItemDef } from '../combat/items';
import type { Stack } from '../player/Inventory';
import type { EnemyArchetype } from './archetypes';

/**
 * Loot is gated by the victim's level, which is the whole progression loop:
 * to get better armour you have to go find something stronger and kill it.
 */

interface ArmorTier {
  itemId: string;
  minLevel: number;
  chance: number;
}

// Ordered best-first so the strongest eligible tier is tried first.
const ARMOR_TABLE: readonly ArmorTier[] = [
  { itemId: 'iron_plate', minLevel: 7, chance: 0.14 },
  { itemId: 'leather_armor', minLevel: 4, chance: 0.2 },
  { itemId: 'quilted_armor', minLevel: 1, chance: 0.22 },
];

const SHIELD_TABLE: readonly ArmorTier[] = [
  { itemId: 'tower_shield', minLevel: 9, chance: 0.09 },
  { itemId: 'iron_kite_shield', minLevel: 5, chance: 0.13 },
  { itemId: 'wooden_buckler', minLevel: 1, chance: 0.14 },
];

/** Weapons an enemy of this level is plausibly carrying. */
function weaponPool(level: number): ItemDef[] {
  const maxTier = Math.max(1, Math.ceil(level / 1.6));
  const out: ItemDef[] = [];
  for (const def of ITEMS.values()) {
    if (def.kind !== 'weapon') continue;
    if (def.id === 'fists' || def.id === 'grenade') continue;
    if (def.tier > maxTier || def.tier === 0) continue;
    out.push(def);
  }
  return out;
}

/** Spells scale with level too, so casters stay relevant without a class. */
function spellPool(level: number): ItemDef[] {
  const maxTier = level >= 9 ? 3 : level >= 5 ? 2 : 1;
  return [...ITEMS.values()].filter((d) => d.kind === 'spell' && (d.spell?.tier ?? 9) <= maxTier);
}

function rollTable(table: readonly ArmorTier[], level: number, rng: () => number): string | null {
  for (const entry of table) {
    if (level < entry.minLevel) continue;
    if (rng() < entry.chance) return entry.itemId;
    // Only the best eligible tier gets a roll; otherwise low tiers flood the bag.
    break;
  }
  return null;
}

export function rollLoot(archetype: EnemyArchetype, level: number, rng: () => number): Stack[] {
  const out: Stack[] = [];
  const push = (itemId: string, qty = 1) => {
    const existing = out.find((s) => s.itemId === itemId);
    if (existing) existing.qty += qty;
    else out.push({ itemId, qty });
  };

  const armor = rollTable(ARMOR_TABLE, level, rng);
  if (armor) push(armor);

  const shield = rollTable(SHIELD_TABLE, level, rng);
  if (shield) push(shield);

  if (rng() < 0.2) {
    const pool = weaponPool(level);
    if (pool.length > 0) push(pool[Math.floor(rng() * pool.length)].id);
  }

  // Casters are the reliable source of new spells.
  const spellChance = archetype.ranged?.look === 'magic' ? 0.22 : 0.05;
  if (rng() < spellChance) {
    const pool = spellPool(level);
    if (pool.length > 0) push(pool[Math.floor(rng() * pool.length)].id);
  }

  if (rng() < 0.28) push('healing_draught', 1);
  if (rng() < 0.16) push('grenade', 1 + Math.floor(rng() * 2));
  if (level >= 3 && rng() < 0.2) push('shot', 2 + Math.floor(rng() * 4));
  if (rng() < 0.24) push('arrow', 3 + Math.floor(rng() * 6));

  for (const entry of archetype.extraLoot ?? []) {
    if (rng() < entry.chance) {
      push(entry.itemId, entry.min + Math.floor(rng() * (entry.max - entry.min + 1)));
    }
  }

  return out;
}

/** XP awarded for a kill, scaled so higher-level foes are worth the risk. */
export function xpForKill(archetype: EnemyArchetype, level: number): number {
  return Math.round(archetype.xp * (1 + (level - 1) * 0.35));
}
