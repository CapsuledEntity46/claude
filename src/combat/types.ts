/**
 * Combat vocabulary and the damage formula.
 *
 * The central idea: a weapon's *geometry* determines which attack modes it has,
 * each mode deals a different damage type, and armour resists types unevenly.
 * A mace has no point, so it can only swing (blunt) — which happens to be the
 * one thing iron plate handles badly. A sword can do both, so the player picks.
 */

export type DamageType = 'slash' | 'pierce' | 'blunt' | 'magic' | 'fire' | 'explosive';

export const DAMAGE_TYPE_LABEL: Record<DamageType, string> = {
  slash: 'Slashing',
  pierce: 'Piercing',
  blunt: 'Bludgeoning',
  magic: 'Arcane',
  fire: 'Fire',
  explosive: 'Explosive',
};

/** The two melee motions. Which ones a weapon offers is a property of its shape. */
export type AttackMode = 'swing' | 'thrust';

export type AmmoType = 'arrow' | 'bolt' | 'shot' | 'none';

export const AMMO_LABEL: Record<AmmoType, string> = {
  arrow: 'Arrows',
  bolt: 'Bolts',
  shot: 'Lead Shot',
  none: '—',
};

export type WeaponClass = 'melee' | 'bow' | 'crossbow' | 'firearm' | 'thrown';

export interface MeleeAttack {
  mode: AttackMode;
  /** Base damage before attributes and armour. */
  damage: number;
  type: DamageType;
  /** Metres of reach from the eye. */
  reach: number;
  /** Half-angle of the hit cone, in degrees. Swings are wide, thrusts narrow. */
  arcDeg: number;
  /** Seconds of telegraph before damage lands. */
  windup: number;
  /** Seconds of lockout after the hit. */
  recovery: number;
  stamina: number;
  /** Fraction of the target's flat armour ignored. Thrusts are high. */
  armorPierce: number;
  /** Swings can sweep several foes; thrusts hit one. */
  maxTargets: number;
  knockback: number;
}

export interface RangedProfile {
  damage: number;
  type: DamageType;
  ammo: AmmoType;
  /** Blocks per second. */
  speed: number;
  /** Multiplier on world gravity; 0 for flat-shooting bullets. */
  gravity: number;
  spreadDeg: number;
  /** Bows only: seconds to a full-power draw. */
  drawTime: number;
  /** Seconds to reload once the magazine empties. */
  reloadTime: number;
  /** Shots before a reload is needed. */
  magazine: number;
  /** Pellets per trigger pull (blunderbuss). */
  pellets: number;
  armorPierce: number;
  knockback: number;
  /** Firearms: smoke and flash, and they wake nearby enemies. */
  muzzleFlash: boolean;
  /** Area effect on impact. */
  aoeRadius: number;
  /** Radius of blocks destroyed on impact, 0 for none. */
  blockDamage: number;
  /** Thrown weapons: seconds before detonating. */
  fuse: number;
  /** Seconds between shots. */
  cooldown: number;
}

export interface WeaponDef {
  class: WeaponClass;
  /** Available melee modes. Order matters: index 0 is the default. */
  melee: MeleeAttack[];
  ranged?: RangedProfile;
  /** Two-handed weapons cannot be paired with a shield. */
  twoHanded: boolean;
}

export interface ArmorDef {
  /** Flat damage subtracted after type resistance. */
  armor: number;
  /**
   * Fraction of incoming damage removed, per type. Negative means *vulnerable*.
   */
  resist: Partial<Record<DamageType, number>>;
  /**
   * How much of the flat armour value applies, per damage type.
   *
   * This exists because a percentage resistance alone cannot express "a hammer
   * ignores plate": the flat term is large enough to swamp any sane negative
   * resistance. Rigid armour transmits blunt force to the body underneath
   * rather than absorbing it, so plate's factor against blunt is low —
   * which is what actually makes a mace the right tool against a knight.
   * Missing entries default to 1.
   */
  armorFactor?: Partial<Record<DamageType, number>>;
  /** Slows movement and stamina regen. */
  weight: number;
}

export interface ShieldDef {
  /** Fraction of damage absorbed when a hit lands inside the guard cone. */
  absorb: number;
  /** Half-angle of the protected cone, in degrees. */
  coneDeg: number;
  /** Added to max guard meter. */
  guard: number;
  /** Guard consumed per blocked hit. */
  guardPerHit: number;
  weight: number;
}

export type SpellKind =
  | 'projectile'
  | 'nova'
  | 'chain'
  | 'heal'
  | 'ward'
  | 'meteor'
  /** A held cone of flame that burns whatever it touches. */
  | 'stream'
  /** A continuous heal while the button is held. */
  | 'channel';

export interface SpellDef {
  /**
   * How the spell is paid for.
   *
   * Slot spells are the powerful, rationed ones. Mana spells are the everyday
   * tools: weaker, but limited only by a pool you can refill from potions and
   * from orbs that enemies drop.
   */
  cost: 'slot' | 'mana';
  /** Mana consumed per cast, or per second for held spells. */
  mana: number;
  /** True for spells that are held down rather than cast once. */
  sustained: boolean;
  /** Damage over time applied on hit, per second. */
  burn: number;
  burnDuration: number;
  /** Chance to stun on hit, 0..1. */
  stunChance: number;
  stunDuration: number;
  /** Spell slot tier consumed on cast. Ignored by mana spells. */
  tier: 1 | 2 | 3;
  kind: SpellKind;
  damage: number;
  type: DamageType;
  castTime: number;
  cooldown: number;
  /** Projectile speed, or 0 for instant effects. */
  speed: number;
  /** Effect radius for novas/meteors, or targeting range for chains. */
  radius: number;
  range: number;
  /** Chain spells: how many targets. */
  targets: number;
  /** Wards/heals: seconds of effect or flat heal amount. */
  amount: number;
  duration: number;
  blockDamage: number;
  armorPierce: number;
}

export interface ConsumableDef {
  heal: number;
  /** Restores one spell slot of this tier, if non-zero. */
  restoreTier: 0 | 1 | 2 | 3;
  stamina: number;
  /** Mana restored. Mana has no passive regeneration, so this matters. */
  mana?: number;
}

// ------------------------------------------------------------------ damage math

/** Everything the formula needs to know about whoever is being hit. */
export interface DefenseProfile {
  armor: number;
  resist: Partial<Record<DamageType, number>>;
  /** Per-type scaling of the flat armour term. Missing entries default to 1. */
  armorFactor?: Partial<Record<DamageType, number>>;
}

export interface DamageInput {
  amount: number;
  type: DamageType;
  /** 0..1 fraction of flat armour bypassed. */
  armorPierce?: number;
  /** Extra multiplier from attributes, draw strength, charge, etc. */
  multiplier?: number;
  /** Set for attacks that cannot crit (explosions, damage over time). */
  canCrit?: boolean;
  critChance?: number;
  critMultiplier?: number;
}

export interface DamageResult {
  /** Final damage after resistance, armour, crit, and variance. */
  damage: number;
  crit: boolean;
  /** How much armour + resistance removed, for feedback like "clang!". */
  mitigated: number;
}

const MIN_DAMAGE = 1;

/**
 * Resistance is applied first as a percentage, then flat armour is subtracted.
 * Piercing attacks bypass a fraction of the flat term, which is what makes a
 * thrust the right answer against a heavily armoured target.
 */
export function computeDamage(input: DamageInput, defense: DefenseProfile, rng: () => number = Math.random): DamageResult {
  const multiplier = input.multiplier ?? 1;
  const base = input.amount * multiplier;

  // +/-10% variance keeps repeated hits from feeling metronomic.
  const variance = 0.9 + rng() * 0.2;

  const critChance = input.canCrit === false ? 0 : input.critChance ?? 0.06;
  const crit = rng() < critChance;
  const critMul = crit ? input.critMultiplier ?? 1.8 : 1;

  const raw = base * variance * critMul;

  const resist = defense.resist[input.type] ?? 0;
  const afterResist = raw * (1 - resist);

  const pierce = Math.max(0, Math.min(1, input.armorPierce ?? 0));
  // Two independent ways to get past armour: piercing bypasses it, and some
  // damage types simply are not stopped by it in the first place.
  const factor = defense.armorFactor?.[input.type] ?? 1;
  const effectiveArmor = defense.armor * (1 - pierce) * factor;

  const final = Math.max(MIN_DAMAGE, afterResist - effectiveArmor);

  return {
    damage: Math.round(final * 10) / 10,
    crit,
    mitigated: Math.max(0, Math.round((raw - final) * 10) / 10),
  };
}

/** Merges armour, ward, and shield contributions into one profile. */
export function combineDefense(parts: readonly (DefenseProfile | null | undefined)[]): DefenseProfile {
  const out: DefenseProfile = { armor: 0, resist: {}, armorFactor: {} };
  for (const part of parts) {
    if (!part) continue;
    out.armor += part.armor;
    for (const key of Object.keys(part.resist) as DamageType[]) {
      out.resist[key] = (out.resist[key] ?? 0) + (part.resist[key] ?? 0);
    }
    // Factors compose multiplicatively; a part that defines none contributes 1.
    for (const key of Object.keys(part.armorFactor ?? {}) as DamageType[]) {
      out.armorFactor![key] = (out.armorFactor![key] ?? 1) * (part.armorFactor![key] ?? 1);
    }
  }
  return out;
}
