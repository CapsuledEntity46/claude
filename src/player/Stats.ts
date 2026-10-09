/**
 * Player progression: five 5e ability scores, no classes.
 *
 * Scores are chosen at creation by point buy and raised by levelling. What reaches
 * the formulas below is never the raw score but its *modifier*,
 * `floor((score - 10) / 2)` — so 10 is the average that changes nothing, 8 is a
 * genuine weakness, and an odd score buys nothing the even one below it did not.
 * That is the 5e contract, and keeping it means a player who knows 5e can predict
 * this character sheet.
 *
 * Skills contribute through a modifier bag rather than by touching these formulas,
 * so a build is always `ability modifier + equipment + skills` and never a special
 * case hidden in a getter.
 */

import {
  abilityModifier,
  type AbilityKey,
  type AbilityScores,
  createPointBuyState,
  sanitizeScores,
} from './PointBuy';
import {
  NO_MODIFIERS,
  aggregateModifiers,
  pruneIllegalSkills,
  type SkillModifiers,
  type SkillRanks,
} from './Skills';

export type { AbilityKey, AbilityScores } from './PointBuy';

/**
 * Attribute points granted per level.
 *
 * One, not two. Point buy already decided the shape of the character, so levelling
 * is a slow refinement of it rather than a second allocation that washes the first
 * one out — and a 5e score is worth far more per point than the old 1-to-20 stats
 * were, since two points move a modifier.
 */
export const POINTS_PER_LEVEL = 1;

/** The highest score levelling can reach. Point buy stops at 15; this is the cap. */
export const ABILITY_MAX = 20;
const SPELL_SLOT_REGEN_SECONDS = 24;
/** Seconds without taking damage before health starts recovering. */
const REGEN_DELAY = 7;
const REGEN_PER_SECOND = 1.6;

/**
 * Stamina recovered per second once recovery has started.
 *
 * Was 22, which refilled the whole bar in four and a half seconds and made the
 * resource decorative: a swing's wind-up and recovery alone regenerated about
 * what the swing had just cost, so attacking from a standstill was free.
 */
const STAMINA_PER_SECOND = 11;

/**
 * Seconds after spending stamina before any of it comes back.
 *
 * This matters more than the rate. With no delay at all, recovery resumed on the
 * very next frame, so a melee cycle of roughly half a second clawed back half its
 * own cost before it had even finished — the bar simply never moved. A pause
 * slightly longer than a weapon's full swing is what turns stamina into something
 * you spend and then wait for.
 */
const STAMINA_RECOVERY_DELAY = 0.95;

/**
 * Fraction of the bar that must come back before sprinting is allowed again.
 *
 * Sprint used to re-arm at one point of stamina, which meant running flat out
 * forever by releasing and re-pressing: a single frame under the threshold handed
 * control back to the recovery branch, which immediately re-armed it. Having run
 * yourself out should cost something, so the latch stays shut until a quarter of
 * the bar is back.
 */
const SPRINT_RECOVER_FRACTION = 0.25;

/** Total XP required to reach a given level. */
export function xpToReach(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(28 * Math.pow(level - 1, 1.55));
}

export interface StatsSnapshot {
  level: number;
  xp: number;
  hp: number;
  /** 5e ability scores. Optional so a pre-5e save still deserialises. */
  abilities?: AbilityScores;
  unspent: number;
  slotsUsed: number[];
  mana?: number;
  /** Skill ranks by node id. */
  skills?: Record<string, number>;
  gold?: number;
}

/**
 * Player stats: health, stamina, mana, and derived values.
 */
export class PlayerStats {
  level = 1;
  /** Cumulative XP across the whole run. */
  xp = 0;
  hp = 20;

  /**
   * The five ability scores. Starts at the point-buy baseline of 8 across the
   * board; a character that has been through creation arrives with its own spread.
   */
  abilities: AbilityScores = createPointBuyState().scores;
  unspent = 0;

  /** Skill ranks by node id, and the gold a respec spends. */
  skills: SkillRanks = {};
  gold = 0;

  /**
   * Cached skill modifiers.
   *
   * Recomputed on `syncSkills` rather than on every getter read: `maxHp` and
   * friends are read several times per frame by the HUD, the damage pipeline and
   * the view model, and summing the whole tree each time is wasted work.
   */
  private mods: SkillModifiers = { ...NO_MODIFIERS };

  stamina = 100;
  guard = 0;
  /**
   * Mana for everyday spells.
   *
   * Deliberately does *not* regenerate on its own: the only sources are potions
   * and the orbs enemies drop, which keeps casting a resource you manage rather
   * than a cooldown you wait out. Spell slots remain separate, for the rare
   * powerful spells.
   */
  mana = 60;

  /** Spell slots consumed, per tier (index 0 = tier 1). */
  slotsUsed = [0, 0, 0];
  private slotRegenTimer = 0;

  /** Temporary bonus armour from Stoneskin or Oakflesh. */
  wardArmor = 0;
  wardTimer = 0;

  /** Movement penalty timer from Frost Shard and similar effects. */
  slowTimer = 0;

  /** Seconds since the player last took a hit, for out-of-combat regeneration. */
  timeSinceDamage = REGEN_DELAY;

  /** Seconds since stamina was last spent, for the recovery delay. */
  timeSinceStamina = STAMINA_RECOVERY_DELAY;
  /** Set when stamina bottoms out; blocks sprinting until enough is back. */
  private sprintLocked = false;

  /** Total equipment weight, set by the Player each frame. */
  weight = 0;
  /** Max guard from the equipped shield, set by the Player each frame. */
  shieldGuard = 0;

  // Status effect manager
  private statusEffectManager = require('../combat/StatusEffectSystem').default;

  // ------------------------------------------------------------ derived values

  /** `floor((score - 10) / 2)` for one ability. */
  modifier(ability: AbilityKey): number {
    return abilityModifier(this.abilities[ability]);
  }

  /** The skill modifiers currently in force, for the sheet. */
  get skillModifiers(): Readonly<SkillModifiers> {
    return this.mods;
  }

  /**
   * Recomputes the cached skill bag, dropping anything the build no longer
   * supports. Called after any change to skills, abilities or level.
   */
  syncSkills(): void {
    this.skills = pruneIllegalSkills(this.skills, this.level, this.abilities);
    this.mods = aggregateModifiers(this.skills);
  }

  /**
   * Health comes from Constitution, as in 5e — not from the melee stat.
   *
   * Centred so an all-average character has the 34 HP the game was balanced
   * around, with the modifier worth 5 either way: a CON 8 character is genuinely
   * fragile at 29, and a CON 16 one is sturdy at 49.
   */
  get maxHp(): number {
    return 34 + (this.level - 1) * 6 + this.modifier('con') * 5 + this.mods.maxHp;
  }

  get maxStamina(): number {
    return 100 + this.modifier('dex') * 6 + this.modifier('con') * 4 + this.mods.maxStamina;
  }

  get maxMana(): number {
    return 60 + (this.level - 1) * 6 + this.modifier('int') * 10 + this.mods.maxMana;
  }

  /** Spends mana if there is enough. Returns false when there is not. */
  spendMana(amount: number): boolean {
    if (this.mana < amount) return false;
    this.mana -= amount;
    return true;
  }

  /** Restores mana, capped at the maximum. Returns how much was actually added. */
  restoreMana(amount: number): number {
    const before = this.mana;
    this.mana = Math.min(this.maxMana, this.mana + amount);
    return this.mana - before;
  }

  get maxGuard(): number {
    return this.shieldGuard;
  }

  get meleeMultiplier(): number {
    return 1 + this.modifier('str') * 0.09 + this.mods.meleeDamage;
  }

  get rangedMultiplier(): number {
    return 1 + this.modifier('dex') * 0.09 + this.mods.rangedDamage;
  }

  get spellMultiplier(): number {
    return 1 + this.modifier('int') * 0.1 + this.mods.spellDamage;
  }

  /** Bonus critical chance from Dexterity and the tree, as a flat probability. */
  get critChanceBonus(): number {
    return Math.max(0, this.modifier('dex') * 0.015) + this.mods.critChance;
  }

  /** Bonus armour pierce from the tree. */
  get armorPierceBonus(): number {
    return this.mods.armorPierce;
  }

  /** Skill-granted flat armour, folded in alongside equipment and wards. */
  get skillArmor(): number {
    return this.mods.armor;
  }

  /** How much of a fall is absorbed, 0..0.9. */
  get fallDamageScale(): number {
    return Math.max(0.1, 1 - Math.min(0.9, this.mods.fallDamage));
  }

  /** Multiplies the stamina an attack costs. */
  get attackStaminaScale(): number {
    return Math.max(0.3, 1 - this.mods.attackStamina);
  }

  /** Multiplies a bow's draw time. Lower is faster. */
  get drawTimeScale(): number {
    return Math.max(0.4, 1 - this.mods.drawSpeed);
  }

  /** Multiplies a spell's mana cost. */
  get manaCostScale(): number {
    return Math.max(0.25, 1 - this.mods.manaCost);
  }

  /** Walk speed in blocks/second, before sprint. Armour weight slows you down. */
  get moveSpeed(): number {
    const base = 4.6 * (1 + this.modifier('dex') * 0.025 + this.mods.moveSpeed);
    const encumbered = base * Math.max(0.55, 1 - this.weight * 0.055);
    // Apply status effect speed modifier (e.g., from SLOW)
    const speedMultiplier = this.getSpeedMultiplier();
    return this.slowTimer > 0 ? encumbered * 0.55 * speedMultiplier : encumbered * speedMultiplier;
  }

  /**
   * Max spell slots per tier, from Wisdom.
   *
   * Split from Intelligence deliberately: Intelligence buys raw spell power and
   * the mana pool, Wisdom buys how often you can reach for the rare spells. A
   * caster therefore has a real choice between hitting harder and casting more.
   */
  maxSlots(): number[] {
    const wis = this.modifier('wis');
    // Each unlocked tier floors at one slot. A negative Wisdom modifier should
    // make high magic scarce, not impossible: the sheet promises tier 2 "unlocks
    // at level 4", and an unlock that grants nothing is a broken promise rather
    // than a difficult build.
    return [
      Math.max(1, 3 + wis),
      this.level >= 4 ? Math.max(1, 2 + wis) : 0,
      this.level >= 8 ? Math.max(1, 1 + Math.floor(wis / 2)) : 0,
    ];
  }

  slotsAvailable(tier: 1 | 2 | 3): number {
    return Math.max(0, this.maxSlots()[tier - 1] - this.slotsUsed[tier - 1]);
  }

  consumeSlot(tier: 1 | 2 | 3): boolean {
    if (this.slotsAvailable(tier) <= 0) return false;
    this.slotsUsed[tier - 1]++;
    return true;
  }

  /** Refunds one slot at `tier` or below, preferring the highest available. */
  restoreSlot(tier: 1 | 2 | 3): boolean {
    for (let t = tier - 1; t >= 0; t--) {
      if (this.slotsUsed[t] > 0) {
        this.slotsUsed[t]--;
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ mutation

  /** Applies XP and returns how many levels were gained. */
  addXp(amount: number): number {
    this.xp += amount;
    let gained = 0;
    while (this.xp >= xpToReach(this.level + 1)) {
      this.level++;
      gained++;
      this.unspent += POINTS_PER_LEVEL;
    }
    if (gained > 0) {
      // Levelling up is the reward: full heal and all slots back.
      this.hp = this.maxHp;
      this.stamina = this.maxStamina;
      this.mana = this.maxMana;
      this.slotsUsed = [0, 0, 0];
    }
    return gained;
  }

  xpIntoLevel(): { current: number; needed: number } {
    const floorXp = xpToReach(this.level);
    const ceilXp = xpToReach(this.level + 1);
    return { current: this.xp - floorXp, needed: Math.max(1, ceilXp - floorXp) };
  }

  /**
   * Raises one ability score by a level-up point.
   *
   * Capped at 20, the 5e ceiling. Refuses at the cap rather than silently eating
   * the point, which is the kind of loss a player never notices until it matters.
   */
  spend(ability: AbilityKey): boolean {
    if (this.unspent <= 0) return false;
    if (this.abilities[ability] >= ABILITY_MAX) return false;
    this.unspent--;
    this.abilities[ability]++;
    this.syncSkills();
    // Investing should feel immediate, and a new CON modifier should not leave the
    // player sitting below their own new maximum.
    if (ability === 'con') this.hp = Math.min(this.maxHp, this.hp + 5);
    if (ability === 'int') this.mana = Math.min(this.maxMana, this.mana + 10);
    return true;
  }

  /**
   * Clears the skill tree for gold, returning the points to be spent again.
   *
   * Abilities are untouched: those came from creation and from levelling, and
   * wiping them would make the respec a character rewrite rather than an
   * experiment with a build.
   */
  respecSkills(cost: number): boolean {
    if (cost > this.gold) return false;
    this.gold -= cost;
    this.skills = {};
    this.syncSkills();
    return true;
  }

  /** Adds coin. */
  addGold(amount: number): void {
    if (amount <= 0) return;
    this.gold += Math.round(amount);
  }

  heal(amount: number): number {
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }

  /** Called whenever the player is hurt; gates health regeneration. */
  noteDamageTaken(): void {
    this.timeSinceDamage = 0;
  }

  /**
   * True while the player has run themselves out and not yet recovered enough to
   * sprint again. Exposed so the HUD can show the bar as spent rather than just
   * short.
   */
  get winded(): boolean {
    return this.sprintLocked;
  }

  update(dt: number, sprinting: boolean, blocking: boolean): void {
    this.timeSinceDamage += dt;
    this.timeSinceStamina += dt;

    // Slow out-of-combat healing. Without it, one bad fight at low level puts the
    // player into an unrecoverable spiral with no way back but potions.
    if (this.timeSinceDamage > REGEN_DELAY && this.hp > 0 && this.hp < this.maxHp) {
      // Constitution governs how fast you knit back together, on top of the tree.
      const rate = REGEN_PER_SECOND * (1 + this.modifier('con') * 0.12 + this.mods.healthRegen);
      this.hp = Math.min(this.maxHp, this.hp + Math.max(0.2, rate) * dt);
    }

    // Stamina: drains while sprinting or holding guard, otherwise recovers — but
    // only once the recovery delay since the last spend has elapsed. Sprinting and
    // blocking both count as spending, so neither can be feathered to dodge it.
    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - 14 * dt);
      this.timeSinceStamina = 0;
    } else if (blocking) {
      this.stamina = Math.max(0, this.stamina - 5 * dt);
      this.timeSinceStamina = 0;
    } else if (this.timeSinceStamina >= STAMINA_RECOVERY_DELAY) {
      const regen =
        STAMINA_PER_SECOND *
        Math.max(0.4, 1 - this.weight * 0.07) *
        (1 + this.modifier('con') * 0.05 + this.mods.staminaRegen);
      this.stamina = Math.min(this.maxStamina, this.stamina + regen * dt);
    }

    // Having bottomed out locks sprinting until a quarter of the bar is back.
    if (this.stamina <= 0.5) this.sprintLocked = true;
    else if (this.stamina >= this.maxStamina * SPRINT_RECOVER_FRACTION) this.sprintLocked = false;

    // Guard recovers only while not actively blocking.
    if (!blocking) {
      this.guard = Math.min(this.maxGuard, this.guard + 12 * dt);
    }

    if (this.wardTimer > 0) {
      this.wardTimer -= dt;
      if (this.wardTimer <= 0) this.wardArmor = 0;
    }
    if (this.slowTimer > 0) this.slowTimer -= dt;

    // Slow trickle of spell slots so casters are never permanently dry.
    const anyUsed = this.slotsUsed.some((n) => n > 0);
    if (anyUsed) {
      this.slotRegenTimer += dt;
      if (this.slotRegenTimer >= SPELL_SLOT_REGEN_SECONDS / (1 + this.mods.slotRegen)) {
        this.slotRegenTimer = 0;
        this.restoreSlot(1) || this.restoreSlot(2) || this.restoreSlot(3);
      }
    } else {
      this.slotRegenTimer = 0;
    }

    // Update status effects (DoT damage, etc.)
    // Note: We need to pass the GameContext to the status effect manager update.
    // However, PlayerStats does not have access to GameContext.
    // We will call this method from Player.update or Game.update instead.
    // For now, we'll leave it empty and call it externally.
  }

  /** Update status effects - to be called from Player or Game with context */
  updateStatusEffects(dt: number, ctx: any): void {
    this.statusEffectManager.update(dt, ctx);
  }

  spendStamina(amount: number): boolean {
    if (this.stamina < amount) return false;
    this.stamina -= amount;
    // Restarts the recovery delay, so a sequence of blows never regenerates
    // between its own strokes.
    this.timeSinceStamina = 0;
    return true;
  }

  /** True when sprinting is permitted: not winded, and something left to burn. */
  canSprint(): boolean {
    return !this.sprintLocked && this.stamina > 1;
  }

  resetForRespawn(): void {
    this.hp = this.maxHp;
    this.mana = this.maxMana;
    this.stamina = this.maxStamina;
    this.guard = this.maxGuard;
    this.slotsUsed = [0, 0, 0];
    this.wardArmor = 0;
    this.wardTimer = 0;
    this.slowTimer = 0;
  }

  snapshot(): StatsSnapshot {
    return {
      level: this.level,
      xp: this.xp,
      hp: this.hp,
      abilities: { ...this.abilities },
      unspent: this.unspent,
      slotsUsed: [...this.slotsUsed],
      mana: this.mana,
      skills: { ...this.skills },
      gold: this.gold,
    };
  }

  restore(s: StatsSnapshot): void {
    this.level = s.level;
    this.xp = s.xp;
    // Per-key sanitising rather than a wholesale spread. Spreading a stored object
    // straight in is what would turn a save written before an ability existed into
    // `undefined`, and every formula downstream into NaN.
    this.abilities = sanitizeScores(s.abilities).scores;
    this.skills = s.skills ? { ...s.skills } : {};
    this.gold = Math.max(0, Math.round(s.gold ?? 0));
    this.syncSkills();
    this.unspent = s.unspent;
    this.slotsUsed = [...s.slotsUsed];
    // Never restore into a dead-but-walking state: a save taken at 0 HP would
    // otherwise load a player who cannot be healed and cannot die again.
    this.hp = Math.max(1, Math.min(s.hp, this.maxHp));
    this.stamina = this.maxStamina;
    this.mana = Math.min(s.mana ?? this.maxMana, this.maxMana);
    this.timeSinceDamage = REGEN_DELAY;
  }

  /**
   * Get the current speed multiplier from active status effects (e.g., SLOW).
   * @returns Multiplier (0.5 to 1.0, where 1 is normal speed)
   */
  getSpeedMultiplier(): number {
    return this.statusEffectManager.getSpeedMultiplier();
  }

  /**
   * Get the current armor multiplier from active status effects (e.g., SUNDER).
   * @returns Multiplier (0 to 1, where 1 is normal armor)
   */
  getArmorMultiplier(): number {
    return this.statusEffectManager.getArmorMultiplier();
  }

  /**
   * Get the stagger chance from active SHOCK effect.
   * @returns Probability (0 to 1) of stagger per second
   */
  getStaggerChance(): number {
    return this.statusEffectManager.getStaggerChance();
  }

  /**
   * Get the intensity of active BLINDNESS effect.
   * @returns Intensity (0 to 1) of blindness
   */
  getBlindnessIntensity(): number {
    return this.statusEffectManager.getBlindnessIntensity();
  }
}

export default PlayerStats;