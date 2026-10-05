import type { DamageType, DefenseProfile } from '../combat/types';

export interface EnemyMelee {
  damage: number;
  type: DamageType;
  reach: number;
  /** Telegraph duration — the window in which the player can back off or guard. */
  windup: number;
  recovery: number;
  cooldown: number;
  armorPierce: number;
  knockback: number;
}

export interface EnemyRanged {
  damage: number;
  type: DamageType;
  speed: number;
  gravity: number;
  windup: number;
  cooldown: number;
  armorPierce: number;
  spreadDeg: number;
  look: 'arrow' | 'bolt' | 'bullet' | 'magic';
  color: number;
  /** Preferred standoff distance; they retreat if the player closes inside it. */
  standoff: number;
}

export interface EnemyLook {
  body: number;
  head: number;
  accent: number;
  /** Overall size multiplier. */
  scale: number;
  /** Which body to build. Fish are not humanoids with arms and legs. */
  bodyStyle?: 'humanoid' | 'fish';
}

export interface EnemyArchetype {
  id: string;
  name: string;
  minLevel: number;
  /** Relative spawn weight. */
  weight: number;
  baseHp: number;
  hpPerLevel: number;
  speed: number;
  aggroRange: number;
  xp: number;
  look: EnemyLook;
  defense: DefenseProfile;
  /** Flat armour added per 3 levels. */
  armorPerTier: number;
  melee?: EnemyMelee;
  ranged?: EnemyRanged;
  /** Extra loot rolls beyond the level-based armour/weapon tables. */
  extraLoot?: { itemId: string; chance: number; min: number; max: number }[];
  /** Shown once, the first time the player meets this enemy. */
  hint?: string;
  /** Swims: buoyant in water, helpless out of it. */
  aquatic?: boolean;
  /** Never attacks; flees when approached. Prey rather than a threat. */
  passive?: boolean;
}

export const ARCHETYPES: readonly EnemyArchetype[] = [
  {
    id: 'goblin_grunt',
    name: 'Goblin Grunt',
    minLevel: 1,
    weight: 30,
    baseHp: 16,
    hpPerLevel: 4,
    speed: 4.4,
    aggroRange: 11,
    xp: 12,
    look: { body: 0x4a7a3c, head: 0x6e9b52, accent: 0x8a5a2a, scale: 0.85 },
    defense: { armor: 1, resist: { slash: 0, pierce: 0, blunt: 0.05 } },
    armorPerTier: 1,
    melee: { damage: 7, type: 'slash', reach: 2.4, windup: 0.4, recovery: 0.3, cooldown: 0.85, armorPierce: 0.1, knockback: 3 },
    extraLoot: [{ itemId: 'ration', chance: 0.3, min: 1, max: 2 }],
  },
  {
    id: 'goblin_skirmisher',
    name: 'Goblin Skirmisher',
    minLevel: 2,
    weight: 18,
    baseHp: 14,
    hpPerLevel: 3.5,
    speed: 5.0,
    aggroRange: 12,
    xp: 15,
    look: { body: 0x3f6b46, head: 0x6e9b52, accent: 0xa8a090, scale: 0.85 },
    defense: { armor: 1, resist: { slash: 0.05 } },
    armorPerTier: 1,
    // Long reach and a fast poke: punishes standing still.
    melee: { damage: 9, type: 'pierce', reach: 3.6, windup: 0.34, recovery: 0.26, cooldown: 1.0, armorPierce: 0.45, knockback: 4 },
    extraLoot: [{ itemId: 'spear', chance: 0.12, min: 1, max: 1 }],
  },
  {
    id: 'bandit_archer',
    name: 'Bandit Archer',
    minLevel: 2,
    weight: 16,
    baseHp: 18,
    hpPerLevel: 3.5,
    speed: 3.6,
    aggroRange: 19,
    xp: 18,
    look: { body: 0x6a4a32, head: 0xc09a72, accent: 0x8a7a4a, scale: 1.0 },
    defense: { armor: 2, resist: { slash: 0.15 } },
    armorPerTier: 1,
    melee: { damage: 4, type: 'blunt', reach: 2.2, windup: 0.4, recovery: 0.3, cooldown: 1.4, armorPierce: 0, knockback: 2 },
    ranged: {
      damage: 9, type: 'pierce', speed: 42, gravity: 0.9, windup: 0.7, cooldown: 2.0,
      armorPierce: 0.3, spreadDeg: 2.5, look: 'arrow', color: 0xc8b48a, standoff: 12,
    },
    extraLoot: [
      { itemId: 'arrow', chance: 0.85, min: 4, max: 12 },
      { itemId: 'shortbow', chance: 0.14, min: 1, max: 1 },
    ],
  },
  {
    id: 'giant_spider',
    name: 'Giant Spider',
    minLevel: 3,
    weight: 13,
    baseHp: 20,
    hpPerLevel: 4,
    // Fast and low: it closes the distance far quicker than anything else at its
    // level, which is the whole threat. Armour is nil, so it dies to one good hit.
    speed: 5.7,
    aggroRange: 14,
    xp: 22,
    look: { body: 0x4a3a30, head: 0x2e2622, accent: 0xb08a68, scale: 1.0 },
    defense: { armor: 0, resist: { slash: -0.15, pierce: 0.1, blunt: 0 } },
    armorPerTier: 0.5,
    melee: { damage: 10, type: 'pierce', reach: 2.2, windup: 0.26, recovery: 0.22, cooldown: 0.7, armorPierce: 0.5, knockback: 2 },
    extraLoot: [{ itemId: 'healing_draught', chance: 0.12, min: 1, max: 1 }],
    hint: 'Quick, fragile, and it bites through armour. Kill it before it reaches you.',
  },
  {
    id: 'orc_brute',
    name: 'Orc Brute',
    minLevel: 4,
    weight: 14,
    baseHp: 42,
    hpPerLevel: 8,
    speed: 4.0,
    aggroRange: 13,
    xp: 34,
    look: { body: 0x5c6b3a, head: 0x7d8a4e, accent: 0x4a3a28, scale: 1.15 },
    defense: { armor: 3, resist: { slash: 0.2, pierce: 0.1, blunt: 0.1 } },
    armorPerTier: 1.5,
    melee: { damage: 16, type: 'blunt', reach: 2.8, windup: 0.6, recovery: 0.42, cooldown: 1.25, armorPierce: 0.05, knockback: 8 },
    extraLoot: [{ itemId: 'mace', chance: 0.16, min: 1, max: 1 }],
    hint: 'Slow, heavy, and it hits like a falling tree. Watch the windup and step out.',
  },
  {
    id: 'skeleton_knight',
    name: 'Skeleton Knight',
    minLevel: 5,
    weight: 12,
    baseHp: 38,
    hpPerLevel: 6,
    speed: 4.3,
    aggroRange: 14,
    xp: 40,
    look: { body: 0x9aa0a8, head: 0xe0dcd0, accent: 0x6a6f78, scale: 1.05 },
    // Deliberately mirrors iron plate: swords glance off, maces shatter it.
    defense: {
      armor: 6,
      resist: { slash: 0.5, pierce: 0.3, blunt: -0.25, magic: 0.1 },
      armorFactor: { blunt: 0.25 },
    },
    armorPerTier: 2,
    melee: { damage: 14, type: 'slash', reach: 2.7, windup: 0.44, recovery: 0.34, cooldown: 1.0, armorPierce: 0.2, knockback: 5 },
    extraLoot: [
      { itemId: 'longsword', chance: 0.14, min: 1, max: 1 },
      { itemId: 'iron_kite_shield', chance: 0.14, min: 1, max: 1 },
    ],
    hint: 'Armoured like a tank. Blades slide off — use blunt force, or thrust into the gaps.',
  },
  {
    id: 'cultist',
    name: 'Cultist',
    minLevel: 5,
    weight: 11,
    baseHp: 26,
    hpPerLevel: 4.5,
    speed: 3.4,
    aggroRange: 18,
    xp: 38,
    look: { body: 0x4a2a5c, head: 0xd8c8b0, accent: 0x9a5ad0, scale: 1.0 },
    defense: { armor: 1, resist: { magic: 0.4, slash: 0 } },
    armorPerTier: 0.5,
    melee: { damage: 5, type: 'blunt', reach: 2.2, windup: 0.4, recovery: 0.3, cooldown: 1.4, armorPierce: 0, knockback: 2 },
    ranged: {
      damage: 13, type: 'fire', speed: 26, gravity: 0, windup: 0.85, cooldown: 2.4,
      armorPierce: 0.4, spreadDeg: 1.5, look: 'magic', color: 0xb060ff, standoff: 14,
    },
    extraLoot: [
      { itemId: 'mana_tonic', chance: 0.3, min: 1, max: 1 },
      { itemId: 'frost_shard', chance: 0.1, min: 1, max: 1 },
      { itemId: 'chain_lightning', chance: 0.06, min: 1, max: 1 },
    ],
  },
  {
    id: 'ogre',
    name: 'Ogre',
    minLevel: 8,
    weight: 6,
    baseHp: 95,
    hpPerLevel: 14,
    speed: 3.6,
    aggroRange: 15,
    xp: 90,
    look: { body: 0x7a6a4a, head: 0x9a8a62, accent: 0x3a2a1a, scale: 1.6 },
    defense: { armor: 5, resist: { slash: 0.25, pierce: 0.2, blunt: 0.15, magic: -0.1 } },
    armorPerTier: 2,
    melee: { damage: 28, type: 'blunt', reach: 3.4, windup: 0.85, recovery: 0.55, cooldown: 1.7, armorPierce: 0.1, knockback: 14 },
    extraLoot: [
      { itemId: 'warhammer', chance: 0.2, min: 1, max: 1 },
      { itemId: 'healing_draught', chance: 0.5, min: 1, max: 2 },
    ],
    hint: 'It will send you flying. Keep a wall behind you or you will land badly.',
  },
];

export const FISH: EnemyArchetype = {
  id: 'river_fish',
  name: 'River Fish',
  minLevel: 1,
  weight: 0,
  baseHp: 6,
  hpPerLevel: 1,
  speed: 4.2,
  aggroRange: 9,
  xp: 4,
  look: { body: 0x5a8ab0, head: 0x8ab8d8, accent: 0xd8d0a8, scale: 0.45, bodyStyle: 'fish' },
  defense: { armor: 0, resist: {} },
  armorPerTier: 0,
  aquatic: true,
  passive: true,
  extraLoot: [{ itemId: 'raw_fish', chance: 1, min: 1, max: 2 }],
  hint: 'Fish. Spear one and cook it over a torch for a proper meal.',
};

export function archetypeById(id: string): EnemyArchetype | undefined {
  if (id === FISH.id) return FISH;
  return ARCHETYPES.find((a) => a.id === id);
}

/** Weighted pick among archetypes legal for a given spawn level. */
export function pickArchetype(level: number, rng: () => number): EnemyArchetype {
  // weight 0 entries (like fish) are spawned explicitly, not by the roll.
  const eligible = ARCHETYPES.filter((a) => a.minLevel <= level && a.weight > 0);
  const pool = eligible.length > 0 ? eligible : [ARCHETYPES[0]];
  const total = pool.reduce((sum, a) => sum + a.weight, 0);
  let roll = rng() * total;
  for (const a of pool) {
    roll -= a.weight;
    if (roll <= 0) return a;
  }
  return pool[pool.length - 1];
}
