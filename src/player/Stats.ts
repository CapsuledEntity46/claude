/**
 * Player progression: three attributes, no classes.
 *
 * Every level grants points you spend freely, so a "class" is just whatever you
 * chose to invest in. Spell slots come from Focus rather than from a class table.
 */

export interface AttributeSet {
  /** Melee damage, max health. */
  might: number;
  /** Ranged damage, move speed, stamina. */
  agility: number;
  /** Spell damage and spell slots. */
  focus: number;
}

export type AttributeKey = keyof AttributeSet;

export const ATTRIBUTE_INFO: Record<AttributeKey, { label: string; note: string }> = {
  might: { label: 'Might', note: '+6% melee damage, +3 max HP' },
  agility: { label: 'Agility', note: '+5% ranged damage, +4 stamina, faster on foot' },
  focus: { label: 'Focus', note: '+7% spell damage, more spell slots' },
};

export const POINTS_PER_LEVEL = 2;
const SPELL_SLOT_REGEN_SECONDS = 24;
/** Seconds without taking damage before health starts recovering. */
const REGEN_DELAY = 7;
const REGEN_PER_SECOND = 1.6;

/** Total XP required to reach a given level. */
export function xpToReach(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(28 * Math.pow(level - 1, 1.55));
}

export interface StatsSnapshot {
  level: number;
  xp: number;
  hp: number;
  attributes: AttributeSet;
  unspent: number;
  slotsUsed: number[];
}

export class PlayerStats {
  level = 1;
  /** Cumulative XP across the whole run. */
  xp = 0;
  hp = 20;

  attributes: AttributeSet = { might: 2, agility: 2, focus: 2 };
  unspent = 0;

  stamina = 100;
  guard = 0;

  /** Spell slots consumed, per tier (index 0 = tier 1). */
  slotsUsed = [0, 0, 0];
  private slotRegenTimer = 0;

  /** Temporary bonus armour from Stoneskin. */
  wardArmor = 0;
  wardTimer = 0;

  /** Movement penalty timer from Frost Shard and similar effects. */
  slowTimer = 0;

  /** Seconds since the player last took a hit, for out-of-combat regeneration. */
  timeSinceDamage = REGEN_DELAY;

  /** Total equipment weight, set by the Player each frame. */
  weight = 0;
  /** Max guard from the equipped shield, set by the Player each frame. */
  shieldGuard = 0;

  // ------------------------------------------------------------ derived values

  get maxHp(): number {
    return 30 + (this.level - 1) * 6 + this.attributes.might * 3;
  }

  get maxStamina(): number {
    return 100 + this.attributes.agility * 4;
  }

  get maxGuard(): number {
    return this.shieldGuard;
  }

  get meleeMultiplier(): number {
    return 1 + this.attributes.might * 0.06;
  }

  get rangedMultiplier(): number {
    return 1 + this.attributes.agility * 0.05;
  }

  get spellMultiplier(): number {
    return 1 + this.attributes.focus * 0.07;
  }

  /** Walk speed in blocks/second, before sprint. Armour weight slows you down. */
  get moveSpeed(): number {
    const base = 4.6 * (1 + this.attributes.agility * 0.012);
    const encumbered = base * Math.max(0.55, 1 - this.weight * 0.055);
    return this.slowTimer > 0 ? encumbered * 0.55 : encumbered;
  }

  /** Max spell slots per tier. Higher tiers unlock with level. */
  maxSlots(): number[] {
    const focus = this.attributes.focus;
    return [
      2 + Math.floor(focus / 2),
      this.level >= 4 ? 1 + Math.floor(focus / 4) : 0,
      this.level >= 8 ? 1 + Math.floor(focus / 7) : 0,
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
      this.slotsUsed = [0, 0, 0];
    }
    return gained;
  }

  xpIntoLevel(): { current: number; needed: number } {
    const floorXp = xpToReach(this.level);
    const ceilXp = xpToReach(this.level + 1);
    return { current: this.xp - floorXp, needed: Math.max(1, ceilXp - floorXp) };
  }

  spend(attr: AttributeKey): boolean {
    if (this.unspent <= 0) return false;
    this.unspent--;
    this.attributes[attr]++;
    // Investing in Might should feel immediate.
    if (attr === 'might') this.hp += 3;
    return true;
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

  update(dt: number, sprinting: boolean, blocking: boolean): void {
    this.timeSinceDamage += dt;

    // Slow out-of-combat healing. Without it, one bad fight at low level puts the
    // player into an unrecoverable spiral with no way back but potions.
    if (this.timeSinceDamage > REGEN_DELAY && this.hp > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + REGEN_PER_SECOND * dt);
    }

    // Stamina: drains while sprinting or holding guard, otherwise recovers.
    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - 14 * dt);
    } else if (blocking) {
      this.stamina = Math.max(0, this.stamina - 5 * dt);
    } else {
      const regen = 22 * Math.max(0.4, 1 - this.weight * 0.07);
      this.stamina = Math.min(this.maxStamina, this.stamina + regen * dt);
    }

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
      if (this.slotRegenTimer >= SPELL_SLOT_REGEN_SECONDS) {
        this.slotRegenTimer = 0;
        this.restoreSlot(1) || this.restoreSlot(2) || this.restoreSlot(3);
      }
    } else {
      this.slotRegenTimer = 0;
    }
  }

  spendStamina(amount: number): boolean {
    if (this.stamina < amount) return false;
    this.stamina -= amount;
    return true;
  }

  resetForRespawn(): void {
    this.hp = this.maxHp;
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
      attributes: { ...this.attributes },
      unspent: this.unspent,
      slotsUsed: [...this.slotsUsed],
    };
  }

  restore(s: StatsSnapshot): void {
    this.level = s.level;
    this.xp = s.xp;
    this.attributes = { ...s.attributes };
    this.unspent = s.unspent;
    this.slotsUsed = [...s.slotsUsed];
    // Never restore into a dead-but-walking state: a save taken at 0 HP would
    // otherwise load a player who cannot be healed and cannot die again.
    this.hp = Math.max(1, Math.min(s.hp, this.maxHp));
    this.stamina = this.maxStamina;
    this.timeSinceDamage = REGEN_DELAY;
  }
}
