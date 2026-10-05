import { Block, PLACEABLE, blockDef, type ToolClass } from '../world/blocks';
import { meleeModes } from './types';
import type {
  AmmoType,
  ArmorDef,
  AttackMode,
  ConsumableDef,
  DamageType,
  MeleeAttack,
  RangedProfile,
  ShieldDef,
  SpellDef,
  WeaponDef,
} from './types';

export type ItemKind = 'weapon' | 'armor' | 'shield' | 'spell' | 'block' | 'consumable' | 'ammo' | 'torch' | 'tool';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  glyph: string;
  /** Rough power level, used to gate loot behind enemy level. */
  tier: number;
  stackable: boolean;
  maxStack: number;
  /** One-line flavour + mechanical hint shown in the sheet. */
  blurb: string;
  weapon?: WeaponDef;
  armor?: ArmorDef;
  shield?: ShieldDef;
  spell?: SpellDef;
  consumable?: ConsumableDef;
  ammo?: AmmoType;
  block?: Block;
  torch?: TorchDef;
  tool?: ToolDef;
}

export interface ToolDef {
  /** Which family of blocks this is the right instrument for. */
  kind: ToolClass;
  /**
   * Tier, against a block's `requiresTier`.
   *
   * 1 wood, 2 stone, 3 iron. A block requiring a higher tier than the tool in
   * hand still breaks; it just yields nothing, which is the whole reason to go
   * and make a better one.
   */
  tier: number;
  /** Mining speed multiplier when used on the blocks it suits. */
  speed: number;
}

export interface TorchDef {
  /** Light radius in blocks. */
  radius: number;
  intensity: number;
}

// ------------------------------------------------------------------ melee builders

interface MeleeOpts {
  type?: DamageType;
  arcDeg?: number;
  windup?: number;
  recovery?: number;
  stamina?: number;
  armorPierce?: number;
  maxTargets?: number;
  knockback?: number;
}

/**
 * A swing sweeps a wide arc and lands slashing or bludgeoning force. It barely
 * bypasses armour, so it is at its best against soft targets — or against plate,
 * if the weapon is blunt.
 */
function swing(damage: number, reach: number, o: MeleeOpts = {}): MeleeAttack {
  return {
    mode: 'swing',
    damage,
    type: o.type ?? 'slash',
    reach,
    arcDeg: o.arcDeg ?? 55,
    windup: o.windup ?? 0.22,
    recovery: o.recovery ?? 0.3,
    stamina: o.stamina ?? 11,
    armorPierce: o.armorPierce ?? 0.1,
    maxTargets: o.maxTargets ?? 3,
    knockback: o.knockback ?? 4.5,
  };
}

/**
 * A thrust commits along a narrow line: less damage spread, more reach, and it
 * bypasses roughly half the target's flat armour. The answer to iron plate when
 * you have no blunt weapon in the bag.
 *
 * **Costlier than a swing, not cheaper.** A thrust reaches further, lands faster,
 * bypasses five times as much armour, crits twice as often and crits harder; it
 * used to pay for all of that with *less* stamina than a swing, which left no
 * reason to ever swing at anything. The price is the only axis left to balance it
 * on, since every other one is already in the thrust's favour.
 */
function thrust(damage: number, reach: number, o: MeleeOpts = {}): MeleeAttack {
  return {
    mode: 'thrust',
    damage,
    type: o.type ?? 'pierce',
    reach,
    arcDeg: o.arcDeg ?? 19,
    windup: o.windup ?? 0.16,
    recovery: o.recovery ?? 0.24,
    stamina: o.stamina ?? 15,
    armorPierce: o.armorPierce ?? 0.5,
    maxTargets: o.maxTargets ?? 1,
    knockback: o.knockback ?? 2.5,
  };
}

function melee(name: string, glyph: string, tier: number, attacks: MeleeAttack[], blurb: string, twoHanded = false): ItemDef {
  return {
    id: name.toLowerCase().replace(/[^a-z]+/g, '_'),
    name,
    kind: 'weapon',
    glyph,
    tier,
    stackable: false,
    maxStack: 1,
    blurb,
    weapon: { class: 'melee', melee: meleeModes(attacks), twoHanded },
  };
}

// ------------------------------------------------------------------ ranged builders

function ranged(p: Partial<RangedProfile> & { damage: number; ammo: AmmoType }): RangedProfile {
  return {
    damage: p.damage,
    type: p.type ?? 'pierce',
    ammo: p.ammo,
    speed: p.speed ?? 48,
    gravity: p.gravity ?? 1,
    spreadDeg: p.spreadDeg ?? 0.6,
    drawTime: p.drawTime ?? 0,
    reloadTime: p.reloadTime ?? 0,
    magazine: p.magazine ?? 1,
    pellets: p.pellets ?? 1,
    armorPierce: p.armorPierce ?? 0.25,
    knockback: p.knockback ?? 3,
    muzzleFlash: p.muzzleFlash ?? false,
    aoeRadius: p.aoeRadius ?? 0,
    blockDamage: p.blockDamage ?? 0,
    fuse: p.fuse ?? 0,
    cooldown: p.cooldown ?? 0.35,
  };
}

function rangedItem(
  name: string,
  glyph: string,
  tier: number,
  cls: 'bow' | 'crossbow' | 'firearm' | 'thrown',
  profile: RangedProfile,
  blurb: string,
  twoHanded = true,
  meleeFallback: MeleeAttack[] = [swing(2, 2.2, { type: 'blunt', stamina: 6, maxTargets: 1 })],
): ItemDef {
  return {
    id: name.toLowerCase().replace(/[^a-z]+/g, '_'),
    name,
    kind: 'weapon',
    glyph,
    tier,
    stackable: false,
    maxStack: 1,
    blurb,
    weapon: { class: cls, melee: meleeModes(meleeFallback), ranged: profile, twoHanded },
  };
}

// ------------------------------------------------------------------ registry

const defs: ItemDef[] = [];

// --- Melee: attack modes follow the weapon's shape -------------------------

defs.push(
  melee('Fists', '👊', 0, [swing(2, 2.0, { type: 'blunt', stamina: 5, maxTargets: 1, windup: 0.12, recovery: 0.18, knockback: 2 })],
    'No edge, no point. Only knuckles.'),

  melee('Dagger', '🗡️', 1, [
    thrust(5, 2.4, { windup: 0.1, recovery: 0.16, stamina: 8, armorPierce: 0.6 }),
    swing(4, 2.2, { windup: 0.12, recovery: 0.18, stamina: 6, maxTargets: 1 }),
  ], 'Point and edge both, but neither has any mass behind it.'),

  melee('Shortsword', '⚔️', 2, [
    swing(8, 2.9, { }),
    thrust(7, 3.6, { }),
  ], 'A blade is sharp along the sides and pointed at the tip, so it can do both.'),

  melee('Longsword', '⚔️', 4, [
    swing(13, 3.3, { windup: 0.28, recovery: 0.34, stamina: 15 }),
    thrust(11, 4.1, { windup: 0.2, recovery: 0.3, stamina: 19, armorPierce: 0.55 }),
  ], 'Heavy enough to cleave, long enough to reach. The generalist.', true),

  melee('Rapier', '🤺', 3, [
    thrust(11, 4.3, { windup: 0.14, recovery: 0.2, stamina: 16, armorPierce: 0.68 }),
  ], 'All point, no cutting edge worth the name. Thrust only — but it finds gaps in plate.'),

  melee('Spear', '🔻', 3, [
    thrust(12, 5.0, { windup: 0.2, recovery: 0.3, stamina: 18, armorPierce: 0.55, knockback: 5 }),
  ], 'A point on a pole. Nothing to swing with, but nothing else reaches this far.', true),

  melee('Mace', '🔨', 3, [
    swing(12, 2.8, { type: 'blunt', windup: 0.26, recovery: 0.34, stamina: 14, armorPierce: 0.05, knockback: 6 }),
  ], 'Blunt all over, so it can only swing — and plate armour does nothing against it.'),

  melee('Warhammer', '⚒️', 5, [
    swing(19, 3.0, { type: 'blunt', windup: 0.4, recovery: 0.46, stamina: 21, armorPierce: 0.05, knockback: 9, maxTargets: 2 }),
  ], 'Slow, exhausting, and it turns an armoured knight into a sack of broken parts.', true),

  melee('Battleaxe', '🪓', 4, [
    swing(16, 3.1, { windup: 0.34, recovery: 0.4, stamina: 18, maxTargets: 4, knockback: 6 }),
  ], 'A wedge on a handle. No tip to thrust with, but it sweeps through a crowd.', true),

  melee('Halberd', '🔱', 5, [
    swing(15, 3.6, { windup: 0.36, recovery: 0.42, stamina: 18, maxTargets: 3, knockback: 6 }),
    thrust(14, 5.2, { windup: 0.24, recovery: 0.32, stamina: 22, armorPierce: 0.6, knockback: 5 }),
  ], 'An axe head and a spike on the same shaft, so it genuinely does both jobs.', true),
);

// --- Ranged -----------------------------------------------------------------

defs.push(
  rangedItem('Shortbow', '🏹', 1, 'bow',
    ranged({ damage: 8, ammo: 'arrow', speed: 44, drawTime: 0.55, spreadDeg: 1.4, armorPierce: 0.3, cooldown: 0.15 }),
    'Draw to charge. Loose early and the arrow barely bites.'),

  rangedItem('Longbow', '🏹', 4, 'bow',
    ranged({ damage: 15, ammo: 'arrow', speed: 62, drawTime: 0.95, spreadDeg: 0.8, armorPierce: 0.38, knockback: 4, cooldown: 0.2 }),
    'A full draw takes a second and rewards you for it.'),

  rangedItem('Crossbow', '🎯', 3, 'crossbow',
    ranged({ damage: 20, ammo: 'bolt', speed: 78, gravity: 0.55, reloadTime: 1.9, spreadDeg: 0.3, armorPierce: 0.62, knockback: 5, cooldown: 0.1 }),
    'Held at full tension, so it fires the instant you pull. Then the long crank back.'),

  rangedItem('Flintlock Pistol', '🔫', 3, 'firearm',
    ranged({ damage: 22, ammo: 'shot', type: 'pierce', speed: 150, gravity: 0.12, reloadTime: 2.1, spreadDeg: 2.2, armorPierce: 0.5, knockback: 6, muzzleFlash: true, cooldown: 0.1 }),
    'One ball, one shot, then twenty seconds of regret. Loud enough to draw a crowd.', false),

  rangedItem('Musket', '🔫', 5, 'firearm',
    ranged({ damage: 38, ammo: 'shot', type: 'pierce', speed: 200, gravity: 0.08, reloadTime: 3.1, spreadDeg: 0.9, armorPierce: 0.66, knockback: 9, muzzleFlash: true, cooldown: 0.1 }),
    'Punches straight through plate. If you miss, you had better have a sword.'),

  rangedItem('Blunderbuss', '💥', 4, 'firearm',
    ranged({ damage: 11, ammo: 'shot', type: 'pierce', speed: 120, gravity: 0.2, reloadTime: 2.8, spreadDeg: 9, pellets: 6, armorPierce: 0.2, knockback: 7, muzzleFlash: true, cooldown: 0.1 }),
    'Six pellets in a cone. Devastating at spitting distance, useless past ten paces.'),

  {
    id: 'grenade',
    name: 'Grenade',
    kind: 'weapon',
    glyph: '💣',
    tier: 3,
    stackable: true,
    maxStack: 12,
    blurb: 'Lit fuse, three seconds, then it rearranges the terrain.',
    weapon: {
      class: 'thrown',
      twoHanded: false,
      melee: {},
      ranged: ranged({
        damage: 34, ammo: 'none', type: 'explosive', speed: 22, gravity: 1.4,
        fuse: 2.6, aoeRadius: 4.5, blockDamage: 2.6, armorPierce: 0.35,
        knockback: 12, spreadDeg: 0, cooldown: 0.7,
      }),
    },
  },
);

// --- Ammo -------------------------------------------------------------------

function ammoItem(id: string, name: string, glyph: string, type: AmmoType, tier: number, blurb: string): ItemDef {
  return { id, name, kind: 'ammo', glyph, tier, stackable: true, maxStack: 99, blurb, ammo: type };
}

defs.push(
  ammoItem('arrow', 'Arrow', '➶', 'arrow', 1, 'Fletched shaft. Works in any bow.'),
  ammoItem('bolt', 'Bolt', '➵', 'bolt', 2, 'Short, heavy, and made to punch holes.'),
  ammoItem('shot', 'Lead Shot', '⚫', 'shot', 3, 'Ball and powder, packaged together.'),
);

// --- Armour: exactly the three tiers, with an honest weakness each ----------

defs.push(
  {
    id: 'quilted_armor',
    name: 'Quilted Armor',
    kind: 'armor',
    glyph: '🧥',
    tier: 1,
    stackable: false,
    maxStack: 1,
    blurb: 'Layered cloth. Softens a club, does nothing against a point.',
    // Padding is soft, so it genuinely absorbs impact — but a spear goes
    // straight through it, and it burns.
    armor: {
      armor: 2,
      resist: { slash: 0.1, pierce: 0, blunt: 0.25, fire: -0.2 },
      weight: 0.5,
    },
  },
  {
    id: 'leather_armor',
    name: 'Leather Armor',
    kind: 'armor',
    glyph: '🥼',
    tier: 3,
    stackable: false,
    maxStack: 1,
    blurb: 'Boiled hide. Turns edges aside and stays light enough to run in.',
    armor: {
      armor: 4,
      resist: { slash: 0.3, pierce: 0.1, blunt: 0.15 },
      armorFactor: { blunt: 0.85 },
      weight: 1.1,
    },
  },
  {
    id: 'iron_plate',
    name: 'Iron Plate',
    kind: 'armor',
    glyph: '🛡️',
    tier: 6,
    stackable: false,
    maxStack: 1,
    blurb: 'Nothing better against blades. But it transmits a hammer blow straight to the wearer.',
    // Deliberately the worst armour in the game against blunt force. The low
    // blunt armorFactor is what does the real work: rigid plate does not absorb
    // impact, so its large flat armour value barely applies to a mace.
    armor: {
      armor: 7,
      resist: { slash: 0.45, pierce: 0.35, blunt: -0.25, magic: 0.05 },
      armorFactor: { blunt: 0.25 },
      weight: 3.2,
    },
  },
);

// --- Shields ----------------------------------------------------------------

defs.push(
  {
    id: 'wooden_buckler',
    name: 'Wooden Buckler',
    kind: 'shield',
    glyph: '🛡',
    tier: 1,
    stackable: false,
    maxStack: 1,
    blurb: 'Small and quick. Narrow cover, cheap to hold up.',
    shield: { absorb: 0.5, coneDeg: 60, guard: 30, guardPerHit: 9, weight: 0.4 },
  },
  {
    id: 'iron_kite_shield',
    name: 'Iron Kite Shield',
    kind: 'shield',
    glyph: '🛡',
    tier: 4,
    stackable: false,
    maxStack: 1,
    blurb: 'Broad cover and a deep guard meter.',
    shield: { absorb: 0.7, coneDeg: 85, guard: 60, guardPerHit: 11, weight: 1.4 },
  },
  {
    id: 'tower_shield',
    name: 'Tower Shield',
    kind: 'shield',
    glyph: '🛡',
    tier: 6,
    stackable: false,
    maxStack: 1,
    blurb: 'A wall you carry. Almost nothing gets through the front.',
    shield: { absorb: 0.85, coneDeg: 100, guard: 95, guardPerHit: 12, weight: 2.6 },
  },
);

// --- Spells -----------------------------------------------------------------

function spellItem(
  id: string,
  name: string,
  glyph: string,
  blurb: string,
  spell: Partial<SpellDef> & { tier: 1 | 2 | 3; kind: SpellDef['kind'] },
): ItemDef {
  const cost = spell.cost ?? 'slot';
  return {
    id,
    name,
    kind: 'spell',
    glyph,
    // Mana spells are common tools; slot spells are rationed and rarer.
    tier: cost === 'mana' ? 1 : spell.tier * 2,
    stackable: false,
    maxStack: 1,
    blurb,
    spell: {
      cost,
      mana: spell.mana ?? 0,
      sustained: spell.sustained ?? false,
      burn: spell.burn ?? 0,
      burnDuration: spell.burnDuration ?? 0,
      stunChance: spell.stunChance ?? 0,
      stunDuration: spell.stunDuration ?? 0,
      tier: spell.tier,
      kind: spell.kind,
      damage: spell.damage ?? 0,
      type: spell.type ?? 'magic',
      castTime: spell.castTime ?? 0.35,
      cooldown: spell.cooldown ?? 0.7,
      speed: spell.speed ?? 0,
      radius: spell.radius ?? 0,
      range: spell.range ?? 30,
      targets: spell.targets ?? 1,
      amount: spell.amount ?? 0,
      duration: spell.duration ?? 0,
      blockDamage: spell.blockDamage ?? 0,
      armorPierce: spell.armorPierce ?? 0.3,
    },
  };
}

// --- Mana spells: the everyday tools ----------------------------------------
//
// Weaker than slot spells but limited only by the mana pool, which refills from
// potions and from orbs enemies drop. These are what you actually fight with.
defs.push(
  spellItem('flames', 'Flames', '🔥', 'A held jet of fire. Sets whatever it touches burning.', {
    cost: 'mana', mana: 14, sustained: true, tier: 1, kind: 'stream',
    damage: 7, type: 'fire', radius: 6.5, range: 6.5,
    burn: 6, burnDuration: 4, castTime: 0, cooldown: 0.08, armorPierce: 0.35,
  }),
  spellItem('sparks', 'Sparks', '⚡', 'A held arc of lightning. Sometimes locks a foe rigid.', {
    cost: 'mana', mana: 16, sustained: true, tier: 1, kind: 'stream',
    damage: 9, type: 'magic', radius: 8, range: 8,
    stunChance: 0.12, stunDuration: 1.1, castTime: 0, cooldown: 0.1, armorPierce: 0.5,
  }),
  spellItem('mending_hand', 'Healing', '✚', 'Knits your wounds while you hold it. Slow, but cheap.', {
    cost: 'mana', mana: 11, sustained: true, tier: 1, kind: 'channel',
    amount: 9, castTime: 0, cooldown: 0.1,
  }),
  spellItem('fire_dart', 'Fire Dart', '☄️', 'A fast bolt of flame. Hits harder than Flames and keeps its distance.', {
    cost: 'mana', mana: 20, tier: 1, kind: 'projectile',
    damage: 19, type: 'fire', speed: 38, castTime: 0.2, cooldown: 0.45,
    burn: 4, burnDuration: 3, armorPierce: 0.4,
  }),
  spellItem('oakflesh', 'Oakflesh', '🌳', 'Hardens your skin: +14 armor for a minute. Vital if you travel light.', {
    cost: 'mana', mana: 32, tier: 1, kind: 'ward',
    amount: 14, duration: 60, castTime: 0.5, cooldown: 1.2,
  }),
);

// --- Slot spells: rationed and powerful -------------------------------------
defs.push(
  spellItem('firebolt', 'Greater Firebolt', '🔥', 'A dart of flame. Cheap, fast, reliable.', {
    tier: 1, kind: 'projectile', damage: 14, type: 'fire', speed: 34, castTime: 0.25, cooldown: 0.5, armorPierce: 0.4,
  }),
  spellItem('frost_shard', 'Frost Shard', '❄️', 'Piercing ice that leaves the target sluggish.', {
    tier: 1, kind: 'projectile', damage: 11, type: 'pierce', speed: 40, castTime: 0.28, cooldown: 0.55, duration: 2.5, armorPierce: 0.5,
  }),
  spellItem('mend', 'Mend', '✨', 'Closes your own wounds. Costs a slot, not blood.', {
    tier: 1, kind: 'heal', amount: 18, castTime: 0.7, cooldown: 1.2,
  }),
  spellItem('arcane_nova', 'Arcane Nova', '🌀', 'A shockwave centred on you. Clears a swarm off your back.', {
    tier: 2, kind: 'nova', damage: 22, radius: 6.5, castTime: 0.45, cooldown: 1.0, armorPierce: 0.45,
  }),
  spellItem('chain_lightning', 'Chain Lightning', '⚡', 'Leaps between up to four foes.', {
    tier: 2, kind: 'chain', damage: 19, radius: 8, targets: 4, range: 24, castTime: 0.4, cooldown: 1.1, armorPierce: 0.6,
  }),
  spellItem('stoneskin', 'Stoneskin', '🪨', 'Hardens your hide for a while. Stacks with worn armour.', {
    tier: 2, kind: 'ward', amount: 6, duration: 18, castTime: 0.6, cooldown: 1.5,
  }),
  spellItem('meteor', 'Meteor', '☄️', 'Calls down a rock. Kills crowds and remodels the landscape.', {
    tier: 3, kind: 'meteor', damage: 70, type: 'explosive', radius: 7, range: 42, castTime: 1.1, cooldown: 3, blockDamage: 4, armorPierce: 0.4,
  }),
);

// --- Consumables ------------------------------------------------------------

defs.push(
  {
    id: 'healing_draught',
    name: 'Healing Draught',
    kind: 'consumable',
    glyph: '🧪',
    tier: 1,
    stackable: true,
    maxStack: 8,
    blurb: 'Restores 25 health.',
    consumable: { heal: 25, restoreTier: 0, stamina: 0 },
  },
  {
    id: 'mana_potion',
    name: 'Mana Potion',
    kind: 'consumable',
    glyph: '🫙',
    tier: 2,
    stackable: true,
    maxStack: 8,
    blurb: 'Restores 60 mana. The only way to refill it besides orbs.',
    consumable: { heal: 0, restoreTier: 0, stamina: 0, mana: 60 },
  },
  {
    id: 'mana_tonic',
    name: 'Mana Tonic',
    kind: 'consumable',
    glyph: '⚗️',
    tier: 3,
    stackable: true,
    maxStack: 8,
    blurb: 'Refills one tier-1 or tier-2 spell slot.',
    consumable: { heal: 0, restoreTier: 2, stamina: 0 },
  },
  {
    id: 'ration',
    name: 'Ration',
    kind: 'consumable',
    glyph: '🍖',
    tier: 1,
    stackable: true,
    maxStack: 16,
    blurb: 'Restores stamina and a little health.',
    consumable: { heal: 6, restoreTier: 0, stamina: 60 },
  },
);

// --- Tools ------------------------------------------------------------------

/**
 * Mining instruments.
 *
 * Tools are not weapons and deliberately make poor ones: they carry a feeble
 * `melee` fallback so being caught holding one is a real cost, which is what stops
 * a pickaxe from simply being the best item in the game. The tier is what gates
 * ore — a wooden pick will break iron ore and get nothing for it.
 */
function tool(id: string, name: string, glyph: string, def: ToolDef, blurb: string): ItemDef {
  return {
    id,
    name,
    glyph,
    kind: 'tool',
    tier: def.tier,
    stackable: false,
    maxStack: 1,
    blurb,
    tool: def,
    weapon: {
      class: 'melee',
      twoHanded: false,
      melee: {
        swing: swing(Math.round(2 + def.tier), 2.3, { type: 'blunt', stamina: 9, maxTargets: 1, knockback: 3 }),
      },
    },
  };
}

defs.push(
  tool('wood_pickaxe', 'Wooden Pickaxe', '⛏️', { kind: 'pickaxe', tier: 1, speed: 2.4 },
    'Breaks stone. Too soft for ore — it will shatter it and leave you nothing.'),
  tool('stone_pickaxe', 'Stone Pickaxe', '⛏️', { kind: 'pickaxe', tier: 2, speed: 3.6 },
    'Hard enough for iron ore, not for gold.'),
  tool('iron_pickaxe', 'Iron Pickaxe', '⛏️', { kind: 'pickaxe', tier: 3, speed: 5.2 },
    'Cuts anything the world is made of, gold ore included.'),
  tool('stone_axe', 'Stone Axe', '🪓', { kind: 'axe', tier: 2, speed: 3.4 },
    'For timber. Fells a tree in a fraction of the time your hands would.'),
  tool('stone_shovel', 'Stone Shovel', '🥄', { kind: 'shovel', tier: 2, speed: 3.4 },
    'For soil, sand and snow.'),
);

// --- Light sources ----------------------------------------------------------

defs.push({
  id: 'torch',
  name: 'Torch',
  kind: 'torch',
  glyph: '🕯️',
  tier: 1,
  stackable: true,
  maxStack: 24,
  blurb: 'Held in the off hand, alongside a shield. Right-click to plant one as a light.',
  torch: { radius: 11, intensity: 1.4 },
  // Also placeable, so a stack of torches lights a building site.
  block: Block.Torch,
});

// --- Food -------------------------------------------------------------------

defs.push(
  {
    id: 'raw_fish',
    name: 'Raw Fish',
    kind: 'consumable',
    glyph: '🐟',
    tier: 1,
    stackable: true,
    maxStack: 16,
    blurb: 'Edible, barely. Use it while holding a lit torch to cook it instead.',
    consumable: { heal: 5, restoreTier: 0, stamina: 30 },
  },
  {
    id: 'cooked_fish',
    name: 'Cooked Fish',
    kind: 'consumable',
    glyph: '🍣',
    tier: 2,
    stackable: true,
    maxStack: 16,
    blurb: 'Restores 26 health and a good deal of stamina.',
    consumable: { heal: 26, restoreTier: 0, stamina: 70 },
  },
);

// --- Placeable blocks (generated from the block registry) -------------------

for (const b of PLACEABLE) {
  // The torch already exists as a hand-held item that doubles as a placeable.
  if (b === Block.Torch) continue;
  const bd = blockDef(b);
  defs.push({
    id: `block_${bd.name.toLowerCase().replace(/[^a-z]+/g, '_')}`,
    name: bd.name,
    kind: 'block',
    glyph: bd.glyph,
    tier: 1,
    stackable: true,
    maxStack: 99,
    blurb: 'Building material.',
    block: b,
  });
}

export const ITEMS: ReadonlyMap<string, ItemDef> = new Map(defs.map((d) => [d.id, d]));

export function item(id: string): ItemDef {
  const found = ITEMS.get(id);
  if (!found) throw new Error(`Unknown item id: ${id}`);
  return found;
}

export function tryItem(id: string): ItemDef | undefined {
  return ITEMS.get(id);
}

/**
 * Maps a block id back to its inventory item, for mining drops.
 *
 * Matches on the `block` field alone rather than on `kind === 'block'`. The torch
 * is a hand-held light that *also* places, so its kind is `torch` — and keying on
 * the kind meant a placed torch, mined back up, resolved to no item and vanished.
 */
export function itemForBlock(block: Block): ItemDef | undefined {
  for (const d of ITEMS.values()) if (d.block === block) return d;
  return undefined;
}

export function ammoItemFor(type: AmmoType): ItemDef | undefined {
  if (type === 'none') return undefined;
  for (const d of ITEMS.values()) if (d.kind === 'ammo' && d.ammo === type) return d;
  return undefined;
}

/** Human-readable summary of an attack mode, for the HUD. */
export function describeMode(a: MeleeAttack): string {
  const label: Record<AttackMode, string> = { swing: 'Swing', thrust: 'Thrust' };
  const pierce = a.armorPierce >= 0.4 ? ` · ${Math.round(a.armorPierce * 100)}% armor pierce` : '';
  return `${label[a.mode]} · ${a.damage} ${a.type}${pierce}`;
}

export const ALL_ITEM_IDS: readonly string[] = defs.map((d) => d.id);
