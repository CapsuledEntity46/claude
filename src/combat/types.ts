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

/**
 * The nine strokes a mouse gesture can describe.
 *
 * Melee is driven by moving the mouse while the attack button is held, as in
 * Daggerfall and Ultima Underworld: the *direction* of the movement is the attack.
 * Eight of these are swings; `thrust` is what a forward jab or a bare click means.
 *
 * A direction is not the same thing as an `AttackMode`. The mode is the damage
 * family — which is a property of the weapon's shape — and the direction is how the
 * player moved. Every direction resolves to a mode, and a weapon that cannot perform
 * that mode falls back to one it can.
 */
export type AttackDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'upLeft'
  | 'upRight'
  | 'downLeft'
  | 'downRight'
  | 'thrust';

export const DIRECTION_LABEL: Record<AttackDirection, string> = {
  left: 'Left slash',
  right: 'Right slash',
  up: 'Uppercut',
  down: 'Downcut',
  upLeft: 'Rising slash (left)',
  upRight: 'Rising slash (right)',
  downLeft: 'Falling slash (left)',
  downRight: 'Falling slash (right)',
  thrust: 'Thrust',
};

/** Every direction except `thrust` is a swing. */
export function directionToMode(direction: AttackDirection): AttackMode {
  return direction === 'thrust' ? 'thrust' : 'swing';
}

/**
 * Screen-space travel of each stroke, with **y pointing up**.
 *
 * Shared by the hit-cone bias and the view model, so the blow lands where the
 * animation shows it going. Mouse deltas arrive y-down and are flipped on the way in;
 * everything downstream of the classifier works in this convention.
 */
export const DIRECTION_VECTOR: Record<AttackDirection, readonly [number, number]> = {
  right: [1, 0],
  upRight: [Math.SQRT1_2, Math.SQRT1_2],
  up: [0, 1],
  upLeft: [-Math.SQRT1_2, Math.SQRT1_2],
  left: [-1, 0],
  downLeft: [-Math.SQRT1_2, -Math.SQRT1_2],
  down: [0, -1],
  downRight: [Math.SQRT1_2, -Math.SQRT1_2],
  thrust: [0, 0],
};

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

/**
 * Which melee motions a weapon's shape permits, and the stats for each.
 *
 * A record rather than an ordered array. The array form carried an implicit "index 0
 * is the default mode", which existed only to support cycling the selection with a
 * key — and once the attack is chosen by a mouse gesture there is no selection and no
 * default, so the ordering meant nothing. What matters is the question the geometry
 * rule actually asks: *can* this weapon swing, and *can* it thrust.
 */
export interface MeleeModes {
  swing?: MeleeAttack;
  thrust?: MeleeAttack;
}

export interface WeaponDef {
  class: WeaponClass;
  /** The motions this weapon's shape allows. A mace has no thrust; a rapier no swing. */
  melee: MeleeModes;
  ranged?: RangedProfile;
  /** Two-handed weapons cannot be paired with a shield. */
  twoHanded: boolean;
}

/** Collects attack definitions into the mode record, keyed by their own mode. */
export function meleeModes(attacks: readonly MeleeAttack[]): MeleeModes {
  const out: MeleeModes = {};
  for (const attack of attacks) out[attack.mode] = attack;
  return out;
}

export function hasMeleeMode(modes: MeleeModes | undefined): boolean {
  return !!modes && (!!modes.swing || !!modes.thrust);
}

/** The modes a weapon offers, for display. */
export function availableModes(modes: MeleeModes | undefined): MeleeAttack[] {
  if (!modes) return [];
  return [modes.swing, modes.thrust].filter((m): m is MeleeAttack => !!m);
}

// ------------------------------------------------------------- direction shaping

/**
 * How each stroke reshapes the weapon's base stats.
 *
 * Multipliers on top of the weapon's own `MeleeAttack`, so a new weapon needs no
 * per-direction data and the relationships hold across the whole armoury: a warhammer
 * uppercut is slow and brutal *relative to a warhammer*, not in absolute numbers.
 *
 * The flavour, deliberately: horizontal cuts are quick and sweep wide, so they are the
 * answer to being surrounded. Vertical cuts are slow, narrow and heavy — committing,
 * and worth it against a single target. Diagonals sit between the two. A thrust keeps
 * the weapon's own precision and armour-piercing character untouched.
 */
export interface DirectionModifier {
  damage: number;
  windup: number;
  recovery: number;
  stamina: number;
  reach: number;
  arcDeg: number;
  armorPierce: number;
  knockback: number;
}

const NEUTRAL: DirectionModifier = {
  damage: 1,
  windup: 1,
  recovery: 1,
  stamina: 1,
  reach: 1,
  arcDeg: 1,
  armorPierce: 1,
  knockback: 1,
};

export const DIRECTION_MODIFIERS: Record<AttackDirection, DirectionModifier> = {
  // Fast and wide: less damage per blow, but it sweeps.
  left: { ...NEUTRAL, damage: 0.95, windup: 0.85, recovery: 0.9, stamina: 0.95, arcDeg: 1.25 },
  right: { ...NEUTRAL, damage: 0.95, windup: 0.85, recovery: 0.9, stamina: 0.95, arcDeg: 1.25 },

  // Slow, narrow, heavy. An uppercut lifts; a downcut comes through the guard.
  up: { ...NEUTRAL, damage: 1.3, windup: 1.35, recovery: 1.2, stamina: 1.25, reach: 0.95, arcDeg: 0.6, knockback: 1.5 },
  down: {
    ...NEUTRAL,
    damage: 1.35,
    windup: 1.4,
    recovery: 1.25,
    stamina: 1.3,
    reach: 1.05,
    arcDeg: 0.55,
    armorPierce: 1.15,
    knockback: 1.2,
  },

  // Between the two, with the falling cuts carrying a little more weight.
  upLeft: { ...NEUTRAL, damage: 1.05, knockback: 1.05, arcDeg: 0.95 },
  upRight: { ...NEUTRAL, damage: 1.05, knockback: 1.05, arcDeg: 0.95 },
  downLeft: { ...NEUTRAL, damage: 1.1, windup: 1.05, stamina: 1.05, armorPierce: 1.05, knockback: 1.1, arcDeg: 0.9 },
  downRight: { ...NEUTRAL, damage: 1.1, windup: 1.05, stamina: 1.05, armorPierce: 1.05, knockback: 1.1, arcDeg: 0.9 },

  thrust: { ...NEUTRAL },
};

/**
 * A thrust gesture on a weapon with no point.
 *
 * Down rather than a side: a forward jab and an overhead chop are both "straight at
 * it" with no lateral commitment, so a downcut preserves what the player meant better
 * than arbitrarily picking left or right.
 */
export const THRUST_FALLBACK_DIRECTION: AttackDirection = 'down';

export function applyDirectionModifiers(base: MeleeAttack, direction: AttackDirection): MeleeAttack {
  const m = DIRECTION_MODIFIERS[direction];
  return {
    ...base,
    damage: base.damage * m.damage,
    windup: base.windup * m.windup,
    recovery: base.recovery * m.recovery,
    // Stamina is spent in whole points, and rounding down would make the heavy
    // strokes free at low cost weapons.
    stamina: Math.max(1, Math.round(base.stamina * m.stamina)),
    reach: base.reach * m.reach,
    arcDeg: base.arcDeg * m.arcDeg,
    armorPierce: Math.min(1, base.armorPierce * m.armorPierce),
    knockback: base.knockback * m.knockback,
  };
}

export interface ResolvedAttack {
  attack: MeleeAttack;
  /** The stroke actually performed, after any geometry fallback. */
  direction: AttackDirection;
  /** What the player's gesture asked for, before the fallback. */
  requested: AttackDirection;
  mode: AttackMode;
  /** True when the weapon's shape forced a different stroke. */
  fellBack: boolean;
}

/**
 * Turns a gesture into a concrete attack, honouring the weapon's geometry.
 *
 * This is where the README's central rule is enforced: a mace has no point, so asking
 * it to thrust gets you a chop instead; a rapier has no edge, so every slash becomes a
 * thrust. The player is told when that happens, which is the only way the rule teaches
 * itself.
 */
export function resolveDirectionalAttack(
  modes: MeleeModes | undefined,
  requested: AttackDirection,
): ResolvedAttack | null {
  if (!modes) return null;
  const wanted = directionToMode(requested);

  const direct = modes[wanted];
  if (direct) {
    return {
      attack: applyDirectionModifiers(direct, requested),
      direction: requested,
      requested,
      mode: wanted,
      fellBack: false,
    };
  }

  if (wanted === 'thrust' && modes.swing) {
    const direction = THRUST_FALLBACK_DIRECTION;
    return {
      attack: applyDirectionModifiers(modes.swing, direction),
      direction,
      requested,
      mode: 'swing',
      fellBack: true,
    };
  }

  if (wanted === 'swing' && modes.thrust) {
    return {
      attack: applyDirectionModifiers(modes.thrust, 'thrust'),
      direction: 'thrust',
      requested,
      mode: 'thrust',
      fellBack: true,
    };
  }

  return null;
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
